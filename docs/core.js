import { PROGRAM } from "./config.js";

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

// Anchor MasterAccount Borsh layout, without an Anchor runtime dependency.
export function decodeMaster(data, web3) {
  const discriminator = [30, 179, 10, 149, 99, 235, 125, 34];
  if (data.length < 109 || discriminator.some((n, i) => data[i] !== n)) throw new Error("Not a Nova master account.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 105;
  function shares() {
    if (offset + 4 > data.length) throw new Error("Truncated master account.");
    const count = view.getUint32(offset, true);
    offset += 4;
    if (count > 5 || offset + count * 34 > data.length) throw new Error("Invalid master shares.");
    const result = [];
    for (let i = 0; i < count; i++, offset += 34) result.push({
      address: new web3.PublicKey(data.subarray(offset, offset + 32)).toBase58(),
      share: view.getUint16(offset + 32, true),
    });
    return result;
  }
  shares(); // Sale revenue is not part of royalty withdrawals.
  return validatePolicy({
    programAuthority: new web3.PublicKey(data.subarray(72, 104)).toBase58(),
    royaltyShare: shares(),
  }, web3);
}

export async function resolvePolicy(master, policies, rpc, web3) {
  const result = await rpc.request("getAccountInfo", [master, { encoding: "base64", commitment: "confirmed" }]);
  if (!result || !("value" in result)) throw new Error("RPC returned no account result.");
  // Only an explicit null means absence. Timeouts and malformed replies never use the snapshot.
  if (result.value === null) {
    if (!Object.hasOwn(policies, master)) throw new Error("No saved payout policy for this master.");
    return validatePolicy(policies[master], web3);
  }
  if (result.value.owner !== PROGRAM || result.value.data?.[1] !== "base64") throw new Error("Unexpected master account owner or encoding.");
  const data = Uint8Array.from(atob(result.value.data[0]), c => c.charCodeAt(0));
  return decodeMaster(data, web3);
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
        if (status.err) return { state: "failed", message: `Transaction failed: ${JSON.stringify(status.err)}` };
        if (status.confirmationStatus === "finalized" || status.confirmations === null) return { state: "finalized", message: "Withdrawal finalized." };
        onStatus(status.confirmationStatus === "confirmed" ? "Confirmed. Waiting for finalization…" : "Processed. Waiting for confirmation…");
      } else if (!seen) {
        // A confirmed transaction must not be declared expired while finalization catches up.
        if (Number.isSafeInteger(pending.lastValidBlockHeight)) {
          const height = await rpc.request("getBlockHeight", [{ commitment: "finalized" }], { attempts: 1 });
          if (Number.isSafeInteger(height) && height > pending.lastValidBlockHeight) {
            const again = (await rpc.request("getSignatureStatuses", [[pending.signature], { searchTransactionHistory: true }], { attempts: 1 }))?.value?.[0];
            if (!again) return { state: "unknown", message: "Blockhash expired; this RPC has no transaction status. Check the transaction before trying again." };
            seen = true;
            pending.seen = true;
            if (again.err) return { state: "failed", message: `Transaction failed: ${JSON.stringify(again.err)}` };
            if (again.confirmationStatus === "finalized" || again.confirmations === null) return { state: "finalized", message: "Withdrawal finalized." };
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
