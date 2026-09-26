// Dependency-free browser QA. Every external request is mocked; no mainnet writes.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { siteServer } from "../../scripts/serve.mjs";

const artifacts = await mkdtemp(join(tmpdir(), "nova-static-qa-"));
const server = siteServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
for (const path of ['/.git/config', '/package.json', '/scripts/serve.mjs']) {
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${path}`)).status,404);
}
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
  const waiting = new Map(), exceptions = [], staticRequests = [];
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.method === "Runtime.exceptionThrown") exceptions.push(event.params.exceptionDetails.text);
    if (event.method === "Network.requestWillBeSent" && event.params.request.url.startsWith(`http://127.0.0.1:${server.address().port}/`)) staticRequests.push(event.params.request.url);
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
    window.qa = { calls: [], mode: 'ok', approvals: 0, sent: [], events: {}, walletApprovals: [] };
    const originalFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (!String(url).startsWith('https://')) return originalFetch(url, options);
      const q = JSON.parse(options.body); qa.calls.push({ url, method:q.method });
      if (qa.mode === 'default403' && String(url).includes('mainnet-beta')) return new Response('', {status:403});
      if (qa.mode === 'all403') return new Response('', {status:403});
      if (q.method==='getMultipleAccounts' && q.params[0].length>10) return new Response(JSON.stringify({error:{code:-32602,message:'Request blocked'}}),{status:403});
      if (qa.mode === 'balanceFail' && ['getMultipleAccounts','getMinimumBalanceForRentExemption'].includes(q.method)) return new Response('', {status:400});
      if (qa.mode === 'holdBalance' && q.method==='getMinimumBalanceForRentExemption') {await new Promise(resolve=>qa.releaseBalance=resolve);return new Response('',{status:403});}
      const w = window.solanaWeb3;
      const key = w.Keypair.fromSeed(Uint8Array.from({length:32},(_,i)=>i+1));
      let result;
      if (q.method === 'getGenesisHash') result = qa.mode === 'wrongChain' ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1' : '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
      else if (q.method === 'getAccountInfo') result = {value:null};
      else if (q.method === 'getMinimumBalanceForRentExemption') result = 650240;
      else if (q.method === 'getMultipleAccounts') result = {value:q.params[0].map(()=>({owner:w.SystemProgram.programId.toBase58(),lamports:1000000000}))};
      else if (q.method === 'getLatestBlockhash') result = {value:{blockhash:key.publicKey.toBase58(),lastValidBlockHeight:999}};
      else if (q.method === 'getBlockHeight') result = qa.mode === 'expired' ? 1000 : 10;
      else if (q.method === 'sendTransaction') {
        qa.sent.push(q.params[0]);
        if(qa.mode === 'preflightFail') return new Response(JSON.stringify({error:{code:-32002,message:'Simulation failed',data:{err:{InstructionError:[2,'Custom']}}}}));
        if(qa.mode === 'rentFail') return new Response(JSON.stringify({error:{code:-32002,message:'Simulation failed',data:{err:{InsufficientFundsForRent:{account_index:3}}}}}));
        if(qa.mode === 'lostSend') {qa.mode='alreadyProcessed';throw new TypeError('Response lost');}
        if(qa.mode === 'alreadyProcessed') return new Response(JSON.stringify({error:{code:-32002,message:'AlreadyProcessed',data:{err:'AlreadyProcessed'}}}));
        result = 'mock-signature';
      }
      else if (q.method === 'getSignatureStatuses') {
        if(qa.mode === 'alreadyProcessed' && !qa.queriedLost) {qa.queriedLost=true;result={value:[null]};}
        else if(qa.mode === 'resumeSaved' && qa.sent.length===0) result={value:[null]};
        else result = {value:[qa.mode === 'expired' ? null : {confirmationStatus:'finalized',confirmations:null,err:null}]};
      }
      else throw Error('Unexpected RPC method: '+q.method);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}), {headers:{'Content-Type':'application/json'}});
    };
    function provider(name) {return {
      async connect(){return {publicKey:window.solanaWeb3.Keypair.fromSeed(Uint8Array.from({length:32},(_,i)=>i+1)).publicKey}},
      async signTransaction(tx){
        qa.approvals++;
        qa.walletApprovals.push(name);
        if (qa.mode === 'reject') throw Error('User rejected the request.');
        if (qa.mode === 'holdApproval') await new Promise(resolve=>{qa.releaseApproval=resolve});
        if (qa.mode === 'walletEdits') {
          tx.instructions[1] = window.solanaWeb3.ComputeBudgetProgram.setComputeUnitPrice({microLamports:2000});
          tx.recentBlockhash = window.solanaWeb3.Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
        }
        tx.partialSign(window.solanaWeb3.Keypair.fromSeed(Uint8Array.from({length:32},(_,i)=>i+1)));
        return tx;
      }, async disconnect(){if(qa.mode==='holdDisconnect') await new Promise(resolve=>qa.releaseDisconnect=resolve)},
      on(event,listener){(qa.events[name+event]??=[]).push(listener)},
      removeListener(event,listener){qa.events[name+event]=(qa.events[name+event]??[]).filter(l=>l!==listener)}
    }}
    if(!location.search.includes('standard')) {
      window.phantom = {solana:provider('Phantom')};
      window.backpack = {solana:provider('Backpack')};
    } else {
      window.addEventListener('wallet-standard:app-ready', ({detail})=>{
        for(const name of ['Phantom','Backpack']) {
          const p=provider(name);
          let account;
          detail.register({name,chains:['solana:mainnet'],accounts:[],features:{
            'standard:connect':{async connect(){ const {publicKey}=await p.connect(); account={address:publicKey.toBase58(),publicKey:publicKey.toBytes(),chains:['solana:mainnet'],features:['solana:signTransaction']};return {accounts:[account]};}},
            'solana:signTransaction':{supportedTransactionVersions:['legacy'],async signTransaction(input){const tx=window.solanaWeb3.Transaction.from(input.transaction);const signed=await p.signTransaction(tx);return [{signedTransaction:signed.serialize()}];}},
            'standard:disconnect':{async disconnect(){}},
            'standard:events':{on(event,listener){qa.events[name+'standard']=listener;return ()=>delete qa.events[name+'standard'];}}
          }});
        }
      });
    }
  ` });
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/withdraw-royalties/` });
  await until("document.querySelectorAll('#collections tr').length === 136");
  await sleep(100);
  assert.equal(staticRequests.length, 5, `Cold load must use five requests, got ${staticRequests.join(', ')}`);
  console.log('Cold load requests:', staticRequests.map(url=>new URL(url).pathname).join(', '));
  assert.ok(await evaluate("performance.getEntriesByType('resource').every(r=>!r.name.startsWith('https:'))"));
  assert.equal(await evaluate("qa.calls.length"), 0, "balances are optional; startup makes no RPC calls");
  await evaluate("document.getElementById('phantom').click()");
  await until("document.getElementById('wallet-status').textContent.includes('Phantom')");
  await evaluate("qa.mode='balanceFail'; document.getElementById('refresh').click()");
  await until("document.getElementById('notice').textContent.includes('optional') && !document.getElementById('refresh').disabled");
  assert.equal(await evaluate("document.querySelector('#collections button').disabled"), false);
  await evaluate("qa.mode='default403'; document.getElementById('refresh').click()");
  await until("document.getElementById('notice').textContent.startsWith('Balances refreshed')");
  assert.ok(await evaluate("document.getElementById('rpc-status').textContent.includes('fallback')"));
  assert.equal(await evaluate("document.querySelector('#collections tr td:nth-child(2)').textContent"), "0.99910912");
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
  // A disconnected retry must not erase the saved signature. Resume resends the same bytes.
  const savedWire = await evaluate("JSON.parse(sessionStorage.getItem('nova-withdrawals-pending-v1'))[1][1].wire");
  await evaluate("document.querySelectorAll('#collections tr')[1].querySelectorAll('button')[1].click()");
  assert.equal(await evaluate("JSON.parse(sessionStorage.getItem('nova-withdrawals-pending-v1')).length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('#collections a').length"), 2);
  await evaluate("qa.mode='resumeSaved';document.querySelectorAll('#collections tr')[1].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[1].textContent.includes('Withdrawal finalized')");
  assert.deepEqual(await evaluate("qa.sent"), [savedWire]);
  assert.equal(await evaluate("qa.approvals"), 0, "reload recovery never requests a fresh signature");
  // Exact master lookup reaches policies without an indexed name.
  await evaluate(`(async()=>{const p=await (await fetch('catalog.json')).json();const c=p.collections;const master=Object.keys(p.policies).find(k=>!c.some(c=>c.master===k));document.getElementById('search').value=master;document.getElementById('search').dispatchEvent(new Event('input'));})()`);
  assert.equal(await evaluate("document.querySelectorAll('#collections tr').length"), 1);
  assert.ok(await evaluate("document.querySelector('#collections tr').textContent.includes('Unlisted')"));
  await evaluate("document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input'))");
  await evaluate("qa.mode='all403';qa.calls=[];document.getElementById('rpc-url').value='https://custom.test/?api-key=private';document.getElementById('rpc-form').dispatchEvent(new Event('submit',{cancelable:true}));document.getElementById('refresh').click()");
  await until("document.getElementById('notice').textContent.includes('HTTP 403')");
  assert.ok(await evaluate("qa.calls.every(c=>c.url.startsWith('https://custom.test/'))"), "custom RPC is never silently replaced");
  assert.ok(await evaluate("!document.getElementById('rpc-status').textContent.includes('private')"), "endpoint key is not shown in the page status");
  await evaluate("document.getElementById('rpc-reset').click()");
  // Backpack's injected provider uses the same withdrawal path, with a direct-click review.
  await evaluate("qa.mode='ok';document.getElementById('backpack').click()");
  await until("document.getElementById('wallet-status').textContent.includes('Backpack')");
  await evaluate("document.querySelectorAll('#collections tr')[2].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[2].textContent.includes('Review in Backpack')");
  await evaluate("document.querySelectorAll('#collections tr')[2].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[2].textContent.includes('Withdrawal finalized')");
  assert.deepEqual(await evaluate("qa.walletApprovals"), ['Backpack']);
  // External account changes cancel a prepared review, not merely the displayed wallet name.
  await evaluate("document.querySelectorAll('#collections tr')[3].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[3].textContent.includes('Review in Backpack')");
  await evaluate("qa.events.BackpackaccountChanged.forEach(f=>f(null))");
  assert.ok(await evaluate("document.getElementById('wallet-status').textContent.includes('disconnected')"));
  assert.ok(await evaluate("!document.querySelectorAll('#collections tr')[3].textContent.includes('Review in')"));
  // Wrong-chain RPC must fail before a wallet signing request.
  await evaluate("document.getElementById('phantom').click()");
  await until("document.getElementById('wallet-status').textContent.includes('Phantom')");
  await evaluate("qa.mode='wrongChain';document.getElementById('rpc-reset').click();document.querySelectorAll('#collections tr')[3].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[3].textContent.includes('not Solana mainnet')");
  assert.equal(await evaluate("qa.approvals"), 1);
  await evaluate("qa.mode='ok';document.getElementById('rpc-reset').click()");
  // Account change while approval is outstanding must not broadcast a late signed result.
  await evaluate("document.querySelectorAll('#collections tr')[3].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[3].textContent.includes('Review in')");
  await evaluate("qa.mode='holdApproval';document.querySelectorAll('#collections tr')[3].querySelector('button').click()");
  await until("typeof qa.releaseApproval==='function'");
  const sentBeforeChange = await evaluate("qa.sent.length");
  await evaluate("qa.events.PhantomaccountChanged.forEach(f=>f(null));qa.releaseApproval()");
  await until("document.querySelectorAll('#collections tr')[3].textContent.includes('Nothing sent')");
  assert.equal(await evaluate("qa.sent.length"), sentBeforeChange);
  // A late old disconnect cannot erase a new wallet connection.
  await evaluate("qa.mode='ok';document.getElementById('phantom').click()");
  await until("document.getElementById('wallet-status').textContent.includes('Phantom')");
  await evaluate("qa.mode='holdDisconnect';document.getElementById('disconnect').click()");
  await until("typeof qa.releaseDisconnect==='function'");
  assert.ok(await evaluate("document.getElementById('wallet-status').textContent.includes('disconnected')"));
  await evaluate("document.getElementById('backpack').click()");
  await until("document.getElementById('wallet-status').textContent.includes('Backpack')");
  await evaluate("qa.releaseDisconnect()");
  assert.ok(await evaluate("document.getElementById('wallet-status').textContent.includes('Backpack')"));
  for (const [mode,index,text] of [['preflightFail',6,'Simulation failed'],['rentFail',7,'account rent minimum'],['lostSend',8,'Withdrawal finalized']]) {
    await evaluate(`qa.mode='${mode}';qa.sent=[];document.querySelectorAll('#collections tr')[${index}].querySelector('button').click()`);
    await until(`document.querySelectorAll('#collections tr')[${index}].textContent.includes('Review in Backpack')`);
    await evaluate(`document.querySelectorAll('#collections tr')[${index}].querySelector('button').click()`);
    await until(`document.querySelectorAll('#collections tr')[${index}].textContent.includes('${text}')`);
    if(mode==='lostSend') {
      assert.equal(await evaluate("qa.sent.length"),2);
      assert.ok(await evaluate("qa.sent[0]===qa.sent[1]"), 'ambiguity only resends identical signed bytes');
    } else assert.equal(await evaluate("qa.sent.length"),1);
  }
  // Finalized withdrawal releases controls even when its optional balance refresh hangs.
  await evaluate("qa.mode='ok';document.querySelectorAll('#collections tr')[9].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[9].textContent.includes('Review in Backpack')");
  await evaluate("qa.mode='holdBalance';document.querySelectorAll('#collections tr')[9].querySelector('button').click()");
  await until("typeof qa.releaseBalance==='function' && !document.getElementById('disconnect').disabled");
  assert.equal(await evaluate("document.querySelectorAll('#collections tr')[10].querySelector('button').disabled"),false);
  await evaluate("document.getElementById('rpc-url').value='https://custom.test/';document.getElementById('rpc-form').dispatchEvent(new Event('submit',{cancelable:true}));qa.releaseBalance();qa.mode='ok'");
  await sleep(100);
  assert.ok(await evaluate("document.getElementById('rpc-status').textContent.includes('custom.test')"), 'a stale default-RPC failure cannot replace the chosen custom endpoint');
  // Standard-wallet-only integration, without either injected provider.
  await call("Page.navigate", {url:`http://127.0.0.1:${server.address().port}/withdraw-royalties/?standard=1`});
  await until("document.querySelectorAll('#collections tr').length === 136");
  for (const [name,index] of [['Phantom',4],['Backpack',5]]) {
    await evaluate(`document.getElementById('${name.toLowerCase()}').click()`);
    await until(`document.getElementById('wallet-status').textContent.includes('${name}')`);
    await evaluate(`document.querySelectorAll('#collections tr')[${index}].querySelector('button').click()`);
    await until(`document.querySelectorAll('#collections tr')[${index}].textContent.includes('Review in ${name}')`);
    await evaluate(`document.querySelectorAll('#collections tr')[${index}].querySelector('button').click()`);
    await until(`document.querySelectorAll('#collections tr')[${index}].textContent.includes('Withdrawal finalized')`);
  }
  assert.deepEqual(await evaluate("qa.walletApprovals"), ['Phantom','Backpack']);
  // Old prepared blockhashes refresh without opening a wallet; missing popups time out.
  await evaluate("document.querySelectorAll('#collections tr')[11].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[11].textContent.includes('Review in Backpack')");
  await evaluate("qa.originalNow=Date.now;Date.now=()=>qa.originalNow()+40000;document.querySelectorAll('#collections tr')[11].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[11].textContent.includes('Refreshed blockhash')");
  assert.equal(await evaluate("qa.approvals"),2);
  await evaluate("Date.now=qa.originalNow;document.querySelectorAll('#collections tr')[11].querySelectorAll('button')[1].click();document.querySelectorAll('#collections tr')[11].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[11].textContent.includes('Review in Backpack')");
  const beforeTimeout=await evaluate("qa.sent.length");
  await evaluate("qa.originalTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>qa.originalTimeout.call(window,fn,ms===90000?30:ms,...args);qa.mode='holdApproval';document.querySelectorAll('#collections tr')[11].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[11].textContent.includes('Wallet did not respond')");
  await evaluate("window.setTimeout=qa.originalTimeout;qa.releaseApproval();qa.mode='ok'");
  await sleep(100);
  assert.equal(await evaluate("qa.sent.length"),beforeTimeout,"late wallet results cannot broadcast after timeout");
  // Storage can be blocked without blocking a completed withdrawal.
  await evaluate("qa.oldSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error('Storage blocked')};document.querySelectorAll('#collections tr')[10].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[10].textContent.includes('Review in Backpack')");
  await evaluate("document.querySelectorAll('#collections tr')[10].querySelector('button').click()");
  await until("document.querySelectorAll('#collections tr')[10].textContent.includes('Withdrawal finalized')");
  await evaluate("Storage.prototype.setItem=qa.oldSet;sessionStorage.clear()");
  // Also serve the root path; capture the normal, uncluttered initial page.
  await call("Page.navigate", {url:`http://127.0.0.1:${server.address().port}/`});
  await until("document.querySelectorAll('#collections tr').length === 136");
  assert.equal(await evaluate("qa.calls.length"),0);
  for (const [name, width, height] of [["desktop",1280,900],["mobile",390,844],["narrow",320,700]]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor:1, mobile:false });
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), `${name}: horizontal overflow`);
    const screenshot = await call("Page.captureScreenshot", { format:"png" });
    await writeFile(join(artifacts, `${name}.png`), Buffer.from(screenshot.data, "base64"));
  }
  assert.deepEqual(exceptions, []);
  console.log(`Browser QA passed: five-request startup, optional balances, RPC races, injected/standard Phantom and Backpack, rejection, account changes, approval timeout, blockhash refresh, ambiguous-send recovery, saved signatures, storage failure, all-policy lookup, root/project paths and desktop/mobile layout. Screenshots: ${artifacts}`);
} finally {
  socket?.close();
  child.kill("SIGTERM");
  server.closeAllConnections();
  server.close();
}
