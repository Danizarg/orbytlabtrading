# ORBYT — progress, plan and handoff

Last updated: 2026-09-29 (Europe/Madrid). Working branch: **`feat/live-solana-terminal`**. `main` still holds the old static site and must not be touched until the new app is complete and verified.

## Start here (any machine, any assistant)

```bash
git clone https://github.com/Danizarg/orbytlabtrading.git
cd orbytlabtrading
git checkout feat/live-solana-terminal
npm install
npm run check        # typecheck (next typegen + tsc) + eslint + vitest
npm run dev          # http://localhost:3000 → redirects to /discover
```

Before you change anything, read these files in this order:
1. `AGENTS.md`: continuity rules. The deposit address belongs to the owner and is never changed.
2. `docs/REQUIREMENTS.md`: the owner's full specification. It is the source of truth.
3. This file: status, architecture and next steps.
4. `docs/DESIGN_BRIEF.md`: UI and UX direction for every page.
5. `docs/research/*.json`: live-verified provider research from 2026-09-28. It covers endpoints, exact field names, units, rate limits, CORS, terms and gotchas. Trust it over memory.
6. `docs/build/*.workflow.js`: the Claude Code workflow scripts used to build each stage. They double as detailed specs per module and slice.

Node 24.x is pinned via `engines`. No keys are needed to run. `.env.example` documents the optional keys.

## Owner rules (non-negotiable)

- The ONLY repository is https://github.com/Danizarg/orbytlabtrading.git. Do not deploy, do not create new repos, and do not create Vercel projects. The owner redeploys manually.
- Use real data only: no fabricated, random, simulated or static "live" data. Unknown values render "—".
- Keep API keys in env vars only. Server-only keys never get the `NEXT_PUBLIC_` prefix, and no secrets are committed.
- The deposit address `8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3` is in `src/config/site.ts` and belongs to the owner. Never change it.
- ORBYT displays market data and read-only quotes. It does not execute trades, hold funds or sign transactions.
- Before finishing, `next build`, typecheck and lint must all pass, `.env.example` must be complete, and the repo must be Vercel-compatible.

## Architecture (what exists on the branch)

**Stack:** Next.js 16.3 (App Router, Turbopack), React 19.3, TypeScript 5.9 strict (with `noUncheckedIndexedAccess`), Tailwind v4, Vitest 5, TanStack Query 5, zustand 5, lightweight-charts 5.2 (TradingView, Apache-2.0), @solana/kit 8.4 and zod 4. TypeScript 7 and ESLint 10 are deliberately not used because eslint-config-next isn't compatible with them yet.

### Data architecture (decided after live research)

Per-IP rate limits drive where each call runs.

- **Browser-direct, keyless.** GeckoTerminal (about 10 calls/min per IP; its 429 carries no CORS header), DEX Screener, Jupiter keyless (5 requests per 10 s per IP), publicnode Solana RPC (browser-allowed, light reads), and the PumpPortal free WebSocket (new pump.fun launches and migrations). Each visitor spends their own IP quota. Calls go through `src/lib/net/browser.ts` (per-provider budgets, cooldowns, dedupe, short cache).
- **Server-side, in Next.js route handlers under `/api/v1/*`.** The public Solana RPC lives here because it answers 403 to any browser Origin. So do every keyed provider (Helius, Birdeye, Solana Tracker, CoinGecko Demo/Pro, Jupiter key) and immutable transaction parsing. Calls go through `src/lib/server/http.ts` (budgets, retries, 429 cooldown, dedupe, health) plus Vercel CDN caching via `s-maxage`.
- **Isomorphic adapters.** Every adapter is a factory that takes a `JsonFetcher`, so the same code runs in the browser (keyless) and on the server (keyed).
- **Failover and capabilities.** `runChain` (`src/lib/core/chain.ts`) handles failover. The root layout computes a capabilities object from the env (`src/lib/config/capabilities.ts`) that says which keyed server routes exist. When a keyed server route is available, the client prefers it; otherwise it falls back to keyless browser sources. A route with no configured provider returns 501 and is skipped silently.
- **Normalized models and interfaces.** Models are in `src/lib/core/types.ts`. Interfaces (TokenDiscovery, Metadata, MarketData, Price, Liquidity, Transaction, Chart, Holder, Risk, Launchpad, BondingCurve, WalletActivity, Portfolio, Trading) are in `src/lib/core/providers.ts`. Every result is `Sourced<T>` with `freshness: 'stream' | 'realtime' | 'fast' | 'indexed'`, which drives the LIVE / "Updated Xs ago" badges.
- **Vercel constraints.** No persistent processes. Live data comes from browser WebSockets (PumpPortal, publicnode logs/account subscriptions), CDN-cached polling of route handlers, and on-chain reads. Persistent server-side ingestion (for example a paid PumpPortal trade feed, Helius LaserStream or CoinGecko WS) would need an external always-on worker. That is documented as future infrastructure and is not required.

