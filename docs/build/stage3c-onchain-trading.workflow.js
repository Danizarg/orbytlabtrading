export const meta = {
  name: 'orbyt-stage3c-onchain-trading',
  description: 'On-chain live trade feed + trade-built candles for every token (incl. seconds-old launches), and in-app trading via the connected wallet',
  phases: [
    { title: 'Build', detail: 'on-chain feed/candles; wallet-powered trade panel' },
    { title: 'Review', detail: 'adversarial review and fixes' },
  ],
}

const COMMON = `You are working on ORBYT, a real-data Solana trading terminal (Axiom/GMGN-class), in the current repository root (Next.js 16, React 19, TypeScript 5.9 strict + noUncheckedIndexedAccess, Tailwind v4 tokens in src/app/globals.css, Inter, TanStack Query 5, zustand 5, lightweight-charts 5.2, @solana/kit 8.4, Vitest 5). Read AGENTS.md, docs/REQUIREMENTS.md, PROGRESS.md, docs/DESIGN_BRIEF.md and the existing code you touch before editing. Keep exported APIs stable unless your task says otherwise. Real data only (unknown → "—"; never fabricate trades, candles, balances or success states). The owner removed all disclaimer copy: do not add lines like "never signs or holds funds", "no custody", "not financial advice", "coming soon". A dev server runs at http://localhost:3000 (use mcp__Claude_Browser__* tools to verify in the browser; do not start another server). Verify with npx tsc --noEmit, npx eslint <your files>, npx vitest run <your files>. No git, no npm install.`

