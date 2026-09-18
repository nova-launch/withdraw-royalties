# Static SOL withdrawals

Serve this directory as-is. It has no build step, backend, npm dependencies, CDN scripts, analytics, external fonts or service worker. JavaScript and the wallet extension must be enabled.

The only vendored third-party runtime file is Solana web3.js 1.98.4. It supplies public keys and wallet transaction serialization. Its bundled code has transitive dependencies; this is one pinned asset, not a claim of zero third-party code. The accompanying license and SHA-256 are in `vendor/README.md`.

## Run and test

From the repository root:

```sh
python3 -m http.server 4175 --bind 127.0.0.1 --directory docs
node --test tests/static/*.test.mjs
node tests/static/browser.mjs
```

Open `http://127.0.0.1:4175/`. `?account=MASTER_ADDRESS` also works, including saved policies without an indexed NFT name.

The browser test needs Chromium and uses a temporary local server and isolated profile. It mocks every wallet/RPC operation, including wallet rejection, wallet-edited fees, failed balances, fallback RPC, expiry and confirmation. It also checks project-relative URLs and desktop/mobile layout. It sends no mainnet transactions. The unit suite checks all 3,209 policy derivations and instruction layouts.

## GitHub Pages

After review and approval to publish, push this repository and select **Settings → Pages → Deploy from a branch → master → /docs**. Pages serves the checked-in files; no custom Actions workflow or package installation is needed. All asset paths are relative, including on a project URL such as `/withdraw-royalties/`.

Copying `docs/` to another static host works too. Preserve the files together. No deployment or Pages settings were changed as part of this implementation.

## Policy data

This page supports SOL withdrawals from Nova v2 (`nva24…`). It does not replace the old app’s Nova5, single-collection or SPL-token paths. The original React application remains in `src/`.

`policies.json` is generated from the reviewed Nova compact-program snapshot dated 2026-09-17. It covers all 3,209 master addresses. The client reads a live master account first; only an explicit RPC `null` enables the saved policy. An RPC error never means the master was deleted.

`collections.json` contains 136 indexed labels. They are representative NFT names from the cached index, not verified collection names. Searching an exact master address reaches the other saved policies. Refresh labels with `scripts/export-collections.mjs`; it reads a supplied cache and does not query mainnet.

To refresh or verify policies, use `nova-launch-program/compact/scripts/export-client.mjs [--check] OUTPUT_JSON` from the adjacent program repository. Keep the client export and the program snapshot in sync before any master accounts are removed.

The withdrawal instruction retains the existing program ABI. Payouts retain the configured order, duplicate addresses, exact basis points and floor-per-address rounding. The balance display estimates withdrawable SOL after the larger of current rent and the old 890,880-lamport floor. Live policy changes can make the display stale; the withdrawal itself uses freshly fetched master data.

## RPC and transactions

The official mainnet endpoint is the default. If it rejects browser access or has a transient failure, the page visibly switches to PublicNode. A custom endpoint is never replaced automatically or persisted. URLs may contain private API keys; they stay in this tab. Browser tools and the endpoint operator can still see requests.

Balances load only on request or after a completed withdrawal. They are fetched asynchronously in batches. Failure does not disable withdrawal. No periodic inventory scans run.

Preparation fetches the policy and a recent blockhash. A separate Review button invokes the wallet directly from a click. Legacy transactions are intentional for Phantom compatibility; they do not require a new wallet transaction version. The fixed priority fee is 120 lamports (120,000 CU at 1,000 micro-lamports/CU), in addition to the network’s signature fee. The wallet can change its transaction settings.

After signing, the signature is saved in session storage before broadcast. Reconciliation resends only the same signed bytes. A transaction seen on-chain is not declared expired merely because its blockhash aged out. RPC uncertainty keeps the explorer link and allows status rechecking. Retry withdrawal is a separate user action and requires another wallet review; there is no automatic re-signing. Session storage is optional, so keep the explorer link if your browser blocks storage.

These choices reduce maintenance needs. They cannot guarantee decades of compatibility: wallets, RPC access, Solana’s protocol and GitHub Pages are external dependencies. Keep a downloadable copy and test after protocol or wallet changes.
