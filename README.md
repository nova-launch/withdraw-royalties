# NFT royalty withdrawals

Withdraw SOL royalties for supported Nova NFT collections on Solana mainnet. Works with Phantom and Backpack.

## Withdraw royalties

1. Connect your wallet using the buttons in the header.
2. Find your collection by name or master account address.
3. Click **Load balances** if you want to check the available amount.
4. Click **Withdraw**, then **Review in wallet**, and approve the transaction.

Your wallet pays the network fee. Use **View transaction** to follow its progress. If confirmation is delayed, use **Check status** before trying another withdrawal.

Balance lookup is optional. If it fails, you can still prepare a withdrawal or choose another mainnet RPC through **RPC** in the header. The default is Solana's public endpoint, with a visible PublicNode fallback. Custom RPC URLs stay in the current tab.

## Run locally

Use Node 22 or later. There is no install or build step.

```sh
npm run serve
```

Open <http://127.0.0.1:4175/>. Set `PORT` to use another port.

## Checks

```sh
npm test
npm run test:browser
```

Browser tests require Chromium. Set `CHROMIUM` to its executable path if needed. Tests use mocked wallets and RPC responses and do not send mainnet transactions.

## GitHub Pages

Serve the repository root as a static site. For GitHub Pages, select **Deploy from a branch → master → /(root)**. No build step is needed.
