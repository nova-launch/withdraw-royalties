export const PROGRAM = "nva24Y1vHfhCrCLcqqFLXher9uZR4JjKP4D89MHhkmA";
export const CHAIN = "solana:mainnet";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
export const FALLBACK_RPC = "https://solana-rpc.publicnode.com";
export const RPC_TIMEOUT_MS = 12_000;

export function collectionLabel(sampleName) {
  // Cached samples are NFT names, not a curated collection directory.
  return sampleName.replace(/^#\d+\s*/, "").replace(/\s*#\d+\s*$/, "").trim() || "Unnamed collection";
}

export function lamports(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("RPC returned an invalid balance.");
  return BigInt(value);
}

export function formatSol(value) {
  const n = BigInt(value);
  const fraction = (n % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${n / 1_000_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function validateRpcUrl(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error("Enter a complete RPC URL."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Use HTTPS, or HTTP on localhost.");
  }
  if (url.username || url.password) throw new Error("Use an RPC URL without HTTP username or password fields.");
  url.hash = "";
  return url.toString();
}

export function validatePolicy(policy, web3) {
  new web3.PublicKey(policy.programAuthority);
  const shares = policy.royaltyShare;
  if (!Array.isArray(shares) || shares.length < 1 || shares.length > 5 ||
      shares.some(s => !Number.isInteger(s.share) || s.share < 0 || s.share > 10_000) ||
      shares.reduce((sum, s) => sum + s.share, 0) !== 10_000) throw new Error("Invalid royalty policy.");
  for (const s of shares) new web3.PublicKey(s.address);
  return policy;
}

export function withdrawalInstruction(master, policy, payer, web3) {
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(PROGRAM),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: new web3.PublicKey(master), isSigner: false, isWritable: false },
      { pubkey: new web3.PublicKey(policy.programAuthority), isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ...policy.royaltyShare.map(s => ({ pubkey: new web3.PublicKey(s.address), isSigner: false, isWritable: true })),
    ],
    data: Uint8Array.of(183, 18, 70, 156, 148, 109, 161, 34),
  });
}

export function withdrawable(balance, rent, policy) {
  const reserve = rent > 890_880n ? rent : 890_880n;
  const surplus = balance > reserve ? balance - reserve : 0n;
  return policy.royaltyShare.reduce((sum, s) => sum + surplus * BigInt(s.share) / 10_000n, 0n);
}

export function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n, text = "", zeros = 0;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  while (value) { text = alphabet[Number(value % 58n)] + text; value /= 58n; }
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + text;
}

export async function watchSignature(rpc, pending, {
  onStatus = () => {}, resend = async () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, timeout = 120_000,
} = {}) {
  const deadline = now() + timeout;
  let seen = Boolean(pending.seen);
  while (now() < deadline) {
    try {
      const status = (await rpc.request("getSignatureStatuses", [[pending.signature], { searchTransactionHistory: true }], { attempts: 1 }))?.value?.[0];
      if (status) {
        seen = true;
        pending.seen = true;
        if (status.confirmationStatus === "finalized" || status.confirmations === null) return status.err
          ? { state: "failed", message: `Transaction failed: ${JSON.stringify(status.err)}` }
          : { state: "finalized", message: "Withdrawal finalized." };
        onStatus(status.err ? "Transaction reported an error. Waiting for finalization…" : status.confirmationStatus === "confirmed" ? "Confirmed. Waiting for finalization…" : "Processed. Waiting for confirmation…");
      } else if (!seen) {
        // A confirmed transaction must not be declared expired while finalization catches up.
        if (Number.isSafeInteger(pending.lastValidBlockHeight)) {
          const height = await rpc.request("getBlockHeight", [{ commitment: "finalized" }], { attempts: 1 });
          if (Number.isSafeInteger(height) && height > pending.lastValidBlockHeight) {
            const again = (await rpc.request("getSignatureStatuses", [[pending.signature], { searchTransactionHistory: true }], { attempts: 1 }))?.value?.[0];
            if (!again) return { state: "unknown", message: "Blockhash expired; this RPC has no transaction status. Check the transaction before trying again." };
            seen = true;
            pending.seen = true;
            if (again.confirmationStatus === "finalized" || again.confirmations === null) return again.err
              ? { state: "failed", message: `Transaction failed: ${JSON.stringify(again.err)}` }
              : { state: "finalized", message: "Withdrawal finalized." };
            onStatus("Transaction seen on-chain. Waiting for finalization…");
            await sleep(2_500);
            continue;
          }
        }
        await resend(); // The same signed bytes, never a fresh transaction or a fresh signature.
        onStatus("Sent. Waiting for confirmation…");
      }
    } catch {
      onStatus("Waiting for RPC. Your transaction link is still available.");
    }
    await sleep(2_500);
  }
  return { state: "unknown", message: seen ? "Transaction seen on-chain. Finalization is not yet verified; check status again." : "Confirmation unavailable. Check the transaction or try checking status again." };
}