### Directory map

| Path | Purpose |
| --- | --- |
| `src/lib/core/` | Models, provider interfaces, failover chain, DEX normalization, Solana helpers, formatters, API envelope and routes |
| `src/lib/net/` | Isomorphic `JsonFetcher` types, `ProviderError`, browser transport |
| `src/lib/server/` | Server transport, TTL cache, response helpers (`okSourced`, `upstreamFailure`, CDN cache policies), env and capabilities, `registry.ts` (lazy server providers + SOL price + mint info) |
| `src/data/` | Client data layer: `sources.ts` (keyless browser adapters + server proxies over /api/v1), `query.ts` (poll cadences), `hooks/` (React Query hooks per feature) |
| `src/lib/providers/geckoterminal` | Keyless GT plus CoinGecko Demo/Pro: discovery, search, markets, pools, OHLCV, trades, token info/risk/holder summary, launchpad graduation % |
| `src/lib/providers/dexscreener` | Secondary enrichment: pairs, token rows, search, migration detection |
| `src/lib/providers/jupiter` | Tokens V2 discovery/rows/search, Price V3, Ultra search (bonding %, snipers/insiders/bundlers), holdings, read-only quotes (Metis / Jupiter Ultra labels) |
| `src/lib/providers/solana` | JSON-RPC client (tx v1), pump.fun bonding-curve PDA + decoder, mint info, RPC portfolio, RPC trades, RPC wallet activity |
| `src/lib/providers/{helius,birdeye,solanatracker}` | Keyed, server-only adapters (holders, metadata, candles incl. 1s, trades, risk, Pulse lists) |
| `src/lib/streams/` | Reconnecting socket, PumpPortal client (free subscriptions only), Solana PubSub client, status store |
| `src/lib/analytics/` | Swap/transfer derivation from parsed txs, FIFO SOL-denominated PnL, candle aggregation + live ticks, trade merging, pump.fun bonding math |
| `src/client/` | API client, capabilities context, hooks (useNow, useFlash, useHydrated, usePumpPortal, useSolanaSubscriptions, useStreamStatus), preferences store (watchlist, tracked wallets, browser-local deposit override) |
| `src/components/ui/` | Panel, Tabs, Skeleton, EmptyState, Change, FreshnessBadge, TokenAvatar (progress ring), CopyButton, WalletLink/TxLink |
| `src/components/shell/` | AppShell, Logo, NavLinks, DepositDialog |
| `src/app/` | Layout (fonts, capabilities, providers). Route pages are placeholders until stage 2. |
| `tests/fixtures/` | Real provider responses captured 2026-09-28 (plus clearly labelled doc examples for keyed APIs). Used only in tests. |
| `docs/` | Requirements, design brief, research, build workflow scripts |

## Status against `docs/REQUIREMENTS.md`

