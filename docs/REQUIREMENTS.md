# ORBYT: owner requirements (source of truth)

This is the owner's specification for the ORBYT rebuild, recorded on 2026-09-28 so any assistant or session can continue the work. Where it conflicts with anything else, this file and `AGENTS.md` win.

---

## Repository and deployment constraint

- The ONLY repository that may be modified is https://github.com/Danizarg/orbytlabtrading.git. All ORBYT code lives here.
- Do NOT create other repositories (frontend, backend, demo, prototype), second applications, new Vercel projects, or migrations elsewhere. Do NOT modify unrelated repositories.
- Do NOT deploy. The owner redeploys manually through Vercel.
- Inspect the existing repository and work within it. Preserve Git history and project structure where sensible. Refactoring inside the repo is allowed.
- Backend needs are met inside this repo with the existing stack: Next.js server routes, API routes, server actions, services, workers, WebSocket clients, database integrations, provider adapters, authentication infrastructure.
- Leave the repository production-ready for a manual Vercel redeploy. Before finishing:
  1. Run the production build.
  2. Run TypeScript type checking.
  3. Run linting where configured.
  4. Fix errors you introduced.
  5. Document every required environment variable.
  6. Update `.env.example`.
  7. Commit no API secrets.
  8. Keep the repo Vercel-compatible.
  9. Depend on no files that exist only on a local machine.
  10. Commit every new required file.

## Deposit address

The site deposit address is the owner's: `8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3` (in `src/config/site.ts`). Never change it.

## Real live market data (critical)

ORBYT must NOT be a mock trading dashboard. It needs real, live Solana market data comparable in experience to Axiom (https://axiom.trade/) and GMGN (https://gmgn.ai/), using real market/on-chain data wherever technically available.

Production screens must not contain fabricated tokens, prices, market caps, liquidity, volumes, transactions, wallet activity, holder counts, token ages, buys/sells, migration progress, PnL, trending tokens or token metadata. No randomly generated market data, no fake "live" feeds, no static token arrays pretending to be real. Development fixtures are fine only in isolated tests and must never appear as production data.

## Live data architecture

- Build a real data-provider architecture. Research and select legitimate APIs, RPC and indexing services per data type. Candidates include:
  - Solana RPC and WebSocket
  - Jupiter, Birdeye, DexScreener, GeckoTerminal
  - Helius, Solscan-compatible sources
  - Pump.fun / PumpSwap (where legitimately accessible)
  - Raydium, Meteora, Orca
  - metadata providers, TradingView-compatible chart data, other indexers
- Don't assume one API does everything.
- Normalized provider interfaces, e.g.: TokenDiscoveryProvider, TokenMetadataProvider, MarketDataProvider, PriceProvider, LiquidityProvider, TransactionProvider, WalletActivityProvider, HolderProvider, TokenRiskProvider, ChartDataProvider, TradingProvider, PortfolioProvider.
- The frontend consumes normalized ORBYT models, not a single vendor's shapes, so providers can be replaced without rebuilding the UI.

## Real-time updates

- Where providers support it, use WebSockets, Solana subscriptions, streaming APIs or SSE, with efficient polling as the fallback.
- It must feel live:
  - new trades update the transaction feed
  - price, volume and liquidity changes update in place
  - tracked-wallet buys update the tracker
  - new launches reach Pulse
  - migrations change a token's status
- No manual browser refresh, no full-page reloads. Update individual pieces of state efficiently.

## /discover (live)

- Real token data; discover what is happening on Solana now.
- Metrics, as far as providers reliably expose them: token, symbol, logo, contract/mint, price, market cap, FDV, liquidity, volume, age, transactions, buys, sells, holders, price change, DEX, pair, socials, migration state.
- Where reliable: top-holder concentration, developer holdings, insider concentration, sniper activity, bundled supply.
- Don't invent unavailable metrics: show "—", "Unavailable", or omit.

## Pulse (live)

- A real-time Solana token scanner with three sections: NEW PAIRS, FINAL STRETCH and MIGRATED.
  - New Pairs: actual newly detected launches.
  - Final Stretch: bonding-curve tokens approaching migration, where legitimate data allows.
  - Migrated: actual recently migrated tokens.
- New entries appear dynamically, fast enough for a trader to monitor launches.

## /trade/[mint]

- Loads the ACTUAL token: metadata, symbol, image, current price, market cap, liquidity, volume, pair info, transaction history, DEX, price history.
- The chart must represent the selected token. Never show generic or demo candles for a real token.

## Chart

- Use TradingView-based charting where licensing permits, or a professional candlestick implementation backed by real data, resembling the Axiom/GMGN chart workflow.
- Features: candlestick/OHLC, volume, crosshair, zoom, pan, timeframe switching, responsive resizing, live latest-price updates, historical candles.
- Intervals, as far as providers reliably support them: 1s, 5s, 15s, 1m, 5m, 15m, 1h, 4h, 1D.
- Never fabricate unsupported sub-minute candles.

## Transaction feed

- Actual blockchain/DEX activity. Where determinable: time, buy/sell, wallet, SOL amount, token amount, USD value, signature, and market cap at execution where reliably calculable.
- Signatures link to a Solana explorer; wallets are clickable.

## Wallet tracking

- Tracking a wallet retrieves its actual activity, never simulated trades.
- Detect swaps, buys, sells, SOL transfers and token transfers.
- Show label, token, type, amount, estimated USD, timestamp and signature.
- Use WebSocket/subscription infrastructure where available.

## /wallet/[address]

- Inspects the actual address. Compute only metrics supported by retrieved data: SOL balance, SPL holdings, portfolio value, realized/unrealized PnL, volume, number of trades, win rate, winners, losers, average holding period.
- PnL must be deterministic and auditable. Never invent acquisition prices. If history is insufficient, say so explicitly.

## Data freshness

- Make freshness visible where appropriate ("LIVE", "Updated 2s ago", "Updated 15s ago") to separate streaming data from slower indexed metrics.
- Caching: fast-moving data gets a short TTL or streaming, metadata a longer TTL, and historical candles cached intelligently.

## Rate limiting and resilience

- Assume APIs rate-limit, time out, return malformed data or go offline.
- Implement request dedupe, caching, exponential backoff, retries, provider failover, graceful degradation, error boundaries and loading states.
- One failed provider must not crash the terminal.

## API keys

- Never hardcode keys. Use env vars (e.g. HELIUS_API_KEY, BIRDEYE_API_KEY, SOLANA_RPC_URL, SOLANA_WS_URL, or whatever is actually required).
- Update `.env.example`, documenting per variable: provider, variable, feature, and where to obtain it.
- Keep implementing everything that doesn't need a missing key. Don't stop just because a key is missing.

## Vercel compatibility

- Respect serverless constraints: no permanently running local Node process unless a legitimate external service architecture exists.
- If persistent WebSocket ingestion can't run on Vercel serverless, design the client/provider integration accordingly or document the exact external infrastructure it would need. All source code stays in this repository.

## Final rule

The result must not merely LOOK like Axiom or GMGN; it must USE REAL DATA and BEHAVE like a genuine Solana trading terminal:

- Axiom/GMGN-level information density
- live Solana token discovery
- real market data, charts and transaction feeds
- real wallet tracking
- ORBYT branding
- this existing repository
- a Vercel-ready architecture

## Continuity (owner request)

Keep `PROGRESS.md` current with progress, steps done, steps remaining and the status of this specification, so the owner can continue in a different session or on a different machine.
