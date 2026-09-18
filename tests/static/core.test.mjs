import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { decodeMaster, resolvePolicy, validatePolicy, withdrawalInstruction, withdrawable, lamports, formatSol, validateRpcUrl, watchSignature } from "../../docs/core.js";
import { PROGRAM } from "../../docs/config.js";
import { RpcClient } from "../../docs/rpc.js";

const vendor = readFileSync(new URL("../../docs/vendor/solana-web3-1.98.4.min.js", import.meta.url), "utf8");
const web3 = vm.runInThisContext(vendor + ";solanaWeb3;");
const data = JSON.parse(readFileSync(new URL("../../docs/policies.json", import.meta.url)));
const { policies } = data;
const [master, policy] = Object.entries(policies)[0];
const payer = web3.Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

function masterBytes(p) {
  const bytes = new Uint8Array(533);
  bytes.set(createHash("sha256").update("account:MasterAccount").digest().subarray(0, 8));
  bytes.set(new web3.PublicKey(p.programAuthority).toBytes(), 72);
  const view = new DataView(bytes.buffer);
  view.setUint32(105, 0, true); // No sale-revenue shares in this fixture.
  view.setUint32(109, p.royaltyShare.length, true);
  p.royaltyShare.forEach((s, i) => {
    bytes.set(new web3.PublicKey(s.address).toBytes(), 113 + i * 34);
    view.setUint16(145 + i * 34, s.share, true);
  });
  return bytes;
}

test("vendored asset and data coverage", () => {
  assert.equal(createHash("sha256").update(vendor).digest("hex"), "09cdbea951b2ed0e11bcbe3aeb1ee9f035f9fb51ed212aca645475ae82688cc3");
  assert.equal(data.program, PROGRAM);
  assert.equal(Object.keys(policies).length, 3209);
  const collections = JSON.parse(readFileSync(new URL("../../docs/collections.json", import.meta.url)));
  assert.equal(collections.length, 136);
  for (const row of collections) assert.ok(policies[row.master]);
});

test("all 3209 routes derive correctly and retain exact ABI, ordering and shares", () => {
  for (const [address, p] of Object.entries(policies)) {
    validatePolicy(p, web3);
    const [pda] = web3.PublicKey.findProgramAddressSync([new TextEncoder().encode("Nova"), new web3.PublicKey(address).toBytes()], new web3.PublicKey(PROGRAM));
    assert.equal(pda.toBase58(), p.programAuthority);
    assert.deepEqual(decodeMaster(masterBytes(p), web3), p);
    const instruction = withdrawalInstruction(address, p, payer.publicKey, web3);
    assert.deepEqual([...instruction.data], [...createHash("sha256").update("global:withdraw").digest().subarray(0, 8)]);
    assert.deepEqual(instruction.keys.map(k => k.pubkey.toBase58()), [payer.publicKey.toBase58(), address, p.programAuthority, web3.SystemProgram.programId.toBase58(), ...p.royaltyShare.map(s => s.address)]);
    const tx = new web3.Transaction({ feePayer: payer.publicKey, recentBlockhash: payer.publicKey.toBase58() }).add(instruction);
    assert.ok(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length < 1232);
  }
});

test("live policy wins; explicit absence alone permits snapshot fallback", async () => {
  const live = { ...policy, royaltyShare: [{ address: payer.publicKey.toBase58(), share: 10_000 }] };
  const rpc = { request: async () => ({ value: { owner: PROGRAM, data: [Buffer.from(masterBytes(live)).toString("base64"), "base64"] } }) };
  assert.deepEqual(await resolvePolicy(master, policies, rpc, web3), live);
  rpc.request = async () => ({ value: null });
  assert.deepEqual(await resolvePolicy(master, policies, rpc, web3), policy);
  await assert.rejects(resolvePolicy(payer.publicKey.toBase58(), policies, rpc, web3), /No saved/);
  rpc.request = async () => { throw new Error("429"); };
  await assert.rejects(resolvePolicy(master, policies, rpc, web3), /429/);
  rpc.request = async () => ({});
  await assert.rejects(resolvePolicy(master, policies, rpc, web3), /no account result/);
  rpc.request = async () => ({ value: { owner: "wrong", data: ["", "base64"] } });
  await assert.rejects(resolvePolicy(master, policies, rpc, web3), /Unexpected/);
});