| Area | Status |
| --- | --- |
| Repo / Vercel / no deploy | Done. The Next.js app lives in this repo. `vercel.json` sets framework nextjs and output `.next` (this overrides the old "Other/dist" dashboard settings) with `fluid: true`. Node 24.x. The old `dist/` static site has been removed on the branch. |
| Provider research | Done: `docs/research`. |
| Normalized provider architecture | Done: foundation plus all stage-1 adapters. |
| Resilience (dedupe, cache, backoff, failover, cooldown) | Done in the transports and chains. Error boundaries and loading states come in stage 2 UI. |
| API keys / `.env.example` | Done. Every variable is optional and documented with provider, feature and where to get it. |
| Server API routes `/api/v1/*` | Done: 19 routes, reviewed. Adds auth (SIWS) and a hardened logo proxy. |
| /discover, /watchlist | Done: a universe of 14 keyless sources with pacing, enrichment and hover prefetch. Reviewed. |
| /pulse (New / Final Stretch / Migrated) | Done: PumpPortal stream, Jupiter/GeckoTerminal backfill, on-chain curve progress. Reviewed. |
| /trade/[mint] (real chart, trades, holders, risk, quote) | Done (stage 3). Stage 3c in progress: an on-chain trade feed and trade-built candles for fresh tokens, in-app swaps with the connected wallet, and server fallbacks. |
| /wallet/[address] + /tracker | Done: holdings, activity, progressive FIFO PnL, and a tracker with account-change hints plus reconciliation. Reviewed. |
| Global shell (search, SOL price, stream status, status bar) | Done. Adds the wallet connect button (Phantom / Wallet Standard, SIWS). |
| Freshness badges | Primitive done. Wiring comes in stage 2. |
| Production build + verification with live data | `next build` passes (2026-09-29 10:00). Browser verification: stage 4. |
| README / PROGRESS final docs | TODO (final step). |

## Build log

- **Stage 0 (done, 2026-09-28).** Research workflow: 7 agents, live-tested providers, saved fixtures. Foundation committed (`9f26f50`, `46871a8`). Deposit address rule added (`7a05529`).
- **Stage 1 (implemented, 2026-09-28/29).** Provider adapters, on-chain decoders, streams and analytics were written by 8 parallel agents (`docs/build/stage1-providers.workflow.js`). The session was interrupted before the per-module review passes ran. State at interruption: 27 test files, 640 tests passing, lint clean, one type error in `src/lib/providers/birdeye/adapter.ts`. Missing tests: `src/lib/analytics/swaps.test.ts` (swap parser) and `src/lib/providers/solanatracker`. The `formatPrice` rounding-carry bug found by tests has been fixed (2026-09-29).
- **Stage 1 review (next).** An independent adversarial review-and-fix pass per module. It completes the missing tests and fixes the Birdeye type error. Reviewers must keep exported APIs stable.
- **Glue (done 2026-09-29).** `src/lib/server/registry.ts` (lazy server provider instances from env, SOL/USD price helper), `src/data/sources.ts` (browser adapter singletons + server-proxy adapters implementing the same interfaces via `/api/v1/*`), `src/data/query.ts`, `src/data/hooks/useSolPrice.ts`, `src/components/ui/ErrorBoundary.tsx`.
- **Stage 2 (then).** Six vertical slices with reviewers, per `docs/build/stage2-features.workflow.js`: api-routes, shell, discover, pulse, trade, wallet-tracker.
- **Integration (then).**
  - `npm run check` and `npm run build`.
  - `npm run dev`, then verify every page in a browser against live data: Discover rows, Pulse stream, a real mint's chart/trades, a real wallet's holdings/activity/PnL, the tracker live feed.
  - Mobile layout check.
  - A final multi-dimension review (real-data integrity, security, Vercel, accessibility).