export class RpcError extends Error {
  constructor(message, { retryable = false, code = null, data = null } = {}) {
    super(message);
    this.name = "RpcError";
    this.retryable = retryable;
    this.code = code;
    this.data = data;
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
            data: payload.error.data,
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
    }], { attempts: 1 }); // Recovery owns retries, preserving ambiguous outcomes.
  }

}



const standardWallets = new Set();
const listeners = new Set();
const registry = Object.freeze({
  register(...wallets) {
    wallets.forEach((wallet) => standardWallets.add(wallet));
    listeners.forEach((listener) => listener());
    return () => wallets.forEach((wallet) => standardWallets.delete(wallet));
  },
});

if (typeof window !== "undefined") {
  window.addEventListener("wallet-standard:register-wallet", ({ detail }) => {
    if (typeof detail === "function") detail(registry);
  });
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry }));
}

function injectedProvider(name) {
  if (name === "Phantom") return window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null);
  if (name === "Backpack") return window.backpack?.solana ?? (window.backpack?.isBackpack ? window.backpack : null);
  return null;
}

function injectedAdapter(name, provider, web3) {
  return {
    name,
    async connect() {
      const result = await provider.connect();
      const key = result?.publicKey ?? provider.publicKey;
      if (!key) throw new Error(`${name} returned no Solana account.`);
      return new web3.PublicKey(key.toString());
    },
    async sign(transaction) {
      const signed = await provider.signTransaction(transaction);
      if (!signed?.serialize) throw new Error(`${name} returned no signed transaction.`);
      return signed;
    },
    async disconnect() {
      await provider.disconnect?.();
    },
    subscribe(listener) {
      const changed = key => listener(key ? new web3.PublicKey(key.toString()) : null);
      const disconnected = () => listener(null);
      provider.on?.("accountChanged", changed);
      provider.on?.("disconnect", disconnected);
      return () => {
        provider.removeListener?.("accountChanged", changed);
        provider.removeListener?.("disconnect", disconnected);
      };
    },
  };
}

function standardAdapter(wallet, web3) {
  const connectFeature = wallet.features?.["standard:connect"];
  const disconnectFeature = wallet.features?.["standard:disconnect"];
  const signFeature = wallet.features?.["solana:signTransaction"];
  if (!connectFeature || !signFeature) return null;
  let account = null;
  return {
    name: wallet.name,
    async connect() {
      const result = await connectFeature.connect();
      account = result.accounts?.find(({ chains = [] }) => !chains.length || chains.includes(CHAIN))
        ?? wallet.accounts?.find(({ chains = [] }) => !chains.length || chains.includes(CHAIN));
      if (!account) throw new Error(`${wallet.name} returned no mainnet Solana account.`);
      return new web3.PublicKey(account.publicKey);
    },
    async sign(transaction) {
      if (!account) throw new Error(`Reconnect ${wallet.name}.`);
      if (Array.isArray(signFeature.supportedTransactionVersions) &&
          !signFeature.supportedTransactionVersions.includes("legacy")) {
        throw new Error(`${wallet.name} does not support legacy Solana transactions.`);
      }
      const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      const [result] = await signFeature.signTransaction({ account, chain: CHAIN, transaction: bytes });
      if (!result?.signedTransaction) throw new Error(`${wallet.name} returned no signed transaction.`);
      return web3.Transaction.from(result.signedTransaction);
    },
    async disconnect() {
      account = null;
      await disconnectFeature?.disconnect();
    },
    subscribe(listener) {
      return wallet.features?.["standard:events"]?.on("change", change => {
        if (!change.accounts) return;
        account = change.accounts.find(a => a.chains?.includes(CHAIN)) ?? null;
        listener(account ? new web3.PublicKey(account.publicKey) : null);
      }) ?? (() => {});
    },
  };
}