const TASKS = [
  {
    key: 'onchain-feed',
    spec: `OWNER SCREENSHOT: on /trade/<a 6-second-old pump.fun token> the chart says "Candles unavailable — GeckoTerminal: not found" and the Trades tab says "Unavailable". GeckoTerminal/DEX Screener need 40 s–minutes to index new pools, so fresh tokens (exactly what traders open from Pulse) are blank. FIX IT WITH ON-CHAIN DATA, keyless, from the browser.

VERIFIED FACTS (2026-09-29): the browser-callable RPC https://solana-rpc.publicnode.com (src/data/sources.ts browserRpc) answers getSignaturesForAddress and getTransaction (jsonParsed, maxSupportedTransactionVersion 1) with access-control-allow-origin *. Its WebSocket (src/lib/streams/solana-ws.ts, logsSubscribe) delivers program logs; pump.fun bonding-curve trades emit a TradeEvent in "Program data:" log lines (discriminator bddb7fd34ee661ee; layout decoded by src/lib/analytics/swaps.ts decodePumpTradeEvents, which reads events from a parsed tx — factor/reuse its byte decoder so it can also decode from raw log lines). PumpSwap/AMM trades need getTransaction + deriveTradeForMint (src/lib/analytics/swaps.ts). The public WS drops some messages, so always reconcile by polling.

BUILD an on-chain trade source and wire it in (you own: src/lib/onchain/** (new), src/data/hooks/useTrades.ts, src/data/hooks/useCandles.ts, src/lib/analytics/swaps.ts (only to export a log-line TradeEvent decoder; keep existing exports), and any trade/chart component needed to label the new source):
1. src/lib/onchain/tradeFeed.ts — createOnchainTradeFeed({ mint, pool, isPumpCurve, rpc, ws, solPriceUsd }) → an object with backfill() and subscribe(listener), plus teardown:
   - backfill: rpc.getSignaturesForAddress(pool, { limit: 60 }) → keep err === null → fetch transactions newest-first with concurrency 2 (respect the browser 'solana-rpc' budget in src/lib/net/browser.ts; raise it modestly only if needed and justified), up to 40 → deriveTradeForMint(tx, mint, { pool }) → Trade (source 'solana-rpc', usd via SOL price for SOL quotes, priceUsd, marketCapUsd when supply known) — progressive: emit as they arrive.
   - live: for pump curves, logsSubscribe(mentions: curve) → decode TradeEvent(s) straight from the notification logs (no extra RPC) → Trade with exact sol/token amounts, is_buy, user, event timestamp (seconds → ms), post-trade virtual reserves → price; for other pools, logsSubscribe(mentions: pool) → on notification with err === null, getTransaction(signature) → derive (throttle: max 3 concurrent, drop duplicates).
   - reconciliation: every 8 s getSignaturesForAddress(pool, { limit: 20 }) → fetch unseen signatures (cap 10 per round) → emit. Dedupe everything by signature. Pause when document.hidden. Clean up on unmount (StrictMode-safe).
2. useTrades(mint, pool): chain order becomes [server trades (capabilities.serverTrades) | ON-CHAIN FEED (default when no keyed server trades; freshness 'stream' for WS-decoded, 'realtime' for polled) | GeckoTerminal trades (fallback, 'indexed')]. The on-chain feed must work for bonding-curve pools (curve PDA from derivePumpCurveAddress or the pumpfun pair address) and for AMM pools. Show freshness LIVE when WS events arrive.
3. useCandles: when the native source (GeckoTerminal) returns not_found / empty, or the pool is younger than the native source's coverage, fall back to candles aggregated from the on-chain trades (aggregateTrades) for every interval that has ≥ 2 trades, labelled "Built from N on-chain trades since HH:MM:SS"; for fresh pump tokens also backfill further (paged getSignaturesForAddress with before=, up to ~300 signatures total, paced within budget) so the chart covers the token's whole short life when possible. Live ticks from the feed update the last candle (applyLiveTick). Never synthesize empty candles.
4. Header price/MC for fresh tokens: when market providers have no data yet, use the bonding curve (useBondingCurve) and the latest on-chain trade price, labelled with their source.
Verify in the browser: open /pulse, click a token in New Pairs (seconds old), and confirm the chart shows candles built from real trades within ~10 s, the Trades tab lists real trades with Solscan links that resolve, new trades stream in (LIVE), and a graduated/large token still uses GeckoTerminal candles. Add unit tests for the log-line decoder (use real pump fixtures' log lines from tests/fixtures/solana-rpc/rpc_getTransaction_pumpfun_*.json), feed dedupe/reconciliation (mock rpc/ws) and the candle fallback selection.`,
  },
  {
    key: 'wallet-trading',
    spec: `Wire the connected wallet into the Axiom-style trade panel (you own: src/components/trade/TradePanel.tsx, src/components/trade/tradeSettings.ts, src/data/hooks/useQuote.ts, and new files under src/components/trade/panel/**, src/data/hooks/useWalletBalances.ts). The wallet layer (src/lib/wallet/**: store, connect, signTransaction), the header connect button (src/components/connect/**) and the Jupiter execution module (src/lib/swap/**: buildOrder/executeOrder/swap) were just built — read them first and use them; do not modify them except for clear bugs (report those).
Requirements (1:1 with Axiom's panel behaviour, ORBYT styling):
- Buy/Sell segmented control; Market tab (Limit tab only if you can implement it for real with Jupiter's documented Trigger API and the connected wallet — otherwise omit the tab entirely, no placeholders).
- Amount input with presets (Buy: 0.1/0.5/1/5 SOL, editable presets stored locally; Sell: 25/50/75/100 % of the wallet's token balance), wallet balances shown (SOL via browserRpc.getBalance with server portfolio fallback; token balance via the portfolio/holdings sources), "Max" handling that keeps ~0.01 SOL for fees on buys.
- Live quote (real Jupiter order/quote) with you-receive, rate, price impact (warn > 5 %, danger > 15 % with explicit confirm), min received from slippage, route, router label ("Jupiter Ultra"), fees; slippage presets 1/5/10/20 % + custom; refresh every 10 s while visible.
- Primary button: disconnected → "Connect wallet" (opens the connect dialog); connected → "Buy <SYMBOL>" / "Sell <SYMBOL>" executes in-app: buildOrder with taker = connected address → wallet signTransaction → executeOrder; states: building → awaiting signature → submitting → confirmed / failed, with the Solscan link on success and the Jupiter error text on failure; never auto-retry; disable while in flight; refresh balances after completion. User rejection = quiet reset.
- Remove the old deep-link-only button text "Opens Jupiter in a new tab · ORBYT never signs or holds funds" and "Connect wallet to trade in-app — coming soon"; keep a small secondary "Open in Jupiter ↗" link.
- Position summary for the connected wallet on this token: balance, value, and (if the wallet page's PnL utilities make it cheap) average cost from recent activity — otherwise just balance/value.
Verify in the browser (no wallet extension is installed there): panel renders, quotes are real and refresh, disconnected state shows "Connect wallet" and opens the dialog; unit-test the amount/percentage conversions, min-received math, state machine transitions with a mocked wallet and mocked execute.`,
  },,
  {
    key: 'resilience',
    spec: `Make data connections stronger so a single rate-limited keyless source never blanks a panel. You own: src/app/api/v1/candles/**, src/app/api/v1/pools/** (new), src/app/api/v1/tokens/**, src/lib/server/services/** (except trades.ts which you may extend carefully), src/lib/server/registry.ts, src/data/sources.ts (server proxy additions only), src/data/hooks/useTokenOverview.ts, src/data/hooks/usePools.ts. Do NOT edit useTrades.ts, useCandles.ts, TradePanel.tsx or src/components/trade/panel/** (other agents own them in this run) — instead expose the server fallbacks through src/data/sources.ts so they can call them, and document the new proxy methods at the top of sources.ts.
1. Server-side keyless fallbacks with CDN caching (the server has its own per-IP quota; CDN s-maxage shares one upstream call across all visitors): /api/v1/candles must serve GeckoTerminal OHLCV keyless when no keyed chart provider is configured (registry: add a keyless GeckoTerminal adapter for server use with the conservative server budget in src/lib/server/http.ts), cached s-maxage 30 (latest page) / 600 (pages with before). Add /api/v1/pools?mint= (DEX Screener token-pairs + GeckoTerminal token pools, merged, s-maxage 60) and make /api/v1/tokens fall back to keyless Jupiter + DEX Screener rows server-side (s-maxage 15). Update capabilities semantics so the client knows these routes always exist (e.g. add serverCandlesKeyless / serverPools booleans to deriveCapabilities, true always) — keep existing fields.
2. Client chains: useTokenOverview/usePools add the server routes as the fallback AFTER the direct browser sources (so a visitor rate-limited by GeckoTerminal/Jupiter still gets data through ORBYT). Export in sources.ts: server.candlesKeyless (same ChartDataProvider shape) and server.pools, so the on-chain-feed agent's useCandles can put server.candlesKeyless after the direct GeckoTerminal step.
3. Stale-while-error: make sure every trade-page panel keeps showing its last good data with a "Delayed" badge instead of an error screen when a refresh fails (inspect ChartPanel/TradesTable/InfoPanel/RiskCard/StatsGrid; fix only in files you own or report precise changes for others).
4. Measure: with the dev server, open /trade/2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv, /discover and /pulse for 60 s each and record requests per host (performance.getEntriesByType('resource')); fix anything exceeding the keyless budgets (GeckoTerminal ≤ 8/min per browser, Jupiter ≤ 4 per 10 s). Report the numbers.
Tests for the new services (mock providers) and the capabilities change.`,
  },
]

const SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    verified_in_browser: { type: 'array', items: { type: 'string' } },
    verification: { type: 'string' },
    caveats: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'summary', 'verified_in_browser', 'verification', 'caveats'],
}

const results = await pipeline(
  TASKS,
  (t) => agent(`${COMMON}\n\nTASK ${t.key}:\n${t.spec}\n\nReturn the structured report.`, { label: `build:${t.key}`, phase: 'Build', schema: SCHEMA }),
  (built, t) =>
    agent(
      `${COMMON}\n\nYou are the INDEPENDENT ADVERSARIAL REVIEWER for task ${t.key}. Spec:\n${t.spec}\n\nBuilder report:\n${JSON.stringify(built, null, 1).slice(0, 10000)}\n\nFind and FIX defects (correctness, units, dedupe, budgets/rate limits, cleanup/leaks, StrictMode, fabricated data, security of transaction handling, UX states), verify in the browser, add tests for each fix, run tsc/eslint/vitest. Return the structured report.`,
      { label: `review:${t.key}`, phase: 'Review', schema: SCHEMA },
    ).then((review) => ({ key: t.key, built, review })),
)
return results.filter(Boolean)