- **Resilience pass (done 2026-09-29).** A single rate-limited keyless source no longer blanks a panel:
  - Server keyless fallbacks, CDN-cached so one upstream call serves every visitor: `/api/v1/candles` falls back to keyless GeckoTerminal OHLCV 1m–1d (after any keyed provider; s-maxage 30 latest / 600 with `before`; pool resolved from the cached pool list), new `/api/v1/pools?mint=` (DEX Screener token-pairs + GeckoTerminal pools merged by address, frozen curve prices never refilled; s-maxage 60), `/api/v1/tokens` falls back to keyless Jupiter (local 4 per 10 s fail-fast cap) then DEX Screener (s-maxage 15). Sub-minute candles still need a keyed source (501).
  - Capabilities gained `serverCandlesKeyless`, `serverPools`, `serverTokensKeyless` (always true); keyed fields unchanged.
  - `src/data/sources.ts` exports `server.candlesKeyless`, `server.pools`, `runWithServerFallback` (server step only after a real browser failure, never after "no data") and `isServerStale`. `useTokenOverview` (row: Jupiter → DEX Screener → GeckoTerminal → ORBYT) and `usePools` (DEX Screener → GeckoTerminal → ORBYT) use it and expose `delayed` / `poolsDelayed` for "Delayed" badges.
  - Pending for the chart/feed owners: put `server.candlesKeyless` after the direct GeckoTerminal step in `useCandles`, and pass the "Delayed" flags into ChartPanel / TradesTable / TokenHeader / PoolsPanel / RiskCard / StatsGrid badges. Done for `useCandles`, ChartPanel and TokenHeader (on-chain feed task); PoolsPanel / RiskCard / StatsGrid still pending.
  - Review fixes (2026-09-29): "empty" is only an answer when every source answered. `loadPools` / `loadTokenRows` throw when they have nothing and a source failed (the route then serves its last good response, flagged stale), and `runWithServerFallback` throws instead of returning an empty direct answer when the server retry failed too, so React Query keeps the last pool list / token row (verified in the browser: forced DEX Screener empty + GeckoTerminal/Jupiter/ORBYT failing kept "Pools 30" and the header row). The pools merge no longer copies price/quote/txns fields across sources that disagree on the base token and drops GeckoTerminal's embedded token identities (PENGU payload 30.9 KB → 22.7 KB). A failed pool lookup in `/api/v1/candles` is now a retryable 503/502, not a 501 "not configured". Server keyless GeckoTerminal waits at most 3 s for a budget slot (7 s timeout) and the candles route's maxDuration is 30 s.
