import { RPC_TIMEOUT_MS } from "./config.js";


export class RpcError extends Error {
  constructor(message, { retryable = false, code = null } = {}) {
    super(message);
    this.name = "RpcError";
    this.retryable = retryable;
    this.code = code;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryableCode(code) {
  return [-32016, -32005, -32004].includes(code);
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}

export class RpcClient {
  constructor(endpoint, fetcher = globalThis.fetch) {
    this.endpoint = endpoint;
    this.fetcher = fetcher;
    this.nextId = 1;
  }

  async request(method, params, { attempts = 3 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
      try {
        const response = await this.fetcher.call(globalThis, this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new RpcError(`RPC returned HTTP ${response.status}.`, {
            retryable: response.status === 429 || response.status >= 500,
            code: response.status,
          });
        }
        const payload = await response.json();
        if (payload.error) {
          const code = payload.error.code ?? null;
          throw new RpcError(`RPC error ${code ?? "unknown"}: ${payload.error.message ?? "request failed"}.`, {
            retryable: retryableCode(code),
            code,
          });
        }
        if (!Object.hasOwn(payload, "result")) throw new RpcError("RPC returned no result.");
        return payload.result;
      } catch (error) {
        lastError = error instanceof RpcError
          ? error
          : new RpcError(error.name === "AbortError" ? "RPC request timed out." : "RPC is unreachable or blocks browser requests.", { retryable: true });
        if (!lastError.retryable || attempt === attempts) throw lastError;
        await sleep(Math.min(400 * 2 ** (attempt - 1), 2_000));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  sendTransaction(bytes) {
    return this.request("sendTransaction", [bytesToBase64(bytes), {
      encoding: "base64",
      maxRetries: 20,
      preflightCommitment: "confirmed",
      skipPreflight: false,
    }], { attempts: 2 });
  }

}
