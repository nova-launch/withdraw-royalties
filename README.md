# Nova SOL royalties

A static withdrawal page for the compact Nova program, `nva24Y1vHfhCrCLcqqFLXher9uZR4JjKP4D89MHhkmA`. This replaces the old React app. Earlier versions remain in Git history.

Connect Phantom or Backpack, find a collection, then click **Withdraw** and **Review in wallet**. Anyone can pay the transaction fee; the program sends SOL to its fixed royalty destinations. SPL-token payouts are not supported.

The page loads with five requests and makes no RPC calls until you ask for balances or prepare a withdrawal. Balance lookup is optional. A failed lookup does not block withdrawal preparation.

## Run locally

Use Node 22 or later. There is no install or build step.

```sh
npm run serve
```

Open <http://127.0.0.1:4175/>. Set `PORT` to use another port. The server binds to loopback and serves only the five public files.

## Page files

- `index.html` — page structure.
- `styles.css` — layout, including a stacked table on narrow screens.
- `app.js` — wallet connection, withdrawal instructions, balances and confirmation.
- `catalog.json` — all 3,209 frozen payout policies and 136 cached labels.
- `vendor/solana-web3-1.98.4.min.js` — pinned transaction codec and signing interface, served locally.

No framework, runtime package downloads, fonts, analytics, service worker or backend is required. Labels come from cached representative NFT names, with `#` serial numbers removed; they are not a verified collection directory. Samples with only a number appear as **Unnamed collection**. Search also matches the original sample name. Paste an exact master account address to reach a policy without a label. `?account=MASTER_ADDRESS` also works.

## Data and transactions

The compact program embeds the payout policies. Its old master accounts were closed, so withdrawal preparation uses the saved policies without looking up those accounts. The master address is still an instruction account and identifies the policy.

`catalog.json` preserves the frozen snapshot hash `81f0b7f364a0da13a27ec4ed4bb173788cf9503473ba1adb2999c2af17f495fe`. Tests check all 3,209 PDA derivations, shares and instruction account lists, plus a digest of the complete policy map. Labels do not affect payments.

The default endpoint is Solana's public mainnet RPC. If it blocks browser access or becomes unavailable, the page shows its switch to PublicNode. You can enter a custom HTTPS RPC in the header. Custom endpoints are never silently replaced, and their URLs are kept only in memory for the current page.

Phantom and Backpack can connect through their injected providers or Wallet Standard. The page uses legacy transactions for extension compatibility. Each wallet request starts on a direct click. Wallet changes cancel prepared transactions. If a prepared blockhash grows old, the page refreshes it before requesting approval.

After approval, the page saves the signature and signed transaction in session storage before sending. A lost response does not prove failure: the page checks the signature and may resend the same signed bytes. It never signs a replacement automatically. The transaction link survives reloads in the same tab when browser storage is available. **Check status** resumes an unresolved transaction. Closing the tab, blocked storage or clearing browser data can remove that local record; keep the explorer link if you need it later.

Displayed balances exclude retained rent and per-destination rounding dust. They are estimates, not withdrawal quotes: new royalties can arrive between a balance lookup and execution.

## Checks

```sh
npm test
npm run test:browser
```

Browser tests require Chromium. Set `CHROMIUM` to its executable path if needed. They use a temporary profile, fake wallets and mocked RPC responses; they cannot send mainnet transactions. Tests cover both wallet integrations, endpoint failures, signed-transaction recovery, mobile layouts and the five-request startup budget.

CI runs these checks without installing application packages. See [QA.md](QA.md) for the local results and limitations, and `vendor/README.md` for the vendored library's source, license and checksum.

## GitHub Pages

This repository is `nova-launch/withdraw-royalties`. The replacement is local-only until publication is approved. No Pages deployment has been enabled as part of this work.

After approval and push, configure **Settings → Pages → Deploy from a branch → master → /(root)**. `.nojekyll` makes this a plain static site. Relative asset URLs work at the repository's `/withdraw-royalties/` path. No deployment build is needed.

## Maintenance

The page has no hosted application service to maintain, but Solana, browser wallets and public RPC providers can change. A decade of operation cannot be guaranteed. Keep the source and vendored files available, rerun the tests before updates, and do a small wallet withdrawal when releasing a wallet or codec change. Public RPC rate limits may require users to supply another endpoint.

Do not regenerate payout policies from collection names or recipient guesses. Any policy update must match the deployed compact program and retain full-policy tests.
