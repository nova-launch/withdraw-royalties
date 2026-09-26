import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { validatePolicy, withdrawalInstruction, withdrawable, lamports, formatSol, validateRpcUrl, watchSignature } from "../../app.js";
import { PROGRAM, MAINNET_GENESIS, collectionLabel } from "../../app.js";
import { RpcClient } from "../../app.js";

const vendor = readFileSync(new URL("../../vendor/solana-web3-1.98.4.min.js", import.meta.url), "utf8");
const web3 = vm.runInThisContext(vendor + ";solanaWeb3;");
const data = JSON.parse(readFileSync(new URL("../../catalog.json", import.meta.url)));
const { policies } = data;
const [master, policy] = Object.entries(policies)[0];
const payer = web3.Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

test("sample labels omit serials without stripping collection numbers", () => {
  assert.equal(collectionLabel("#103 Auk Solciety"), "Auk Solciety");
  assert.equal(collectionLabel("#408Space Thug"), "Space Thug");
  assert.equal(collectionLabel("4X4#918"), "4X4");
  assert.equal(collectionLabel("Kaotic Kronic | Gen 1.5 #530"), "Kaotic Kronic | Gen 1.5");
  assert.equal(collectionLabel("#1496"), "Unnamed collection");
});

test("vendored asset and data coverage", () => {
  assert.equal(MAINNET_GENESIS, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  assert.equal(new web3.PublicKey(MAINNET_GENESIS).toBytes().length, 32);
  assert.equal(createHash("sha256").update(JSON.stringify(policies)).digest("hex"), "f0d7e39b8fa788f7a39bc4b9b90c5486bd4bf2fac550a975427471ce7d7c4f44");
  assert.equal(createHash("sha256").update(vendor).digest("hex"), "09cdbea951b2ed0e11bcbe3aeb1ee9f035f9fb51ed212aca645475ae82688cc3");
  assert.equal(data.program, PROGRAM);
  assert.equal(Object.keys(policies).length, 3209);
  const collections = data.collections;
  assert.equal(collections.length, 136);
  for (const row of collections) assert.ok(policies[row.master]);
});

test("all 3209 routes derive correctly and retain exact ABI, ordering and shares", () => {
  for (const [address, p] of Object.entries(policies)) {
    validatePolicy(p, web3);
    const [pda] = web3.PublicKey.findProgramAddressSync([new TextEncoder().encode("Nova"), new web3.PublicKey(address).toBytes()], new web3.PublicKey(PROGRAM));
    assert.equal(pda.toBase58(), p.programAuthority);
    const instruction = withdrawalInstruction(address, p, payer.publicKey, web3);
    assert.deepEqual([...instruction.data], [...createHash("sha256").update("global:withdraw").digest().subarray(0, 8)]);
    assert.deepEqual(instruction.keys.map(k => k.pubkey.toBase58()), [payer.publicKey.toBase58(), address, p.programAuthority, web3.SystemProgram.programId.toBase58(), ...p.royaltyShare.map(s => s.address)]);
    const tx = new web3.Transaction({ feePayer: payer.publicKey, recentBlockhash: payer.publicKey.toBase58() }).add(instruction);
    assert.ok(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length < 1232);
  }
});

test("malformed shares fail closed", () => {
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
  assert.equal((await watch([{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }])).result.state, "failed");
  const { calls } = await watch([null], { signature: "test" });
  assert.ok(!calls.includes("getBlockHeight"), "wallet-replaced blockhash has no trusted expiry height");
});
test("unfinalized errors cannot terminate tracking on a fork", async () => {
  assert.equal((await watch([{confirmationStatus:"processed",err:{InstructionError:[0,"Custom"]}}, {confirmationStatus:"finalized",err:null}])).result.state, "finalized");
  assert.equal((await watch([null, {confirmationStatus:"processed",err:{InstructionError:[0,"Custom"]}}, {confirmationStatus:"finalized",err:null}])).result.state, "finalized");
});
test("a send makes only one attempt; recovery owns any resend", async () => {
  let count=0;
  const rpc=new RpcClient("https://rpc.test", async()=> {count++; throw new TypeError("Lost reply");});
  await assert.rejects(rpc.sendTransaction(new Uint8Array(1)), /unreachable/);
  assert.equal(count,1);
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