export function findWallet(name, web3) {
  const injected = injectedProvider(name);
  if (injected) return injectedAdapter(name, injected, web3);
  const standard = [...standardWallets].find((wallet) => wallet.name?.toLowerCase() === name.toLowerCase());
  return standard ? standardAdapter(standard, web3) : null;
}

export function onWalletRegistration(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startApp() {

const $ = id => document.getElementById(id);
const web3 = window.solanaWeb3;
let rpc = new RpcClient(DEFAULT_RPC), customRpc = false, chainChecked = false;
let wallet = null, payer = null, active = null, prepared = null;
let policies = {}, collections = [], balances = new Map(), messages = new Map(), pending = new Map();
let loadingBalances = false, balanceGeneration = 0;
let ready = false, connecting = false, walletRevision = 0, unsubscribeWallet = () => {};
const storageKey = "nova-withdrawals-pending-v1";
const short = value => `${value.slice(0, 5)}…${value.slice(-5)}`;

function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
}
function savePending() {
  try { sessionStorage.setItem(storageKey, JSON.stringify([...pending])); } catch { /* Storage is optional. */ }
}
function setMessage(master, text, error = false) {
  messages.set(master, { text, error });
  render();
}
function showRpc() {
  $("rpc-url").value = rpc.endpoint;
  $("rpc-status").textContent = `RPC: ${new URL(rpc.endpoint).host}${customRpc ? " (custom)" : rpc.endpoint === FALLBACK_RPC ? " (public fallback; default RPC unavailable)" : ""}`;
  $("rpc-fallback").hidden = customRpc || rpc.endpoint !== FALLBACK_RPC;
}
async function request(method, params, current = () => true) {
  const client = rpc;
  try {
    const result = await client.request(method, params);
    if (rpc !== client || !current()) throw new Error("RPC changed. Try again.");
    return result;
  }
  catch (error) {
    if (current() && rpc === client && !customRpc && client.endpoint === DEFAULT_RPC && (error.retryable || error.code === 403)) {
      rpc = new RpcClient(FALLBACK_RPC);
      chainChecked = false;
      showRpc();
      return rpc.request(method, params);
    }
    throw error;
  }
}

function visibleCollections() {
  const query = $("search").value.trim();
  if (Object.hasOwn(policies, query) && !collections.some(c => c.master === query)) return [{ master: query, name: "Unlisted collection" }];
  return collections.filter(c => `${c.name} ${c.sampleName}`.toLocaleLowerCase("en").includes(query.toLocaleLowerCase("en")) || c.master === query);
}

function render() {
  const focused = document.activeElement;
  const focusedMaster = focused?.closest("tr")?.dataset.master;
  const focusedAction = focused?.dataset.action;
  const fragment = document.createDocumentFragment();
  for (const collection of visibleCollections()) {
    const { master, name } = collection;
    const row = document.createElement("tr");
    row.dataset.master = master;
    const label = row.insertCell();
    const title = document.createElement("span");
    title.textContent = name;
    label.append(title);
    const address = document.createElement("span");
    address.className = "address";
    address.textContent = short(master);
    address.title = master;
    label.append(address);
    const message = messages.get(master);
    if (message || pending.has(master)) {
      const status = document.createElement("p");
      status.className = `row-status${message?.error ? " error" : ""}`;
      status.setAttribute("role", "status");
      const transaction = pending.get(master);
      status.textContent = message?.text ?? transaction?.message ?? "Saved transaction. Check its status before withdrawing again.";
      if (transaction) {
        const link = document.createElement("a");
        link.href = `https://explorer.solana.com/tx/${transaction.signature}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "View transaction";
        status.append(link);
      }
      label.append(status);
    }
    const balance = balances.get(master);
    row.insertCell().textContent = typeof balance === "bigint" ? formatSol(balance) : balance ?? "—";
    const action = row.insertCell();
    const button = document.createElement("button");
    const isPrepared = prepared?.master === master;
    const busy = active === master && !isPrepared;
    button.textContent = isPrepared ? `Review in ${wallet.name}` : busy ? "Working…" : pending.has(master) && !pending.get(master).finished ? "Check status" : "Withdraw";
    button.setAttribute("aria-label", `${button.textContent}: ${name}`);
    button.dataset.action = "withdraw";
    button.disabled = Boolean(active && !isPrepared) || connecting;
    button.setAttribute("aria-busy", String(busy));
    button.addEventListener("click", () => isPrepared ? signPrepared() : pending.has(master) ? checkPending(master) : prepare(master));
    action.append(button);
    if (!active && pending.get(master)?.unknown) {
      const retry = document.createElement("button");
      retry.textContent = "Retry withdrawal";
      retry.addEventListener("click", () => prepare(master));
      action.append(retry);
    }
    if (isPrepared) {
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        active = null; prepared = null;
        setMessage(master, pending.has(master) ? "New withdrawal cancelled. Previous transaction is still tracked." : "Cancelled. Nothing sent.");
      });
      action.append(cancel);
    }
    fragment.append(row);
  }
  $("collections").replaceChildren(fragment);
  if (focusedMaster && focusedAction) {
    $("collections").querySelector(`tr[data-master="${focusedMaster}"] [data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  }
  $("empty").hidden = visibleCollections().length !== 0;
  $("wallet-status").textContent = connecting ? "Connecting…" : payer ? `${wallet.name} · ${short(payer.toBase58())}` : "Wallet disconnected";
  for (const name of ["phantom", "backpack"]) $(name).disabled = !ready || Boolean(connecting || active || (payer && wallet.name.toLowerCase() === name));
  $("disconnect").hidden = !payer;
  $("disconnect").disabled = Boolean(active || connecting);
  for (const input of $("rpc-form").elements) input.disabled = Boolean(active);
  $("search").disabled = Boolean(active);
  $("refresh").disabled = !ready || loadingBalances || Boolean(active);
  $("refresh").setAttribute("aria-busy", String(loadingBalances));
}

async function loadBalances(onlyMaster) {
  if (loadingBalances) return;
  const generation = ++balanceGeneration;
  const routes = onlyMaster ? [{ master: onlyMaster }] : visibleCollections();
  if (!routes.length) return;
  loadingBalances = true;
  const read = (method, params) => request(method, params, () => generation === balanceGeneration);
  render();
  try {
    const rent = lamports(await read("getMinimumBalanceForRentExemption", [0, { commitment: "confirmed" }]));
    // The public fallback accepts at most ten accounts per balance request.
    for (let offset = 0; offset < routes.length; offset += 10) {
      if (generation !== balanceGeneration) return;
      const batch = routes.slice(offset, offset + 10);
      const result = await read("getMultipleAccounts", [batch.map(c => policies[c.master].programAuthority), { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
      if (!Array.isArray(result?.value) || result.value.length !== batch.length) throw new Error("RPC returned an incomplete balance batch.");
      if (generation !== balanceGeneration) return;
      batch.forEach((c, i) => {
        const account = result.value[i];
        if (account && account.owner !== web3.SystemProgram.programId.toBase58()) balances.set(c.master, "Unavailable");
        else balances.set(c.master, withdrawable(account ? lamports(account.lamports) : 0n, rent, policies[c.master]));
      });
      notice(`Loading balances… ${Math.min(offset + batch.length, routes.length)}/${routes.length}`);
      render();
    }
    notice("Balances refreshed. Amounts exclude retained rent and rounding dust.");
  } catch (error) {
    if (generation !== balanceGeneration) return;
    for (const c of routes) if (!balances.has(c.master)) balances.set(c.master, "Unavailable");
    notice(`${error.message} Balance lookup is optional; withdrawals can still be attempted.`, true);
  } finally {
    if (generation === balanceGeneration) {
      loadingBalances = false;
      render();
    }
  }
}

async function connect(name) {
  if (active || connecting) return;
  connecting = true;
  let connectionTimeout;
  try {
    const adapter = findWallet(name, web3);
    if (!adapter) throw new Error(`${name} was not detected. Install or unlock its browser extension.`);
    // Invoke connect on the user's click, before any network request.
    const connection = adapter.connect();
    render();
    const key = await Promise.race([
      connection,
      new Promise((_, reject) => { connectionTimeout = setTimeout(() => reject(new Error("Wallet did not respond. Close its pending request, then reconnect.")), 90_000); }),
    ]);
    unsubscribeWallet();
    wallet = adapter;
    payer = key;
    walletRevision++;
    unsubscribeWallet = adapter.subscribe(key => {
      walletRevision++;
      payer = key;
      if (prepared) {
        const master = prepared.master;
        prepared = null;
        active = null;
        setMessage(master, "Wallet account changed. Prepare the withdrawal again.");
      }
      notice(key ? "" : "Wallet disconnected. Connect again to withdraw.");
      render();
    });
    notice("");
  } catch (error) { notice(error.message, true); }
  finally { clearTimeout(connectionTimeout); connecting = false; }
  render();
}

async function ensureMainnet() {
  if (!chainChecked) {
    const genesis = await request("getGenesisHash", []);
    if (genesis !== MAINNET_GENESIS) throw new Error("This RPC is not Solana mainnet.");
    chainChecked = true;
  }
}

async function prepare(master) {
  if (!payer) { notice("Connect a wallet in the header first."); return; }
  if (active) return;
  balanceGeneration++;
  loadingBalances = false;
  active = master;
  const revision = walletRevision;
  const feePayer = payer;
  setMessage(master, "Preparing withdrawal…");
  try {
    await ensureMainnet();
    // The compact program embeds these exact policies. Its old master accounts are closed.
    if (!Object.hasOwn(policies, master)) throw new Error("Unknown collection address.");
    const policy = validatePolicy(policies[master], web3);
    const { value } = await request("getLatestBlockhash", [{ commitment: "confirmed" }]);
    if (!value?.blockhash || !Number.isSafeInteger(value.lastValidBlockHeight)) throw new Error("RPC returned an invalid blockhash.");
    if (revision !== walletRevision) throw new Error("Wallet account changed. Prepare the withdrawal again.");
    const transaction = new web3.Transaction({ feePayer, recentBlockhash: value.blockhash });
    transaction.add(
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
      web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      withdrawalInstruction(master, policy, feePayer, web3),
    );
    prepared = { master, transaction, walletRevision: revision, blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight, createdAt: Date.now() };
    setMessage(master, "Ready. Review the withdrawal in your wallet.");
  } catch (error) { active = null; setMessage(master, error.message, true); }
}

async function signPrepared() {
  const item = prepared;
  if (!item) return;
  if (Date.now() - item.createdAt > 30_000) {
    prepared = null;
    active = null;
    await prepare(item.master);
    setMessage(item.master, prepared ? "Refreshed blockhash. Click Review again." : messages.get(item.master)?.text, !prepared);
    return;
  }
  prepared = null;
  let approvalTimeout;
  try {
    // This call stays directly in the click handler so the extension can open.
    const signing = wallet.sign(item.transaction);
    setMessage(item.master, "Waiting for wallet approval…");
    const signed = await Promise.race([
      signing,
      new Promise((_, reject) => {
        approvalTimeout = setTimeout(() => reject(new Error("Wallet did not respond. Close its pending request, then try again.")), 90_000);
      }),
    ]);
    clearTimeout(approvalTimeout);
    if (walletRevision !== item.walletRevision) throw new Error("Wallet account changed. Nothing sent; prepare again.");
    const bytes = signed.serialize();
    if (!signed.signature) throw new Error("Wallet returned no signature.");
    const entry = {
      signature: base58(signed.signature),
      wire: bytesToBase64(bytes),
      lastValidBlockHeight: signed.recentBlockhash === item.blockhash ? item.lastValidBlockHeight : undefined,
    };
    pending.set(item.master, entry);
    savePending(); // Save the signature before broadcasting; an HTTP timeout is ambiguous.
    setMessage(item.master, "Sending transaction…");
    try { await rpc.sendTransaction(bytes); }
    catch (error) {
      // Only a definite first preflight rejection can finish without reconciliation.
      // AlreadyProcessed, AccountInUse and lost responses remain ambiguous.
      if (error.code === -32602 || (error.code === -32002 &&
          (error.data?.err?.InstructionError || error.data?.err?.InsufficientFundsForRent))) {
        if (error.data?.err?.InsufficientFundsForRent) error.message = "Withdrawal cannot meet Solana's account rent minimum. More royalties may be needed. Nothing sent.";
        entry.finished = true;
        entry.message = error.message;
        savePending();
        throw error;
      }
      // An HTTP timeout or lost response cannot prove that the transaction failed.
    }
    await reconcile(item.master, () => rpc.sendTransaction(bytes));
  } catch (error) { setMessage(item.master, error.message || "Wallet request failed.", true); }
  finally { clearTimeout(approvalTimeout); active = null; render(); }
}

async function reconcile(master, resend) {
  const entry = pending.get(master);
  const result = await watchSignature(rpc, entry, {
    resend,
    onStatus: text => { savePending(); setMessage(master, text); },
  });
  entry.unknown = result.state === "unknown";
  entry.message = result.message;
  savePending();
  setMessage(master, result.message, result.state !== "finalized");
  if (result.state === "finalized" || result.state === "failed") {
    // Preserve the explorer link in this tab, but let the user withdraw future deposits.
    entry.finished = true;
    savePending();
    if (result.state === "finalized") void loadBalances(master);
  }
}

async function checkPending(master) {
  if (active) return;
  const entry = pending.get(master);
  if (entry.finished) {
    await prepare(master);
    return;
  }
  balanceGeneration++;
  loadingBalances = false;
  active = master;
  setMessage(master, "Checking saved transaction…");
  try {
    await ensureMainnet();
    const resend = entry.wire ? () => rpc.sendTransaction(Uint8Array.from(atob(entry.wire), c => c.charCodeAt(0))) : undefined;
    await reconcile(master, resend);
  }
  catch (error) { setMessage(master, error.message, true); }
  finally { active = null; render(); }
}

function changeRpc(endpoint, custom) {
  balanceGeneration++;
  loadingBalances = false;
  rpc = new RpcClient(endpoint);
  customRpc = custom;
  chainChecked = false;
  balances.clear();
  showRpc();
  notice("RPC changed. Load balances when needed.");
  render();
}

$("phantom").addEventListener("click", () => connect("Phantom"));
$("backpack").addEventListener("click", () => connect("Backpack"));
$("disconnect").addEventListener("click", async () => {
  const previous = wallet;
  unsubscribeWallet();
  walletRevision++;
  wallet = null; payer = null; render();
  try { await previous?.disconnect(); } catch { /* Local state is already disconnected. */ }
});
$("refresh").addEventListener("click", () => loadBalances());
$("search").addEventListener("input", render);
$("rpc-form").addEventListener("submit", event => {
  event.preventDefault();
  try { changeRpc(validateRpcUrl($("rpc-url").value), true); $("rpc-settings").open = false; }
  catch (error) { notice(error.message, true); }
});
$("rpc-reset").addEventListener("click", () => changeRpc(DEFAULT_RPC, false));
onWalletRegistration(render);

async function start() {
  if (!web3) throw new Error("The local Solana library did not load. Reload this page.");
  const policyResponse = await fetch("catalog.json");
  if (!policyResponse.ok) throw new Error("Collections did not load. Reload this page.");
  const data = await policyResponse.json();
  if (data.program !== PROGRAM || !data.policies) throw new Error("Incorrect policy file.");
  policies = data.policies;
  collections = data.collections.map(c => ({ ...c, sampleName: c.name, name: collectionLabel(c.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  try {
    for (const [master, entry] of JSON.parse(sessionStorage.getItem(storageKey) ?? "[]")) {
      if (Object.hasOwn(policies, master) && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(entry.signature)) pending.set(master, entry);
    }
  } catch { /* Storage is optional, and old or malformed entries are ignored. */ }
  const initial = new URLSearchParams(location.search).get("account");
  if (initial) $("search").value = initial;
  notice("");
  ready = true;
  showRpc();
  render();
}
render();
start().catch(error => notice(error.message, true));

}
if (typeof document !== 'undefined') startApp();
