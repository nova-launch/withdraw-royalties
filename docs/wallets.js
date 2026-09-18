import { CHAIN } from "./config.js";


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
