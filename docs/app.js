import { PROGRAM, MAINNET_GENESIS, DEFAULT_RPC, FALLBACK_RPC } from "./config.js";
import { RpcClient } from "./rpc.js";
import { findWallet, onWalletRegistration } from "./wallets.js";
import { lamports, formatSol, validateRpcUrl, resolvePolicy, withdrawalInstruction, withdrawable, base58, watchSignature } from "./core.js";

const $ = id => document.getElementById(id);
const web3 = window.solanaWeb3;
let rpc = new RpcClient(DEFAULT_RPC), customRpc = false, chainChecked = false;
let wallet = null, payer = null, active = null, prepared = null;
let policies = {}, collections = [], balances = new Map(), messages = new Map(), pending = new Map();
let loadingBalances = false, balanceGeneration = 0;
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
}
async function request(method, params) {
  try { return await rpc.request(method, params); }
  catch (error) {
    if (!customRpc && rpc.endpoint === DEFAULT_RPC && (error.retryable || error.code === 403)) {
      rpc = new RpcClient(FALLBACK_RPC);
      chainChecked = false;
      showRpc();
      return rpc.request(method, params);
    }
    throw error;
  }
}
const currentRpc = { request };

function visibleCollections() {
  const query = $("search").value.trim();
  if (Object.hasOwn(policies, query) && !collections.some(c => c.master === query)) return [{ master: query, name: "Unlisted collection" }];
  return collections.filter(c => c.name.toLocaleLowerCase("en").includes(query.toLocaleLowerCase("en")) || c.master === query);
}

function render() {
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
    row.insertCell().textContent = typeof balance === "bigint" ? `${formatSol(balance)} SOL` : balance ?? "Not loaded";
    const action = row.insertCell();
    const button = document.createElement("button");
    const isPrepared = prepared?.master === master;
    const busy = active === master && !isPrepared;
    button.textContent = isPrepared ? `Review in ${wallet.name}` : busy ? "Working…" : pending.has(master) && !pending.get(master).finished ? "Check status" : "Withdraw";
    button.disabled = Boolean(active && !isPrepared);
    button.setAttribute("aria-busy", String(busy));
    button.addEventListener("click", () => isPrepared ? signPrepared() : pending.has(master) ? checkPending(master) : prepare(master));
    action.append(button);
    if (!active && pending.get(master)?.unknown) {
      const retry = document.createElement("button");
      retry.textContent = "Retry withdrawal";
      retry.addEventListener("click", () => {
        pending.delete(master);
        savePending();
        prepare(master);
      });
      action.append(retry);
    }
    if (isPrepared) {
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => { active = null; prepared = null; setMessage(master, "Cancelled. Nothing sent."); });
      action.append(cancel);
    }
    fragment.append(row);
  }
  $("collections").replaceChildren(fragment);
  $("empty").hidden = visibleCollections().length !== 0;
  $("wallet-status").textContent = payer ? `${wallet.name} · ${short(payer.toBase58())}` : "Wallet disconnected";
  for (const name of ["phantom", "backpack"]) $(name).disabled = Boolean(active || (payer && wallet.name.toLowerCase() === name));
  $("disconnect").hidden = !payer;
  $("disconnect").disabled = Boolean(active);
  for (const input of $("rpc-form").elements) input.disabled = Boolean(active);
  $("search").disabled = Boolean(active);
  $("refresh").disabled = loadingBalances || Boolean(active);
  $("refresh").setAttribute("aria-busy", String(loadingBalances));
}