test("malformed master and shares fail closed", () => {
  assert.throws(() => decodeMaster(new Uint8Array(533), web3), /Not a Nova/);
  assert.throws(() => decodeMaster(masterBytes(policy).subarray(0, 115), web3), /Invalid master/);
  assert.throws(() => validatePolicy({ ...policy, royaltyShare: [{ address: master, share: 0 }] }, web3), /Invalid/);
});

test("balance math preserves rent, large integer precision and per-share dust", () => {
  const split = { royaltyShare: [{ share: 770 }, { share: 9230 }] };
  assert.equal(withdrawable(890_887n, 650_240n, split), 6n);
  assert.equal(withdrawable(890_880n, 1_000_000n, split), 0n);
  assert.equal(formatSol(57_057_786_001n), "57.057786001");
  assert.throws(() => lamports(Number.MAX_SAFE_INTEGER + 1), /invalid/);
  assert.throws(() => lamports(-1), /invalid/);
});

test("RPC URL validation", () => {
  assert.equal(validateRpcUrl("https://rpc.test/?api-key=secret#x"), "https://rpc.test/?api-key=secret");
  assert.equal(validateRpcUrl("http://localhost:8899"), "http://localhost:8899/");
  for (const bad of ["javascript:alert(1)", "http://example.com", "https://user:password@rpc.test/"]) assert.throws(() => validateRpcUrl(bad));
});

async function watch(replies, entry = { signature: "test", lastValidBlockHeight: 5 }) {
  const calls = [];
  let clock = 0;
  let index = 0;
  const rpc = { request: async (method) => {
    calls.push(method);
    if (method === "getBlockHeight") return 20;
    const value = replies[Math.min(index++, replies.length - 1)];
    if (value instanceof Error) throw value;
    return { value: [value] };
  } };
  const result = await watchSignature(rpc, entry, { now: () => clock, sleep: async () => { clock += 2500; }, timeout: 10_000 });
  return { result, calls };
}
test("confirmed transactions do not expire while finalization catches up", async () => {
  const { result, calls } = await watch([{ confirmationStatus: "confirmed", err: null }, null, { confirmationStatus: "finalized", err: null }]);
  assert.equal(result.state, "finalized");
  assert.ok(!calls.includes("getBlockHeight"));
});
test("expiry reconciliation finds a late landed transaction", async () => {
  const { result, calls } = await watch([null, { confirmationStatus: "confirmed", err: null }, null, { confirmationStatus: "finalized", err: null }]);
  assert.equal(result.state, "finalized");
  assert.equal(calls.filter(c => c === "getBlockHeight").length, 1);
});
test("missing status and RPC failure stay uncertain, not falsely successful", async () => {
  assert.equal((await watch([null])).result.state, "unknown");
  assert.equal((await watch([new Error("offline")])).result.state, "unknown");
  assert.equal((await watch([{ err: { InstructionError: [0, "Custom"] } }])).result.state, "failed");
  const { calls } = await watch([null], { signature: "test" });
  assert.ok(!calls.includes("getBlockHeight"), "wallet-replaced blockhash has no trusted expiry height");
});
test("RPC never interprets missing data as account absence or retries simulation failures", async () => {
  const rpc = new RpcClient("https://rpc.test", async () => ({ ok: true, json: async () => ({}) }));
  await assert.rejects(rpc.request("x", []), /no result/);
  let count = 0;
  rpc.fetcher = async () => { count++; return { ok: true, json: async () => ({ error: { code: -32002, message: "Simulation failed" } }) }; };
  await assert.rejects(rpc.request("sendTransaction", []), /Simulation failed/);
  assert.equal(count, 1);
  rpc.fetcher = async () => ({ ok: false, status: 403 });
  await assert.rejects(rpc.request("x", []), error => error.code === 403);
});