- **On-chain trade feed (done 2026-09-29, stage 3c).** Fresh tokens no longer show "Candles unavailable — GeckoTerminal: not found" / "Trades: Unavailable" while indexers catch up (40 s to minutes):
  - `src/lib/onchain/tradeFeed.ts`: `createOnchainTradeFeed({ mint, pool, isPumpCurve, rpc, ws, solPriceUsd })` over publicnode, keyless, from the browser. Backfill: newest 60 signatures → successful ones, newest first, 40 transactions, 2 at a time, emitted as they arrive. Live: pump.fun curves decode the TradeEvent straight from `logsSubscribe` notification logs (exact SOL / token amounts, trader, event clock, post-trade virtual reserves → price; no RPC); other pools use the notification as a hint → `getTransaction` → `deriveTradeForMint` (max 3 in flight, duplicates dropped). Reconciliation every 8 s: one listing of everything newer than the last listed signature, unseen successful ones fetched 10 per round (rest carried over). Paused while the tab is hidden; shared per mint + pool and torn down 3 s after the last subscriber (StrictMode-safe). Own budget 28 calls / 10 s (6 kept for live work); browser `solana-rpc` budget raised 30 → 45 / 10 s after a live test (81 getTransaction in < 2 s, no 429).
  - publicnode's WS flips between backends: at 'processed' only, at 'confirmed' only, or nothing, for minutes at a time. The feed subscribes at both commitments, dedupes by signature, and confirms 'processed' trades (a 'confirmed' notification, a listing or `getSignatureStatuses`); a failed or never-confirmed one (dropped fork) is removed. Reconciliation is the source of truth.
  - `loadHistory()`: older pages (`before`, up to 1,000 signatures per call) until ~300 successful transactions: fresh curves are mostly failed sniper spam (a live 34 s old curve had 734 signatures, 681 failed), so the walk is bounded by transactions fetched, not signatures listed.
  - `src/lib/analytics/swaps.ts` exports `decodePumpTradeEventsFromLogs`, `decodePumpTradeEventLogLine`, `logsTruncated` (same byte decoder).
  - `useTrades`: ORBYT keyed route → on-chain feed (default; 'stream' while WS trades arrive, else 'realtime') → GeckoTerminal only when the chain read nothing. `feed.onchain` exposes history state / `loadHistory`.
  - `useCandles`: trade-built bars (`src/lib/onchain/candleFallback.ts` `selectCandleSource`) when no indexed pool, "not found", no candles, a failure with ≥ 2 trades, on-chain trades reaching back further than the native series, or the pool's complete on-chain history; labelled "Built from N on-chain trades since HH:MM:SS". Young pools (pump curves, < 30 min, or any fallback) load their history. `server.candlesKeyless` now follows the direct GeckoTerminal step; a stale / failed refresh shows "Delayed".
  - Header: without a market price, the newer of the curve read and the last on-chain trade, labelled ("pump.fun curve" / "last on-chain trade").
  - Fixed on the way: the chart canvas had 0 px height everywhere (the Pane body was not a flex column, and PriceChart got conflicting `relative` + `absolute` classes; `cn` does not merge Tailwind conflicts).
  - Review fixes (2026-09-29):
    - **Fake prints.** Any transaction may list any account read-only, so "mentions the pool" proves nothing. Before the fix, a peer-to-peer transfer (wallet A pays 1,000 SOL to wallet B for 1M tokens) that only listed the pool became a $100k "trade" at a price of the sender's choosing, on AMM pools and pump.fun curves alike. Now a curve trade needs pump's own TradeEvent for the mint (bundles: the largest user/direction group from its own events, `pumpTradeFromEvents`). A balance-derived trade needs the pool to have taken the other side (`src/lib/onchain/tradeGuard.ts`): the pool owns the vaults, or an off-curve vault authority did, and the mint and quote moved by comparable amounts (×½…2). A routed trade (the trader paid USDC, the pool took SOL) is priced from the pool side. A small real swap padded with a side transfer is rejected.
    - **"Complete" was claimed for a subset.** On a live 4-minute-old curve, the WebSocket delivered nothing and the chart said "complete on-chain history" while the feed held 652 of 1,303 successful transactions: reconciliation had silently dropped its backlog overflow. The feed now reports `missed` / `dropped` / `unlisted` (a listing window that overflowed), and `complete` is false whenever there is a gap. Once a young pool's whole history has been listed and the chart asked for it, overflow waits on the history lane (up to 600) instead of being dropped. The trades table notes "Busy pool: N listed transactions were not loaded within the RPC budget", and the chart shows "subset: N listed transactions not loaded".
    - Truncated WS logs no longer build a trade from the events before the cut; the full transaction decides. A 'processed' hint the node never returns (dropped fork) is not counted as skipped and not remembered. A provisional trade dropped with its fork can be listed and fetched again. A stream-lane failure is handed to reconciliation. The stream is credited ('stream', LIVE) only for trades it delivered.
    - SOL charts use each on-chain trade's exact SOL price on the basis of its USD price (`snapshot.solPrices` → `solChartTrades`). The trade's own SOL / token ratio drew SOL bars of a different shape than the USD bars, off by the trade's price impact.
    - A trade-built chart whose on-chain feed failed shows the feed's error ("Trades unavailable"), not "Waiting for trades".