async function loadBalances(onlyMaster) {
  if (loadingBalances) return;
  const generation = ++balanceGeneration;
  const routes = onlyMaster ? [{ master: onlyMaster }] : visibleCollections();
  if (!routes.length) return;
  loadingBalances = true;
  render();
  try {
    const rent = lamports(await request("getMinimumBalanceForRentExemption", [0, { commitment: "confirmed" }]));
    for (let offset = 0; offset < routes.length; offset += 40) {
      if (generation !== balanceGeneration) return;
      const batch = routes.slice(offset, offset + 40);
      const result = await request("getMultipleAccounts", [batch.map(c => policies[c.master].programAuthority), { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
      if (!Array.isArray(result?.value) || result.value.length !== batch.length) throw new Error("RPC returned an incomplete balance batch.");
      if (generation !== balanceGeneration) return;
      batch.forEach((c, i) => {
        const account = result.value[i];
        if (account && account.owner !== web3.SystemProgram.programId.toBase58()) balances.set(c.master, "Unavailable");
        else balances.set(c.master, withdrawable(account ? lamports(account.lamports) : 0n, rent, policies[c.master]));
      });
      render();
    }
    notice("Balances refreshed. Amounts exclude retained rent and rounding dust.");
  } catch (error) {
    if (generation !== balanceGeneration) return;
    for (const c of routes) if (!balances.has(c.master)) balances.set(c.master, "Unavailable");
    notice(`${error.message} Balance lookup is optional; withdrawals can still be attempted.`, true);
  } finally {
    loadingBalances = false;
    render();
  }
}

async function connect(name) {
  if (active) return;
  try {
    const adapter = findWallet(name, web3);
    if (!adapter) throw new Error(`${name} was not detected. Install or unlock its browser extension.`);
    // Invoke connect on the user's click, before any network request.
    const key = await adapter.connect();
    wallet = adapter;
    payer = key;
    notice("Wallet connected. Choose a collection to withdraw.");
  } catch (error) { notice(error.message, true); }
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
  active = master;
  setMessage(master, "Preparing withdrawal…");
  try {
    await ensureMainnet();
    const policy = await resolvePolicy(master, policies, currentRpc, web3);
    const { value } = await request("getLatestBlockhash", [{ commitment: "confirmed" }]);
    if (!value?.blockhash || !Number.isSafeInteger(value.lastValidBlockHeight)) throw new Error("RPC returned an invalid blockhash.");
    const transaction = new web3.Transaction({ feePayer: payer, recentBlockhash: value.blockhash });
    transaction.add(
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
      web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      withdrawalInstruction(master, policy, payer, web3),
    );
    prepared = { master, transaction, blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight, createdAt: Date.now() };
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
    const bytes = signed.serialize();
    if (!signed.signature) throw new Error("Wallet returned no signature.");
    const entry = {
      signature: base58(signed.signature),
      lastValidBlockHeight: signed.recentBlockhash === item.blockhash ? item.lastValidBlockHeight : undefined,
    };
    pending.set(item.master, entry);
    savePending(); // Save the signature before broadcasting; an HTTP timeout is ambiguous.
    setMessage(item.master, "Sending transaction…");
    try { await rpc.sendTransaction(bytes); } catch { /* Reconcile before concluding failure. */ }
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
    if (result.state === "finalized") await loadBalances(master);
  }
}

async function checkPending(master) {
  if (active) return;
  const entry = pending.get(master);
  if (entry.finished) {
    pending.delete(master);
    savePending();
    await prepare(master);
    return;
  }
  active = master;
  setMessage(master, "Checking saved transaction…");
  try { await ensureMainnet(); await reconcile(master); }
  catch (error) { setMessage(master, error.message, true); }
  finally { active = null; render(); }
}

function changeRpc(endpoint, custom) {
  balanceGeneration++;
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
  try { await wallet?.disconnect(); } catch { /* Clear local state even if the extension closed. */ }
  wallet = null; payer = null; render();
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
  const [policyResponse, collectionResponse] = await Promise.all([fetch("policies.json"), fetch("collections.json")]);
  if (!policyResponse.ok || !collectionResponse.ok) throw new Error("Collection files did not load. Reload this page.");
  const data = await policyResponse.json();
  if (data.program !== PROGRAM || !data.policies) throw new Error("Incorrect policy file.");
  policies = data.policies;
  collections = (await collectionResponse.json()).sort((a, b) => a.name.localeCompare(b.name, "en"));
  try {
    for (const [master, entry] of JSON.parse(sessionStorage.getItem(storageKey) ?? "[]")) {
      if (Object.hasOwn(policies, master) && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(entry.signature)) pending.set(master, entry);
    }
  } catch { /* Storage is optional, and old or malformed entries are ignored. */ }
  const initial = new URLSearchParams(location.search).get("account");
  if (initial) $("search").value = initial;
  notice("Choose a collection. Balances are optional; use Load balances to fetch them.");
  showRpc();
  render();
}
start().catch(error => notice(error.message, true));
