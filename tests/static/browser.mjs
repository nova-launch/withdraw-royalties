// Dependency-free browser QA. Every external request is mocked; no mainnet writes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../docs/", import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), "nova-static-qa-"));
const types = { ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".html": "text/html" };
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://local").pathname.replace(/^\/withdraw-royalties\//, "");
    const target = resolve(root, path || "index.html");
    if (!target.startsWith(root)) { response.writeHead(403).end(); return; }
    response.setHeader("Content-Type", types[extname(target)] ?? "text/plain");
    response.end(await readFile(target));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const child = spawn(process.env.CHROMIUM ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${artifacts}/profile`, "about:blank"], { stdio: "ignore" });
let socket;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(artifacts, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch { await sleep(100); }
  }
  assert.ok(port, "Chromium did not start");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(pages.find(p => p.type === "page").webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const waiting = new Map(), exceptions = [];
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.method === "Runtime.exceptionThrown") exceptions.push(event.params.exceptionDetails.text);
    const callback = waiting.get(event.id);
    if (callback) { waiting.delete(event.id); event.error ? callback.reject(event.error) : callback.resolve(event.result); }
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => { const key = ++id; waiting.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
  }
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100); }
    throw new Error(`Timed out: ${expression}`);
  }
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  // Prevent accidental network access even if the mock below stops matching.
  await call("Network.setBlockedURLs", { urls: ["https://*", "http://api.*"] });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.qa = { calls: [], mode: 'ok', approvals: 0, sent: [] };
    const originalFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (!String(url).startsWith('https://')) return originalFetch(url, options);
      const q = JSON.parse(options.body); qa.calls.push({ url, method:q.method });
      if (qa.mode === 'default403' && String(url).includes('mainnet-beta')) return new Response('', {status:403});
      if (qa.mode === 'all403') return new Response('', {status:403});
      if (qa.mode === 'balanceFail' && ['getMultipleAccounts','getMinimumBalanceForRentExemption'].includes(q.method)) return new Response('', {status:400});
      const w = window.solanaWeb3;
      const key = w.Keypair.fromSeed(Uint8Array.from({length:32},(_,i)=>i+1));
      let result;
      if (q.method === 'getGenesisHash') result = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
      else if (q.method === 'getAccountInfo') result = {value:null};
      else if (q.method === 'getMinimumBalanceForRentExemption') result = 650240;
      else if (q.method === 'getMultipleAccounts') result = {value:q.params[0].map(()=>({owner:w.SystemProgram.programId.toBase58(),lamports:1000000000}))};
      else if (q.method === 'getLatestBlockhash') result = {value:{blockhash:key.publicKey.toBase58(),lastValidBlockHeight:999}};
      else if (q.method === 'getBlockHeight') result = qa.mode === 'expired' ? 1000 : 10;
      else if (q.method === 'sendTransaction') {qa.sent.push(q.params[0]); result = 'mock-signature';}
      else if (q.method === 'getSignatureStatuses') result = {value:[qa.mode === 'expired' ? null : {confirmationStatus:'finalized',confirmations:null,err:null}]};
      else throw Error('Unexpected RPC method: '+q.method);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}), {headers:{'Content-Type':'application/json'}});
    };
    window.phantom = {solana:{
      async connect(){return {publicKey:window.solanaWeb3.Keypair.fromSeed(Uint8Array.from({length:32},(_,i)=>i+1)).publicKey}},
      async signTransaction(tx){
        qa.approvals++;
        if (qa.mode === 'reject') throw Error('User rejected the request.');
        if (qa.mode === 'walletEdits') {
          tx.instructions[1] = window.solanaWeb3.ComputeBudgetProgram.setComputeUnitPrice({microLamports:2000});
          tx.recentBlockhash = window.solanaWeb3.Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
        }
        tx.partialSign(window.solanaWeb3.Keypair.fromSeed(Uint8Array.from({length:32},(_,i)=>i+1)));
        return tx;
      }, async disconnect(){}
    }};
  ` });
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/withdraw-royalties/` });
  await until("document.querySelectorAll('#collections tr').length === 136");
  assert.equal(await evaluate("qa.calls.length"), 0, "balances are optional; startup makes no RPC calls");
  await evaluate("document.getElementById('phantom').click()");
  await until("document.getElementById('wallet-status').textContent.includes('Phantom')");
  await evaluate("qa.mode='balanceFail'; document.getElementById('refresh').click()");
  await until("document.getElementById('notice').textContent.includes('optional') && !document.getElementById('refresh').disabled");
  assert.equal(await evaluate("document.querySelector('#collections button').disabled"), false);
  await evaluate("qa.mode='default403'; document.getElementById('refresh').click()");
  await until("document.getElementById('notice').textContent.startsWith('Balances refreshed')");
  assert.ok(await evaluate("document.getElementById('rpc-status').textContent.includes('fallback')"));
  assert.equal(await evaluate("document.querySelector('#collections tr td:nth-child(2)').textContent"), "0.99910912 SOL");
  await evaluate("qa.mode='reject'; document.querySelector('#collections button').click()");
  await until("document.querySelector('#collections button').textContent.includes('Review in')");
  await evaluate("document.querySelector('#collections button').click()");
  await until("document.querySelector('#collections tr').textContent.includes('rejected')");
  assert.equal(await evaluate("qa.sent.length"), 0);
  await evaluate("qa.mode='walletEdits'; document.querySelector('#collections button').click()");
  await until("document.querySelector('#collections button').textContent.includes('Review in')");
  await evaluate("document.querySelector('#collections button').click()");
  await until("document.querySelector('#collections tr').textContent.includes('Withdrawal finalized')");
  assert.equal(await evaluate("qa.sent.length"), 1);
  assert.ok(await evaluate("JSON.parse(sessionStorage.getItem('nova-withdrawals-pending-v1'))[0][1].lastValidBlockHeight === undefined"), "wallet-mutated blockhash must not inherit the prepared expiry height");
  assert.ok(await evaluate("!!document.querySelector('#collections a[href^=\"https://explorer.solana.com/tx/\"]')"));
  await evaluate("qa.mode='expired'; document.querySelectorAll('#collections tr')[1].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[1].querySelector('button').textContent.includes('Review in')");
  await evaluate("document.querySelectorAll('#collections tr')[1].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[1].textContent.includes('Blockhash expired')");
  assert.ok(await evaluate("document.querySelectorAll('#collections tr')[1].textContent.includes('Retry withdrawal')"));
  const storedCount = await evaluate("JSON.parse(sessionStorage.getItem('nova-withdrawals-pending-v1')).length");
  assert.equal(storedCount, 2);
  await call("Page.reload");
  await until("document.querySelectorAll('#collections tr').length === 136");
  assert.equal(await evaluate("document.querySelectorAll('#collections a').length"), 2, "saved signatures survive reload");
  // Exact master lookup reaches policies without an indexed name.
  await evaluate(`(async()=>{const p=await (await fetch('policies.json')).json();const c=await (await fetch('collections.json')).json();const master=Object.keys(p.policies).find(k=>!c.some(c=>c.master===k));document.getElementById('search').value=master;document.getElementById('search').dispatchEvent(new Event('input'));})()`);
  assert.equal(await evaluate("document.querySelectorAll('#collections tr').length"), 1);
  assert.ok(await evaluate("document.querySelector('#collections tr').textContent.includes('Unlisted')"));
  await evaluate("document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input'))");
  await evaluate("qa.mode='all403';qa.calls=[];document.getElementById('rpc-url').value='https://custom.test/?api-key=private';document.getElementById('rpc-form').dispatchEvent(new Event('submit',{cancelable:true}));document.getElementById('refresh').click()");
  await until("document.getElementById('notice').textContent.includes('HTTP 403')");
  assert.ok(await evaluate("qa.calls.every(c=>c.url.startsWith('https://custom.test/'))"), "custom RPC is never silently replaced");
  assert.ok(await evaluate("!document.getElementById('rpc-status').textContent.includes('private')"), "endpoint key is not shown in the page status");
  await evaluate("document.getElementById('rpc-reset').click()");
  for (const [name, width, height] of [["desktop",1280,900],["mobile",390,844]]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor:1, mobile:false });
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), `${name}: horizontal overflow`);
    const screenshot = await call("Page.captureScreenshot", { format:"png" });
    await writeFile(join(artifacts, `${name}.png`), Buffer.from(screenshot.data, "base64"));
  }
  assert.deepEqual(exceptions, []);
  console.log(`Browser QA passed: optional balances, RPC failure/fallback, rejection, wallet edits, finalization, expiry, saved signatures, all-policy lookup, project path and desktop/mobile layout. Screenshots: ${artifacts}`);
} finally {
  socket?.close();
  child.kill("SIGTERM");
  server.closeAllConnections();
  server.close();
}
