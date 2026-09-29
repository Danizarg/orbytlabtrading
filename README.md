# ORBYT — Solana trading terminal

A real-data Solana trading terminal in the Axiom / GMGN class: live token discovery, a launch scanner (Pulse), token pages with TradingView Lightweight Charts and live transaction feeds, a read-only trade panel with real Jupiter quotes, wallet analytics with deterministic PnL, and a live wallet tracker.

Every number on screen comes from a real provider or from the chain. Nothing is simulated. When a source can't supply a value, the UI shows `—`.

**Continuing development?** Read [`AGENTS.md`](AGENTS.md), [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) and [`PROGRESS.md`](PROGRESS.md) first.

## Run

Requires Node.js 24.

```bash
npm install
npm run dev        # http://localhost:3000
npm run check      # typecheck + lint + tests
npm run build      # production build
```

No API keys are required. Without keys ORBYT runs on keyless public sources (see below). Keys unlock faster feeds and extra data; copy `.env.example` to `.env.local` and fill in what you have.

## Pages

| Route | What it shows |
| --- | --- |
| `/discover` | Ranked token table (trending, top volume, organic, new, gainers) across time windows with price, MC, liquidity, volume, txns, holders, risk metrics and DEX. |
| `/pulse` | Launch scanner: New Pairs (live from the PumpPortal stream), Final Stretch (bonding curves near migration, progress decoded on-chain) and Migrated. |
| `/trade/[mint]` | Token page: chart, trades, holders, pools, info, risk, launchpad state and an Axiom-style trade panel with live read-only quotes. |
| `/wallet/[address]` | Holdings, activity and FIFO SOL-denominated PnL for any wallet, computed from parsed transactions. |
| `/tracker` | Live activity feed for wallets you track (browser-local list). |
| `/watchlist` | Your starred tokens (browser-local). |

## Data sources

| Source | Used for | Key |
| --- | --- | --- |
| Jupiter (Tokens V2, Price V3, Ultra, Swap) | discovery, metadata, prices, audit/risk, quotes | optional `JUPITER_API_KEY` |
| GeckoTerminal / CoinGecko on-chain | trending/new/top pools, OHLCV candles, trades, token info, holder summary, launchpad graduation | optional `COINGECKO_API_KEY` |
| DEX Screener | secondary enrichment (pairs, socials, migration detection) | none |
| PumpPortal (WebSocket, free tier) | new pump.fun launches and migrations | none |
| Solana RPC (public mainnet, publicnode, or your own) | bonding curves, mint info, balances, transactions, wallet activity | optional `SOLANA_RPC_URL` |
| Helius | fast wallet history, holder lists, DAS metadata | optional `HELIUS_API_KEY` |
| Birdeye | 1s/15s candles, trades, holders, holder tags, meme lists | optional `BIRDEYE_API_KEY` |
| Solana Tracker | Pulse lists, risk metrics, 1s candles, trades | optional `SOLANATRACKER_API_KEY` |

Where each call runs is decided by rate limits: keyless public APIs are called from each visitor's browser (their own IP quota), while keyed providers and the public Solana RPC (which blocks browser origins) run in Next.js route handlers under `/api/v1/*` with CDN caching.

Attribution: on-chain data powered by GeckoTerminal. Quotes are routed by Jupiter (Metis / Jupiter Ultra). Charts use TradingView Lightweight Charts (Apache-2.0).

## Deposit address

The Deposit dialog shows ORBYT's central deposit address, defined once in `src/config/site.ts`. It is the same for every visitor, cannot be edited in the UI, and belongs to the site owner. ORBYT does not hold funds, verify deposits or credit balances.

## Architecture

- `src/lib/core` — normalized models, provider interfaces, failover chain, formatting
- `src/lib/providers/*` — one adapter per provider, each a factory that takes a `JsonFetcher` so it runs in the browser or on the server
- `src/lib/net`, `src/lib/server` — transports with per-provider budgets, retries, cooldowns and dedupe; server registry; response envelopes
- `src/lib/streams` — reconnecting WebSocket clients (PumpPortal, Solana PubSub)
- `src/lib/analytics` — swap derivation from parsed transactions, FIFO PnL, candle aggregation
- `src/data` — client data layer (browser sources, server proxies, React Query hooks)
- `src/app/api/v1` — route handlers
- `src/components` — UI
- `tests/fixtures` — real provider responses used only in tests

Details, decisions and current status: [`PROGRESS.md`](PROGRESS.md). Provider research with live-verified endpoint facts: [`docs/research`](docs/research).

## Deploy

The repository is Vercel-ready: `vercel.json` sets the Next.js framework preset and Fluid compute. Add environment variables in the Vercel project settings and redeploy. Production data feeds work without any key, but a private RPC (`SOLANA_RPC_URL` or `HELIUS_API_KEY`) is recommended for wallet features under real traffic.

## Not financial advice

ORBYT displays market data and read-only quotes. It never signs transactions, executes trades or holds funds.
