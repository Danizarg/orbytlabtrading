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
| Server API routes `/api/v1/*` | TODO (stage 2 slice `api-routes`). |
| /discover, /watchlist | TODO (stage 2 slice `discover`). |
| /pulse (New / Final Stretch / Migrated) | TODO (stage 2 slice `pulse`). Stream client and bonding decoder are done. |
| /trade/[mint] (real chart, trades, holders, risk, quote) | TODO (stage 2 slice `trade`). |
| /wallet/[address] + /tracker | TODO (stage 2 slice `wallet-tracker`). PnL engine, activity parser and streams are done. |
| Global shell (search, SOL price, stream status, status bar) | TODO (stage 2 slice `shell`). |
| Freshness badges | Primitive done. Wiring comes in stage 2. |
| Production build + verification with live data | TODO (after stage 2). |
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

## Known risks and decisions to keep in mind

- **Keyless limits.** GeckoTerminal about 10 calls/min per IP and 30–60 s cached. Jupiter keyless 5 requests per 10 s. The public RPC allows 10 getTransaction per 10 s per IP and blocks getTokenLargestAccounts. Without keys:
  - Trades on the token page come from GeckoTerminal, about 30 s delayed and labelled as such.
  - Holder lists and sub-minute native candles need a keyed provider. 1s/5s/15s candles are instead built from real trades, with the covered window stated.
  - Wallet PnL analysis is slow; `HELIUS_API_KEY` makes it fast.
- **publicnode WS** drops messages, so the tracker also reconciles by polling.
- **PumpPortal** trade and account subscriptions are paid (API key plus a funded wallet) and are not used. The free stream covers creates and migrations.
- **Terms.** DEX Screener forbids products whose primary purpose competes directly with it, so it is used only for secondary enrichment with a text attribution and no logo. Jupiter requires the router label ("Metis" / "Jupiter Ultra") on quotes, and its clause 3.2(g) about combining data may need legal review. GeckoTerminal attribution text goes near its data. TradingView attribution stays on in charts.
- **Vercel Hobby** is for non-commercial use only; a commercial site needs Pro.
- **Transaction v1** is live on mainnet. Every getTransaction call sends `maxSupportedTransactionVersion: 1`.
- Every pump.fun progress value is decoded on-chain (`real_token_reserves` of 793.1M). Mayhem-mode and non-SOL-quote curves are handled (supply from the mint; quote mint from the curve).

## Next concrete step

Stage 3 (`docs/build/stage3-complete.workflow.js`) was resumed at 2026-09-29 09:00 (run wf_15f42718-4ae).

- **Done and cached:** swap-parser review (pool-side quotes, 117 tests), keyed-provider review, Pulse completion.
- **Re-running:** trade, wallet-tracker and discover, in completion mode (finishing the partial files), plus the api-routes and pulse reviews.

Owner feedback applied on 2026-09-29:
- The deposit address is central and read-only, shown with a QR code and a one-line network hint.
- All disclaimer lines are removed ("Market data only · No custody …", deposit notes).
- Typography is Inter.

Then run stage 4 (`docs/build/stage4-integrate.workflow.js`): browser verification of every page with live data, plus audits for real-data integrity, security/Vercel, visual quality and performance. After that, `npm run build` and merge to main.

**Note:** main currently contains PR #1 (the early foundation with placeholder pages) and is what the live site shows. Merge this branch as soon as the build is verified.
