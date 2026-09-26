# Local verification — 2026-09-26

This replacement has not been pushed or published. No withdrawal was signed with a real wallet, and no mainnet transaction was sent.

## Automated checks

- `npm test`: 12 tests passed. Includes all 3,209 policy addresses, PDA derivations, shares, instruction account ordering, transaction size, policy digest and vendored-library checksum.
- `npm run test:browser`: passed in Chromium. Exact cold-load count: five requests; startup RPC calls: zero.
- `git diff --check`: passed.
- Independent source comparison: all 3,209 policies equal the compact program's frozen snapshot.

The browser suite covers injected and Wallet Standard versions of Phantom and Backpack; rejected and unanswered approvals; late signatures; external account changes; slow disconnects; old blockhash refresh; lost send responses; identical-byte rebroadcast; processed-versus-finalized results; reload recovery; blocked session storage; endpoint changes during balance requests; public fallback; custom endpoints; root and GitHub project paths; and 320/390/1280-pixel layouts.

Wallets and RPC replies in that suite are mocks. It does not prove that every installed extension version will behave identically. A small real-wallet withdrawal remains a release check for the owner.

## Real browser balance check

A separate clean Chromium profile loaded the page and clicked **Load balances** without connecting a wallet. All 136 listed balances loaded through PublicNode. Solana's default public endpoint returned HTTP 403 from this environment, and the page displayed the fallback.

The live check found that PublicNode rejected `getMultipleAccounts` batches of 20 and 40 with HTTP 403, but accepted ten. The page now uses ten-account batches, and the mock enforces this limit. A full optional refresh takes one rent query and 14 balance queries, plus any fallback attempts and browser CORS preflights. Those are separate from the five-request initial page load.

## Unsigned mainnet simulations

Three transactions built with the page's instruction builder were simulated with signature verification disabled. No signing key was loaded. The fee payer was the public GODZ address.

| Cached sample | Slot | Result |
| --- | --- | --- |
| TENJIN #5862, two destinations | 450609450 | Passed; 890,881 lamports remained in the royalty PDA. |
| KFW#3938, four destinations | 450609452 | Program executed, but the runtime rejected the payout because an empty destination would remain below minimum rent. |
| Gargoyles #3964, five destinations | 450609786 | Passed; 890,881 lamports remained in the royalty PDA. |

KFW's rejected payout is an on-chain constraint, not a transaction-codec failure. The page reports the rent error without adding transfers or changing destinations. More royalties or separate funding of the empty destination would be needed; neither is performed by this app.

Local evidence is cached under `/home/mosh/mosh/nova/.tmp/nva-withdrawal-site-qa-2026-09-26/`. The public repository does not depend on that directory.

## Review findings resolved

- A late disconnect no longer clears a newer wallet connection.
- Ambiguous send outcomes remain tracked, and retries reuse the signed bytes.
- A processed transaction error is not treated as finalized.
- Retry and cancel preserve the prior transaction link.
- Optional balance refreshes do not hold withdrawal controls or switch an endpoint after the user changes it.

## Limits

The 136 labels come from cached representative NFT names, not a verified collection directory. All 3,209 frozen policies remain accessible by master address. Public RPC availability, future wallet changes and decades-long browser compatibility cannot be guaranteed. GitHub Pages configuration and live extension signing have not been tested in production because publishing is awaiting approval.