- **Wallet trading (done 2026-09-29, stage 3c).** The trade panel (`src/components/trade/TradePanel.tsx` + `src/components/trade/panel/*`) executes in-app with the connected wallet:
  - Flow: `buildOrder` (Jupiter `/swap/v2/order`, taker = connected address) → wallet `signTransaction` → `executeOrder`, via `runTrade` / `tradeReducer` (`panel/execution.ts`): building → signing → submitting → confirmed / failed / unknown, Solscan link on success, Jupiter's error text on failure, a wallet rejection resets quietly, nothing is retried, one trade at a time.
  - The quote (`useQuote`) now comes from the product that executes: `/swap/v2/order` without a taker ("Jupiter Ultra"), keyless from the browser within the Jupiter budget, ORBYT's keyed quote route as the fallback; paused while a trade runs.
  - Balances (`useWalletBalances`): SOL from publicnode `getBalance` (server portfolio fallback); the token from the portfolio sources (shared cache with the wallet page). Sell 25/50/75/100 % of the raw balance (exact below 2^50 raw units, rounded down beyond), buy Max keeps 0.01 SOL, buy presets editable and saved locally, price impact > 15 % needs an explicit tick (the order is re-checked before signing).
  - Position: holding, value, FIFO average cost and PnL in SOL from the wallet's 15 newest transactions, shown only when they explain the whole balance.
  - No Limit tab: Jupiter's Trigger API needs create/execute/list/cancel flows that were not built or verified. The Advanced priority-fee / MEV fields were removed (Jupiter Ultra sets fees itself; the fields changed nothing).
  - Review fixes (2026-09-29):
    - A trade can be abandoned until the wallet has signed: a Cancel button while building or signing, and automatically on unmount or token switch. The wallet is then never asked, a wallet prompt left open no longer holds the panel, and a signature that arrives late is never sent. Once signed, the trade always runs to its outcome. Before this, leaving the page mid-build still opened the wallet prompt.
    - An order stopped on price impact only blocks the amount, side, slippage and token it was made with (`impactGate`). Before this, changing the amount kept the button on "Confirm the price impact".
    - A failed quote refresh shows "Update failed · last quote shown" and the provider error, instead of "Refreshes every 10 s" over a quote that is getting older.
    - The quote sends no transport retry (at most 2 of the browser's 4 Jupiter calls per 10 s when failing, not 4). Slippage changes are debounced like the amount.
    - Buy preset edits are all or nothing.
    - The impact stop card reads "Price impact needs your confirmation", not "swap failed".
- **Release (last).** Update README, PROGRESS and AGENTS. Merge `feat/live-solana-terminal` → `main` only when everything passes. The owner then redeploys on Vercel. The project settings may still say Framework "Other" / output `dist`; the committed `vercel.json` overrides them.

## How to continue with Claude Code on another machine

1. Clone, check out the branch, and run `npm install` (see Start here). Run `npm run check` to confirm a green baseline.
2. Ask Claude Code to "continue ORBYT from PROGRESS.md". It should read the files listed in Start here.
3. For multi-agent stages, the workflow scripts in `docs/build/` can be run with the Workflow tool. They already use repo-relative paths (`docs/research`, `docs/DESIGN_BRIEF.md`). Stage 2 expects the glue files listed above to exist first.
4. After meaningful work, update this file (status table, build log, validation) and push the branch.

## Validation log

- 2026-09-28: foundation passed `tsc --noEmit` and `eslint`.
- 2026-09-29: after stage 1, the full suite passes (640 tests) and lint is clean. One type error remains (Birdeye), to be fixed in the stage 1 review. The formatter tests pass after the fix.
- Live verification of the app in a browser: pending (stage 2).
- 2026-09-29 resilience pass: `tsc --noEmit` clean, eslint clean, 694 tests in the related suites pass. In the dev browser, `/api/v1/pools` merged DEX Screener + GeckoTerminal (s-maxage 60), `/api/v1/tokens` answered keyless (s-maxage 15), `/api/v1/candles` 1m/5m answered from keyless GeckoTerminal (s-maxage 30) and 1s still answers 501. With every direct Jupiter / DEX Screener / GeckoTerminal call forced to fail, a token page still got its row and 32 pools through ORBYT. Keyless calls per browser tab in the first 60 s (fetch attempts, failures included): trade page GeckoTerminal 3 and Jupiter 4 (max 2 per 10 s); /discover GeckoTerminal 3 and Jupiter 11 (max 3 per 10 s); /pulse GeckoTerminal 3, Jupiter 15 (max 4 per 10 s) and publicnode RPC 111. All are within the keyless budgets (GeckoTerminal ≤ 8/min, Jupiter ≤ 4 per 10 s). Several agents shared this machine's IP, so GeckoTerminal and Jupiter were partly rate limiting it.
- 2026-09-29 wallet trading: `tsc --noEmit` and eslint clean; full suite 1488 tests pass (new: panel amounts, execution state machine incl. the real `src/lib/swap` module with mocked HTTP and a key-holding test wallet, primary-button states, position cost, quote chain, balances, SSR render). In the dev browser (no wallet extension): disconnected panel shows "Connect wallet" and opens the wallet dialog; live Jupiter Ultra quotes for BONK and a fresh pump.fun token refresh every 10 s (route, min. received from slippage, 15.3 % impact flagged). With an in-page Wallet Standard test wallet (no keys): balances and Max, sell 25/75/100 %, editable presets, the > 15 % impact tick, building → signing → rejection (quiet reset), a real order for the wallet then Jupiter's own error text ("Failed to get quotes"), and the confirmed card (execute response stubbed in the tab, nothing sent). A real signed swap was not executed.
- 2026-09-29 wallet-trading review: `tsc --noEmit` clean; eslint clean on the panel files; full suite 1571 tests pass (new: `panel/execution.cancel.test.ts` covers cancel during build, a late order, cancel with the prompt open and a late signature, a hung wallet, a non-Error 4001, the no-op after signing, and the real `src/lib/swap` module never calling `/execute` after a cancel; also `impactGate`, `quoteStatus`, preset all-or-nothing, and the quote with no transport retry). In the dev browser with an in-page test wallet (no keys; `/execute` stubbed or blocked in the tab):
  - Cancel with the wallet prompt open reset the panel within 150 ms, and the late "approval" was not sent.
  - Switching token mid-build (order delayed 20 s) and leaving the page with the prompt open never asked the wallet or sent anything.
  - The impact stop (order patched to 40 %) cleared at 0.5 SOL and came back at 0.1 SOL.
  - Three slippage clicks produced one quote request.
  - A forced HTTP 500 showed "Update failed" plus "Jupiter: HTTP 500" with the quote's age.
  - The confirmed path still worked; Cancel disappears once signed.
  - No overflow at 375 px.

- 2026-09-29 on-chain trade feed: `tsc --noEmit` and eslint clean on the changed files; 51 new tests (`src/lib/onchain/*.test.ts`: log-line decoder on the three real pump.fun captures and real publicnode notifications, feed backfill / budget / dedupe / reconciliation / AMM path / provisional drops / hidden-tab pause / rate-limit backoff / history walk incl. the live 734-signature spam shape / sharing, candle fallback selection, header price) and 484 tests in the related suites pass (the one failing test in the full suite is `src/components/trade/panel/execution.test.ts`, another task's work in progress). In the dev browser: a 7 s old pump.fun token from Pulse charted "Built from 8 on-chain trades since 10:45:47 · pool not indexed yet" within ~7 s, header "pump.fun curve"; a 25 s old token reached its complete history (904 signatures listed, 58 trades back to creation) in ~30 s, chart LIVE; Solscan resolved a listed trade (same side, amount, signer); an active curve showed trades decoded from WS logs ("Source: Solana RPC · Solana WebSocket", freshness stream); BONK kept GeckoTerminal OHLCV (Orca pool) with on-chain USDC-quoted trades.
- 2026-09-29 on-chain feed review: `tsc --noEmit` and eslint clean; full suite 86 files / 1,595 tests pass, including new `src/lib/onchain/tradeGuard.test.ts` (real PumpSwap and pump.fun captures pass; P2P, padded swap, inflated quote and "gave tokens for nothing" are rejected; Raydium-style authority accepted; routed trade priced from the pool) and new cases in `tradeFeed.test.ts`, `pumpTrades.test.ts`, `candleFallback.test.ts` and `src/data/hooks/useTrades.test.ts`. Shared synthetic transactions live in `src/test/synthTx.ts`. In the dev browser:
  - A 1 s old pump.fun token opened from Pulse charted 12 real trades after 2.5 s. 40 s later the feed held 75 of 76 successful curve transactions; the 76th was a bot's read-only program call listing the curve, correctly not a trade. A listed row matched its transaction (sell, signer = wallet column, success).
  - The busy 20-minute-old curve showed "subset: 80 listed transactions not loaded" on the chart and the busy-pool note on the trades table instead of "complete".
  - BONK trades still flow through the guard, including USDC-paid routed trades priced from the Orca SOL pool. GeckoTerminal was rate limited for this IP, and its failure was shown.
  - SOL 15s bars equal the trades' exact reserve prices.
  - publicnode's WS delivered nothing for curve `mentions` during the session (0 notifications in 12 s on a pool trading ~5 tx/s). The program-wide stream delivered 1,188 notifications in 10 s but only 3 of that curve's 55 transactions.

## Known risks and decisions to keep in mind

- **Keyless limits.** GeckoTerminal about 10 calls/min per IP and 30–60 s cached. Jupiter keyless 5 requests per 10 s. The public RPC allows 10 getTransaction per 10 s per IP and blocks getTokenLargestAccounts. Without keys:
  - Trades on the token page come from the on-chain feed (publicnode RPC + logs, reconciled every 8 s); GeckoTerminal (~30 s delayed, labelled) only when the chain cannot be read. A very busy pool shows a subset of its trades (10 fetched per 8 s round when the WS is quiet; the feed's whole budget is about 2.8 transactions/s), and says so: "subset: N listed transactions not loaded" on the chart, a busy-pool note on the trades table, and never "complete on-chain history". Residual risk of the pool guard: for pools that do not own their vaults (Raydium AMM v4 / CPMM shape), a purpose-built program's PDA could still pose as the vault authority.
  - Holder lists and sub-minute native candles need a keyed provider. 1s/5s/15s candles are instead built from real trades, with the covered window stated.
  - Wallet PnL analysis is slow; `HELIUS_API_KEY` makes it fast.
- **publicnode WS** drops messages, so the tracker also reconciles by polling. On 2026-09-29 its `logsSubscribe` delivered at only one commitment at a time ('processed' or 'confirmed', flipping every few minutes) and sometimes nothing: subscribe at both and dedupe (the on-chain trade feed does).
- **PumpPortal** trade and account subscriptions are paid (API key plus a funded wallet) and are not used. The free stream covers creates and migrations.
- **Terms.** DEX Screener forbids products whose primary purpose competes directly with it, so it is used only for secondary enrichment with a text attribution and no logo. Jupiter requires the router label ("Metis" / "Jupiter Ultra") on quotes, and its clause 3.2(g) about combining data may need legal review. GeckoTerminal attribution text goes near its data. TradingView attribution stays on in charts.
- **Vercel Hobby** is for non-commercial use only; a commercial site needs Pro.
- **Transaction v1** is live on mainnet. Every getTransaction call sends `maxSupportedTransactionVersion: 1`.
- Every pump.fun progress value is decoded on-chain (`real_token_reserves` of 793.1M). Mayhem-mode and non-SOL-quote curves are handled (supply from the mint; quote mint from the curve).

## Next concrete step

Stage 3c (`docs/build/stage3c-onchain-trading.workflow.js`) launched 2026-09-29 ~09:57. It has three tasks, each with a reviewer:
1. onchain-feed: live trades from publicnode logs plus reconciliation, and candles built from those trades for fresh tokens.
2. wallet-trading: Axiom-style panel executing Jupiter swaps signed by the connected wallet.
3. resilience: server keyless fallbacks for candles, pools and tokens with CDN caching, and stale-while-error.

Then:
- run stage 4 (`docs/build/stage4-integrate.workflow.js`): browser verification and audits
- `npm run check` and `npm run build`
- merge to main and push (the owner asked for this; Vercel redeploys from main)

State as of 2026-09-29 10:00:
- 1376 tests pass; typecheck and lint are clean; the production build passes.
- Owner items done: central deposit address with the owner's QR (a guard test decodes it), no disclaimer lines, Inter font, Phantom connect and sign-in.
