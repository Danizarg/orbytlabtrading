export const meta = {
  name: 'orbyt-stage3-complete',
  description: 'Finish ORBYT: build trade + wallet/tracker, complete discover + pulse, review swaps/keyed/api-routes — each with an adversarial reviewer',
  phases: [
    { title: 'Build', detail: '6 vertical slices on disjoint paths' },
    { title: 'Review', detail: 'independent reviewer per slice fixes defects' },
  ],
}

const REPORTS = 'docs/research'
const BRIEF = 'docs/DESIGN_BRIEF.md'
const STAGE1 = (args && args.stage1Exports) || '(see source files under src/lib/providers, src/lib/streams, src/lib/analytics)'

const PREAMBLE = `You are building part of ORBYT, a real-data Solana trading terminal (Axiom/GMGN-class), in the current repository root (the orbytlabtrading checkout; Next.js 16 App Router, React 19, TypeScript 5.9 strict + noUncheckedIndexedAccess, Tailwind v4, Vitest 5, @tanstack/react-query 5, zustand 5, lightweight-charts 5.2, lucide-react). Several agents build DISJOINT slices concurrently. Use absolute paths or run commands from the repo root.

NON-NEGOTIABLE PRODUCT RULES
- Real data only. Never fabricate, randomize, simulate or zero-fill market data. Unknown values render "—" (formatters in src/lib/core/format.ts do this). No static token arrays, no demo candles, no fake "live" feeds. Test fixtures only in tests.
- Freshness must be honest and visible: LIVE only for stream-fed or on-chain realtime data; indexed data shows its age (FreshnessBadge).
- ORBYT does not execute trades, hold funds or sign anything. Quotes are read-only previews linking out.
- The site deposit address (src/config/site.ts) belongs to the owner: never change it.
- Never put secrets in client code. Server-only modules import 'server-only'. Only NEXT_PUBLIC_* values may reach the browser.

READ FIRST (shared contract — DO NOT MODIFY unless listed in your owned paths):
- Foundation: src/lib/core/{types,providers,chain,api,dex,solana,format}.ts, src/lib/net/{types,errors,browser}.ts, src/lib/server/{http,cache,respond,env,registry}.ts, src/lib/config/capabilities.ts, src/config/site.ts
- Stage-1 modules (built and tested; the swap parser and keyed adapters are being finished by parallel completion slices — code against their exported signatures): src/lib/providers/**, src/lib/streams/**, src/lib/analytics/**, src/client/hooks/{usePumpPortal,useSolanaSubscriptions,useStreamStatus}.ts
- Client data glue: src/data/sources.ts (browser adapter singletons + server-proxy adapters), src/data/query.ts (query helpers), src/data/hooks/useSolPrice.ts, src/client/api.ts, src/client/capabilities.tsx (useCapabilities), src/client/store/preferences.ts (watchlist, tracked wallets)
- UI primitives: src/components/ui/** (Panel, Tabs, Skeleton, EmptyState, Change, FreshnessBadge, TokenAvatar, CopyButton, WalletLink/TxLink), hooks useNow/useFlash/useHydrated, tokens in src/app/globals.css
- Design brief (layouts, density, states, attribution): ${BRIEF}
- Research reports (provider facts): ${REPORTS}/*.json
Stage-1 exported APIs (summary):
${STAGE1}

VISUAL QUALITY BAR (owner requirement: "no AI-looking website — a legit-looking big DEX")
- It must read as a professional trading venue (Axiom, GMGN, Photon, Binance-style density), not a template or landing page. No hero sections, no marketing copy, no gradient blobs, no glassmorphism, no emoji, no oversized rounded cards, no decorative illustrations, no "✨ AI" flourishes, no lorem or filler text.
- Dense and precise: 4 px grid, 28–32 px table rows, 11–13 px text, tabular numbers right-aligned, hairline borders (border-line), restrained color (brand purple only for active/primary states; up/down colors only for market direction), consistent 6–8 px radii at most.
- Every pixel carries data or affordance. Align columns, truncate long names with title tooltips, keep headers sticky, keep panels edge-to-edge in a terminal grid (gap 1 px lines rather than floating cards) where appropriate.
- Microcopy is terse and trader-native ("MC", "Liq", "V 5m", "TXs", "Top10", "Dev", "Snipers", "Bundlers", "Migrated 2m ago").

OWNER FEEDBACK (2026-09-29, highest priority)
- "Make it less AI, make it look better and more trustable": sober, institutional trading-venue look (think Binance/Bybit/Axiom pro terminals). Neutral near-black panels, hairline dividers, precise alignment, no playful copy, no exclamation marks, no emoji, no gradients (except tiny brand marks), no glow effects. Numbers dominate; labels are small and muted. Consistent iconography (lucide, 14px, stroke 1.75). Consistent empty/loading/error treatments.
- "Make it faster": first paint must show skeleton structure instantly; start data requests in parallel (no request waterfalls — e.g. token overview, pools, trades and candles begin together once the pool is known; start pool-independent requests immediately); dynamic-import heavy client libraries (lightweight-charts via next/dynamic or import() inside the effect); memoize rows; virtualize or cap long lists; avoid re-rendering whole tables on each poll; prefetch the token page data on Discover/Pulse row hover (queryClient.prefetchQuery with the same query keys/options the trade page uses) and use <Link prefetch>.
- "Make all connections stronger": every data panel has at least two independent sources where the research allows (see architecture rules), retries with backoff via the transports, keeps showing the last good data (keepPreviousData) marked with its age when a refresh fails, and recovers automatically; streams reconnect and resubscribe; never leave a panel blank because one provider failed.
- The deposit address is the owner's central address (src/config/site.ts), shown read-only. Never add an edit/override path.
- Typography is now Inter (font-sans/font-display) + JetBrains Mono. Do not introduce other fonts.
- "I want to see EVERY memecoin there is": Discover must not be a 20-row sample. Build the largest honest universe the keyless sources allow — union of Jupiter toptrending/toptraded/toporganicscore (limit 100 each, all four windows as the user switches) + Jupiter recent + GeckoTerminal trending (duration = window) + top pools by volume and by tx count (pages 1–3) + new pools (pages 1–2) + DEX Screener boosts/profiles feeds for Solana — deduped by mint, with a "Loaded N tokens · sources …" line and infinite scroll / virtualization (rows are memoized). Spread the calls over time to stay within budgets (GeckoTerminal ≤ 8/min per browser; Jupiter ≤ 4 per 10 s) and show partial results as they arrive; never block the table on the slowest source.
- "I want a working tracker": /tracker must actually show real activity for added wallets within seconds (backfill via the activity route immediately on add, then live via logs subscription + 90 s reconciliation). Test it with a real active wallet taken from a live trade feed and make sure entries appear.
- "I want the trading panel, 1:1 like Axiom's": the token page sidebar carries an Axiom-style trade panel — Buy/Sell segmented control, Market/Limit tabs (Limit shows an informative disabled state: "Limit orders require a connected wallet"), SOL amount input with preset chips (0.1 / 0.5 / 1 / 5 SOL and for Sell 25/50/75/100 %), live quote row (you receive ≈ N TOKEN, price impact %, route, fees, slippage setting with presets 1/5/10/20% and custom), a primary "Buy TOKEN" / "Sell TOKEN" button that opens the Jupiter swap deep link for that pair in a new tab (ORBYT never signs), an "Advanced" disclosure (priority fee, MEV protection as informational toggles stored locally that only affect the deep-link parameters where Jupiter supports them — otherwise labelled "applied in wallet"), and a position summary line (SOL balance "—" until a wallet is connected; there is no wallet connection in this release, say "Connect wallet to trade in-app — coming soon" in a quiet footer). The quote must be REAL (Jupiter quote via server route when keyed, keyless jup.getQuote otherwise) and refresh every 10 s while the panel is visible.
- "I want TradingView charting": use TradingView's Lightweight Charts (already installed) with the full trader workflow: candlestick + volume histogram, crosshair OHLCV legend, interval bar, price/MC toggle, USD/SOL toggle where the pool quote is SOL, log/linear scale toggle, auto-scale reset button, "go to realtime" button, last-price line + label, persistent zoom across refreshes, tooltip time in the user's local zone, TradingView attribution logo on. Load the chart library with a dynamic import so it never blocks first paint. Never render fake candles: when no native candles exist and fewer than 2 trades are available, show an explanatory empty chart state.

ARCHITECTURE RULES
- Keyless public APIs (GeckoTerminal, DEX Screener, Jupiter keyless, publicnode RPC) are called FROM THE BROWSER via the singletons in src/data/sources.ts (each visitor spends their own per-IP quota). Keyed providers and the public Solana RPC are reached ONLY through ORBYT API routes (/api/v1/*) via the server-proxy adapters in src/data/sources.ts. Compose them with runChain (src/lib/core/chain.ts): prefer the server route when useCapabilities() says a keyed provider backs it, then fall back to keyless browser sources. A server route answering 501 not_configured must be skipped silently.
- Data fetching in components goes through React Query hooks (src/data/hooks/*). Poll with refetchInterval appropriate to the source's freshness (don't poll an indexed 30 s source every 2 s). Keep previous data on refetch (placeholderData: keepPreviousData); expose error + dataUpdatedAt so the UI shows freshness and degraded states. Respect keyless budgets: GeckoTerminal ~8 calls/min per browser, Jupiter 4 per 10 s per browser — design polling so a page stays within them (the browser transport fails fast when a budget is exhausted; chains then fall back).
- Components: 'use client' only where needed; pages are thin server components that render client feature components. Next 16: page params are Promises (await them). Use plain <img> (TokenAvatar) for token logos. Wrap each major panel in an error boundary (react class component in your slice or a shared one if provided) so one failing panel never blanks the page.
- Performance: memoize table rows, key by mint/signature, avoid re-rendering whole lists on each poll (structural sharing in React Query helps), throttle stream-driven renders (batch updates with requestAnimationFrame or 250 ms intervals).
- Style: match the existing code (2-space, single quotes, semicolons, named exports, Tailwind utility classes with design tokens only, concise comments for non-obvious logic). Accessibility per the brief.
- Tests: Vitest unit tests for non-trivial pure logic you add (compositions, reducers/stores, param parsing) colocated as *.test.ts (node environment; no DOM testing library is installed — keep component logic in testable pure functions). Tests must compile under strict TS.
- Verify before finishing: npx tsc --noEmit (fix all errors in YOUR files; report others), npx eslint <your paths>, npx vitest run <your paths>. All clean for your files. Do NOT run next build or dev servers (the lead integrates and runs the app). No npm install, no git.
- Only create/edit files inside your OWNED PATHS. Anything else → foundation_requests in your report.`

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    data_flow: { type: 'string', description: 'For each hook/route: sources used in order, polling cadence, freshness labelling' },
    exports: { type: 'string' },
    verification: { type: 'string' },
    caveats: { type: 'array', items: { type: 'string' } },
    foundation_requests: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'summary', 'data_flow', 'exports', 'verification', 'caveats', 'foundation_requests'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    defects_found: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, issue: { type: 'string' }, severity: { type: 'string' }, fixed: { type: 'boolean' } }, required: ['file', 'issue', 'fixed'] } },
    verification: { type: 'string' },
    remaining_risks: { type: 'array', items: { type: 'string' } },
    foundation_requests: { type: 'array', items: { type: 'string' } },
  },
  required: ['defects_found', 'verification', 'remaining_risks', 'foundation_requests'],
}

const MODES = { 'stage1-swaps': 'review', 'stage1-keyed': 'review', 'api-routes': 'review', discover: 'complete', pulse: 'complete', trade: 'complete', 'wallet-tracker': 'complete' }

const SLICES = [
  {
    key: 'stage1-swaps',
    owned: ['src/lib/analytics/swaps.ts', 'src/lib/analytics/swaps.test.ts'],
    spec: `STAGE-1 COMPLETION. src/lib/analytics/swaps.ts was implemented by an agent whose session was interrupted before tests and review. It is the core of trade feeds, wallet activity and PnL, so correctness is critical. Keep every exported name/signature stable (walletBalanceChanges, classifyWalletActivity, deriveTradeForMint, detectProgram, decodePumpTradeEvents, BalanceChanges, DerivedTrade, PumpTradeEvent) — other modules depend on them.
Write src/lib/analytics/swaps.test.ts against EVERY real fixture in tests/fixtures/solana-rpc/rpc_getTransaction_*.json (pump.fun bonding-curve buyExactSolIn legacy, buyV2 v0, sell v1, PumpSwap buy legacy dust, PumpSwap sell token-2022 v0, aggregator USDC quote with relayer fee payer v0; the error_v1_not_supported file is an error body): for each, hand-compute from the fixture (document the arithmetic in comments) the trader, side, token amount, SOL/quote amount, fee handling, rent exclusion and program label, and assert the implementation matches. Add synthetic minimal transactions for: plain SOL transfer in/out, SPL transfer in/out (counterparty detection), token↔token swap, failed transaction, wallet not involved, WSOL wrap/unwrap in the same tx, ATA opened (rent excluded) and closed (refund excluded), timestamp-less tx.
Review the implementation adversarially against docs/research/rpc-helius.json and pump.json gotchas (relayer fee payer, instruction names unreliable for direction, WSOL temp accounts, rent changed in 2026, v1 transactions, Token-2022, BigInt amounts > 2^53, truncated logs) and fix every defect found. Then make sure src/lib/providers/solana/{trades,activity}.test.ts integration tests (previously skipIf'd while swaps was a stub) now run and pass — you may edit those two test files only to fix assertions that were written against the stub.`,
  },
  {
    key: 'stage1-keyed',
    owned: ['src/lib/providers/birdeye/**', 'src/lib/providers/solanatracker/**', 'src/lib/providers/helius/**', 'tests/fixtures/doc-examples/**'],
    spec: `STAGE-1 COMPLETION for the keyed server-only adapters (Birdeye, Solana Tracker, Helius), written by an agent whose session was interrupted before review. Keep exported names/signatures stable (createBirdeye, createSolanaTracker, createHelius, their Options/Adapter types and exported constants) — src/lib/server/registry.ts depends on them.
1. Fix the TypeScript error in src/lib/providers/birdeye/adapter.ts (around line 300: an Omit<RiskReport,...> object used where a full RiskReport is required) — build a complete RiskReport (mint, flags, sources, updatedAt) honestly.
2. Solana Tracker has NO tests: write src/lib/providers/solanatracker/adapter.test.ts using the doc-example fixtures in tests/fixtures/doc-examples/solanatracker (extend them from the official docs at docs.solanatracker.io if needed; keep the "_note" stating they are documentation examples): Pulse multi/all mapping (latest/graduating/graduated → new/final/migrated), curvePercentage→progressPct, mixed timestamp units (seconds vs ms), risk mapping (snipers/insiders/bundlers/top10/dev percent, score label), chart 'oclhv' key and bare-array variant, trades, holders, header x-api-key present, key never in error messages, 401→not_configured, 429→rate_limited, the 10 s shared multi/all cache.
3. Review all three adapters adversarially against docs/research/keyed-apis.json and rpc-helius.json (units: Birdeye token_security fractions ×100 vs 0-100 elsewhere; v3 snake_case fields; interval support; Helius getTokenLargestAccounts + owner resolution + bonding-curve labelling; DAS parsing) and fix defects, adding tests for each fix.`,
  },
  {
    key: 'api-routes',
    owned: ['src/app/api/**', 'src/lib/server/services/**'],
    spec: `Implement every ORBYT API route listed in API_ROUTES (src/lib/core/api.ts) as Next 16 route handlers (GET only, runtime nodejs default, export const maxDuration where useful ≤ 30), using the server registry (src/lib/server/registry.ts: lazily-built server provider instances from env) and response helpers (src/lib/server/respond.ts: okSourced/ok/buildMeta/fail/badRequest/upstreamFailure/notConfigured, CACHE policies). Put reusable server compositions in src/lib/server/services/*.ts (import 'server-only'), with unit tests using fake providers.
Routes (validate every param: isSolanaAddress for mints/addresses/pools, isSignature for signatures, enums for interval/column/list/window, clamp limits; bad input → 400 badRequest):
- /api/v1/health → { configured: ConfiguredProviders, rpc: rpcKind(), capabilities (deriveCapabilities), providers: providerHealth() } no-store.
- /api/v1/onchain/curves?mints=a,b (≤100 unique valid) → registry curve provider getCurves → Record<mint, BondingCurveState> (CACHE.live). Works on the public RPC.
- /api/v1/onchain/mint/[mint] → MintInfo (s-maxage 60).
- /api/v1/trades?mint=&pool=&limit= → runChain over [RPC trades provider (only when rpcKind() !== 'public' — the public RPC's 10 req/10 s limits make it unusable for feeds), Birdeye, Solana Tracker, CoinGecko pro] → enrich trades that have solAmount but no usdValue using the registry SOL/USD price (usdValue = solAmount × solUsd; priceUsd = priceQuote × solUsd when quote is SOL; marketCapUsd = priceUsd × supply when the mint supply is known via cached MintInfo) and add note 'USD values use the current SOL/USD price'. CACHE.trades. None configured → notConfigured.
- /api/v1/candles?mint=&pool=&interval=&before=&limit= → chain over configured keyed chart providers whose .intervals include the interval [Birdeye, Solana Tracker, CoinGecko keyed] → CandleSeries (CACHE.candles; when before is set use s-maxage 300).
- /api/v1/holders?mint=&limit= → chain [Helius (pass knownPools labelling the pump bonding-curve PDA 'Bonding curve' when derivable), Birdeye, Solana Tracker] → HolderSnapshot; merge totalHolders/distribution from the CoinGecko keyed adapter summary when available. CACHE.holders.
- /api/v1/risk?mint= → merge (fillMissing, union flags/sources) of Solana Tracker and Birdeye risk; CACHE.holders.
- /api/v1/pulse?column=new|final|migrated → chain [Solana Tracker, Birdeye] getPulse → PulseToken[] (s-maxage 5).
- /api/v1/discover?list=&window=&limit= → only when JUPITER_API_KEY or COINGECKO key: chain [server Jupiter discover, CoinGecko keyed discover] then enrich with server Jupiter getUltraInfo (optional) → TokenRow[] (CACHE.discovery).
- /api/v1/tokens?mints= (≤100) → chain [server Jupiter getRows, CoinGecko keyed getRows] (CACHE.market).
- /api/v1/quote?inputMint&outputMint&amountRaw&inputDecimals&outputDecimals&slippageBps → only with JUPITER_API_KEY → getQuote (CACHE.live). amountRaw must be a positive integer string.
- /api/v1/wallet/[address]/portfolio → registry portfolio provider (RPC); if a keyed server price source exists (Jupiter key) price tokens + SOL and set totals; else return balances unpriced (client prices them). CACHE.market.
- /api/v1/wallet/[address]/activity?before=&limit= → registry activity provider (limit default 15, max 25 on public RPC, max 100 with Helius) → WalletActivityPage. s-maxage 5 for the first page, 300 when before is set (older pages are immutable).
- /api/v1/tx/[signature]?wallet= → registry activity provider getTransaction → WalletActivity | null (s-maxage 3600; transactions are immutable once confirmed).
Every response goes through okSourced/ok with sources + notes; every failure through upstreamFailure (ChainError → 501/404/503/502 as implemented). Never leak URLs/keys in errors. Add route-level tests where logic is non-trivial (param parsing helpers, USD enrichment, holder labelling) by testing exported pure helpers in src/lib/server/services.`,
  },
  {
    key: 'shell',
    owned: ['src/components/shell/**', 'src/app/not-found.tsx', 'src/app/error.tsx', 'src/app/global-error.tsx', 'src/app/loading.tsx', 'src/data/hooks/useSearch.ts', 'src/data/hooks/useSearch.test.ts', 'src/data/hooks/useProviderHealth.ts'],
    spec: `Build the global application shell per the design brief (Global shell section). Keep DepositDialog's behaviour and the owner's deposit address untouched (you may restyle the button only).
- Header (AppShell.tsx, 48 px, sticky): Logo, NavLinks, GlobalSearch (center), SolPriceChip, StreamStatus popover, DepositButton. Mobile: nav scrolls horizontally, search collapses to an icon that opens a full-width search sheet.
- GlobalSearch + useSearch(query): debounce 300 ms, min 2 chars. If the query is a valid Solana address: offer "Open token" (/trade/[addr]) and "Open wallet" (/wallet/[addr]) immediately, and still run a token lookup by mint. Otherwise chain/merge: jup.search (primary), dex.search, gecko.search — run Jupiter first; only call the others if Jupiter fails or returns < 5 hits (keyless budgets). Dedupe by mint, rank verified + liquidity. Dropdown shows avatar, symbol, name, MC, liquidity, verified badge, launchpad stage; keyboard navigation (↑/↓/Enter/Esc), "/" focuses the input globally (ignore when typing in inputs/dialogs), combobox ARIA roles.
- SolPriceChip: useSolPrice() (src/data/hooks/useSolPrice.ts, already provided) → ◎ $price ±24h% with FreshnessBadge semantics (title shows source + age).
- StreamStatus: dot + popover listing PumpPortal and Solana WS status (useStreamStatus from src/client/hooks/useStreamStatus.ts), browser provider health (subscribeBrowserHealth/browserHealth from src/lib/net/browser.ts: last OK, cooling down until …), and server provider health via useProviderHealth() (GET /api/v1/health every 60 s; shows which keyed providers are configured — never secrets). Green = all good, amber = degraded/cooling down, red = offline.
- StatusBar (bottom, sticky, 28 px) replacing the current footer: provider dots, attribution line "Data: Jupiter · GeckoTerminal (on-chain data powered by GeckoTerminal) · DEX Screener · PumpPortal · Solana RPC · Charts: TradingView Lightweight Charts", and "Market data only · No custody · No trade execution · Not financial advice".
- App-level states: src/app/not-found.tsx (branded 404 with search hint), src/app/error.tsx (client error boundary with retry), src/app/global-error.tsx, src/app/loading.tsx (subtle skeleton). Keep src/app/layout.tsx unchanged (it renders AppShell) — if you need layout changes, put them in foundation_requests.
- Tests: useSearch ranking/dedupe/address-detection logic as pure functions.`,
  },
  {
    key: 'discover',
    owned: ['src/app/discover/**', 'src/app/watchlist/**', 'src/components/discover/**', 'src/data/hooks/useDiscover.ts', 'src/data/hooks/useTokenRows.ts', 'src/lib/services/discover.ts', 'src/lib/services/discover.test.ts'],
    spec: `OWNER (2026-09-29 09:00): do not add disclaimer copy anywhere (no 'No custody', 'Not financial advice', 'read-only', 'does not hold funds', 'no trade execution' lines); remove any you find in your owned files. src/lib/services/discover.test.ts currently fails because discover.ts changed the default list: keep code and tests consistent.
Build /discover and /watchlist per the design brief.
Data (src/lib/services/discover.ts = isomorphic pure composition + src/data/hooks):
- useDiscover(list: 'trending'|'top'|'organic'|'new'|'gainers', window): base list via runChain [server discover proxy (only if capabilities.serverDiscover), jup.discover, gecko.discover] ('organic' has no GeckoTerminal fallback; 'gainers' = the 'trending' list re-sorted client-side by the selected window's priceChangePct — label it "sorted sample of trending tokens"). Poll base list every 15 s.
- Enrichment query keyed on the current mints (≤100): jup.getUltraInfo (snipers/insiders/bundlers/bot holders + bonding progress; deprecated endpoint → tolerate failure) every 60 s, and dex.getRows for pool/DEX label + socials/image fallback every 60 s (chunked by 30, skip if the base rows already carry pool info). Merge with fillMissing — never overwrite a primary value, never invent. Row market data may also be refreshed by the base poll only (don't add extra per-row calls).
- useTokenRows(mints) for the watchlist: runChain [server tokens proxy (capabilities.serverDiscover), jup.getRows, gecko.getRows, dex.getRows] every 20 s; preserve the user's watchlist order.
- Stay within keyless budgets: Discover page ≤ ~2 Jupiter calls per 15 s window and ≤ 2 GeckoTerminal calls per minute on fallback.
UI (src/components/discover/*): title row (list Tabs, window Tabs, filters popover: min liquidity, min MC, max age, stage all/bonding/graduated/amm, hide flagged/isSus), FreshnessBadge (indexed/fast age from dataUpdatedAt; show source name), dense sortable table (columns per brief: # · Token · Price · Chg · MC · Liq · Vol · Txns buys/sells bar · Traders · Holders · Top10% · Dev% · Snipers% · Insiders% · Bundlers% · DEX · ☆). Sorting client-side with aria-sort; numeric sorts treat undefined as lowest and keep them last. Row: Link to /trade/[mint] on the token cell + whole-row click (respect cmd/ctrl-click → new tab), useFlash on price, TokenAvatar with progress ring for bonding tokens, age via useNow, short mint + CopyButton, social icons (website/twitter/telegram) as external links, launchpad badge, risk % colouring thresholds from the brief, watch star (usePreferences toggleWatch, hydration-safe). Loading skeleton rows, empty state, error state showing which providers failed (ChainError attempts). Footer line: "Source: <provider> · updated Xs ago" + GeckoTerminal attribution when GeckoTerminal data is shown. Horizontal scroll container on small screens; sticky header and sticky first column.
/watchlist: same table with useTokenRows, remove-from-watchlist action, empty state explaining how to star tokens (hydration-safe).
Tests: composition/merge logic (fillMissing precedence, gainers sort, filters, sort comparator with undefined values) in discover.test.ts.`,
  },
  {
    key: 'pulse',
    owned: ['src/app/pulse/**', 'src/components/pulse/**', 'src/data/pulse/**', 'src/lib/services/pulse.ts', 'src/lib/services/pulse.test.ts'],
    spec: `Build /pulse, the real-time Solana launch scanner (New Pairs · Final Stretch · Migrated), per the design brief.
State: a zustand store in src/data/pulse/store.ts holding Map<mint, PulseToken> with pure reducer helpers in src/lib/services/pulse.ts (unit-tested): upsert(existing, patch, source) merges with fillMissing semantics except fields that legitimately change (price/mcap/progress/stage/txns/holders take the newest reading, with source); stage transitions bonding → graduated only; prune to ≤ 400 tokens (drop oldest non-visible).
Column selectors (pure): New Pairs = stage 'bonding', created/detected within the last 3 h, newest first, cap 60. Final Stretch = stage 'bonding' with progressPct ≥ 60 (on-chain progress preferred over provider-reported), highest first, cap 40. Migrated = stage 'graduated' with graduatedAt within 24 h, newest first, cap 60.
Inputs (src/data/pulse/usePulseFeeds.ts etc.):
1. PumpPortal stream (usePumpPortalNewTokens / usePumpPortalMigrations from src/client/hooks/usePumpPortal.ts): new tokens appear instantly (detectedAt = receivedAt; createdAt = receivedAt with note; MC = marketCapSol × SOL price from useSolPrice only when the event provides marketCapSol; progress from the event); migrations flip stage to 'graduated' (graduatedAt = receivedAt, migratedPool if known). Throttle store writes (batch every 250 ms).
2. Backfill/refresh (keyless, browser): jup.discover({list:'new'}) (/tokens/v2/recent, 30 latest first-pool creations incl. non-pump launchpads) every 6 s; gecko.getNewPools() every 60 s (bonding-curve dex pools → New; pumpswap / meteora-damm-v2 / raydium-cpmm pools whose token has a launchpad → Migrated with graduatedAt = pool creation); gecko.getDexPools('pump-fun', {sort:'h24_tx_count_desc'}) every 60 s → Final Stretch candidates (active bonding curves), then progress from on-chain curves.
3. On-chain curves: for pump.fun bonding tokens in the store that are visible or candidates (≤ 100), poll browserCurves.getCurves (publicnode, sources.ts) every 4 s; on failure fall back to the server curves proxy (/api/v1/onchain/curves). Apply progressPct (progressSource 'solana-rpc'), complete → stage graduated if a migration follows, priceQuote/marketCapQuote × SOL price (SOL-quoted curves only; quoteMint must be WSOL) → marketCapUsd. Mint supply comes from the curve provider.
4. Enrichment: jup.getRows(visible mints ≤100) every 15 s for image, holders, volume, txns, top10/dev %, socials; jup.getUltraInfo(visible) every 60 s for snipers/insiders/bundlers + bonding % for non-pump launchpads (tolerate failure).
5. When capabilities.serverPulse: also poll the server pulse proxy per column every 10 s and merge (keyed launchpad lists with risk metrics).
Budgets: keep Jupiter ≤ 4 calls / 10 s per browser in total (recent 6 s + rows 15 s + ultra 60 s + SOL price from useSolPrice) and GeckoTerminal ≤ 3 calls/min. Pause timers when document.hidden (React Query does this for queries; do the same for manual intervals).
UI (src/components/pulse/*): three columns on desktop (column switcher Tabs on < 1024 px). Column header: title, count, FreshnessBadge (LIVE when PumpPortal is open and has delivered within 10 s; otherwise age of last backfill), filter popover (min MC, launchpad pump/bonk/other/all, require socials), pause-on-hover with "Paused" chip and queued-count. Cards per brief (≈ 88 px, memoized, slide-in for new, TokenAvatar with progress ring, live-ticking age via useNow, MC, V, TX buys/sells, holders, bottom strip progress/dev buy/top10/dev/snipers/insiders/bundlers; unknown "—"). Migrated cards: "migrated Xs ago · <DEX>". Click → /trade/[mint]. Empty states explaining what feeds the column. Source line per column.
Tests: reducer/merge/selectors/pruning/progress precedence in pulse.test.ts.`,
  },
  {
    key: 'trade',
    owned: ['src/app/trade/**', 'src/components/trade/**', 'src/components/chart/**', 'src/data/hooks/useTokenOverview.ts', 'src/data/hooks/usePools.ts', 'src/data/hooks/useTrades.ts', 'src/data/hooks/useCandles.ts', 'src/data/hooks/useHolders.ts', 'src/data/hooks/useRisk.ts', 'src/data/hooks/useQuote.ts', 'src/data/hooks/useBondingCurve.ts', 'src/data/hooks/useMintInfo.ts', 'src/lib/services/token.ts', 'src/lib/services/token.test.ts'],
    spec: `OWNER (2026-09-29 09:00): do not add disclaimer copy anywhere (no 'No custody', 'Not financial advice', 'read-only', 'does not hold funds', 'no trade execution' lines); remove any you find in your owned files. src/lib/services/discover.test.ts currently fails because discover.ts changed the default list: keep code and tests consistent.
Build /trade/[mint], the token trading page, per the design brief. Must load the ACTUAL token for the mint (validate with isSolanaAddress; invalid → notFound()). generateMetadata: title "Trade <short mint>" (no upstream fetch in metadata).
Data hooks:
- useTokenOverview(mint): meta+market via runChain [server tokens proxy (capabilities.serverDiscover), jup.getRows([mint]), gecko.getRows, dex.getRows] every 10 s; pools via usePools(mint): runChain [dex.getPools, gecko.getPools] every 60 s → primaryPool = most liquid non-frozen active pool (exclude the frozen post-graduation pumpfun pair; for bonding tokens the pumpfun curve pair IS the pool). Allow ?pool= search param to override (Pools tab selection). Metadata merge via fillMissing (Jupiter primary; GeckoTerminal info for socials/description).
- useMintInfo(mint): server proxy /api/v1/onchain/mint (supply/decimals/authorities; long staleTime).
- useBondingCurve(mint) (only when launchpad is pump.fun and stage bonding, or pool dex 'pumpfun'): browserCurves.getCurves([mint]) every 3 s (fallback server curves proxy) → progress, complete, reserves, price in SOL × SOL price.
- useRisk(mint): merge [server risk proxy (capabilities.serverRisk), jup.getRisk (includes Ultra extras), gecko.getRisk] with fillMissing + flag union; every 60 s.
- useHolders(mint): runChain [server holders proxy (capabilities.serverHolders), gecko.getHolders summary]; every 60 s. UI shows list when present, otherwise summary + "Holder list requires a Helius, Birdeye or Solana Tracker key" note.
- useTrades(mint, pool): runChain [server trades proxy (capabilities.serverTrades) polled every 3 s → freshness realtime/fast, gecko.getTrades polled every 30 s → 'indexed', badge "~30 s delayed"]. Keep an accumulated list with mergeTrades (src/lib/analytics/trades.ts), cap 300, newest first; expose newSignatures for flash. MC at trade = priceUsd × mint supply when both known (real computation) else "—".
- useCandles(mint, pool, interval): native intervals = the active chart source's intervals (server candles proxy when capabilities.serverCandles includes the interval, else gecko ['1m','5m','15m','1h','4h','1d']); '1s'/'5s'/'15s' when not native → derived with aggregateTrades from the trades feed (label "Built from N real trades since HH:MM:SS"; if fewer than 2 trades → empty state explaining, NEVER synthetic candles). Load older history on demand (before = first candle time) when the user scrolls left (throttled). Refresh native candles every 60 s (gecko) / 15 s (server). Live tick: applyLiveTick with each new trade priceUsd (realtime feeds), or the bonding-curve price (bonding tokens, 3 s), or jup.getPrices([mint]) every 10 s otherwise — this moves the last candle close/high/low with real prices only.
- useQuote({side, amount}): debounced 400 ms, only while the quote panel is mounted and amount > 0: runChain [server quote proxy (capabilities.serverQuote), jup.getQuote]; buy = SOL→token (amountRaw = SOL × 1e9), sell = token→SOL (amountRaw = amount × 10^decimals; decimals from mint info/meta). refetch every 15 s while visible.
Chart (src/components/chart/PriceChart.tsx, 'use client'): lightweight-charts v5 per platform.json findings — createChart in useEffect with autoSize, dark theme from tokens, CandlestickSeries + volume HistogramSeries on an overlay scale (scaleMargins), crosshair legend (O/H/L/C/V + time), priceFormat {type:'custom', formatter: formatPrice-like subscript formatter, base: 10**k} recomputed from price magnitude (exact powers of ten, k clamped 2..18), setData only with ascending unique times, series.update for live ticks (never older times), fitContent on first load, keep the user's zoom on updates, chart.remove() on unmount (StrictMode-safe), attributionLogo true. Price/MC toggle (MC = price × supply; disabled without supply). Interval buttons [1s,5s,15s,1m,5m,15m,1h,4h,1D] with disabled + tooltip for unavailable, and a marker dot for trade-derived. Source line under the chart (provider + pool + freshness + GeckoTerminal attribution when applicable).
Page layout (src/components/trade/*): header strip, chart, Tabs [Trades, Holders, Pools, Info], sidebar (Swap preview quote panel with router label + "Open in Jupiter ↗" to https://jup.ag/swap?sell=So11111111111111111111111111111111111111112&buy=<mint> (verify the current jup.ag URL format via WebFetch; fall back to https://jup.ag/tokens/<mint>), token stats grid 5m/1h/6h/24h, risk/audit card, launchpad card with on-chain bonding progress and "≈ X SOL to graduation (before fees)" computed from reserves (constant product: k = vQ·vT; SOL needed = k/(vT − realT) − vQ), creator link, explorer links, watch star). Trades table per brief with filters (min USD, buys/sells) and new-row flash; wallet → /wallet/[addr]; signature → Solscan. Responsive stacking < 1024 px. Error boundary per panel.
Tests (token.test.ts): primary pool selection, overview merge precedence, MC-at-trade computation, quote amountRaw conversion, graduation SOL calculation.`,
  },
  {
    key: 'wallet-tracker',
    owned: ['src/app/wallet/**', 'src/app/tracker/**', 'src/components/wallet/**', 'src/components/tracker/**', 'src/data/hooks/usePortfolio.ts', 'src/data/hooks/useWalletActivity.ts', 'src/data/hooks/useWalletPnl.ts', 'src/data/hooks/useTrackerFeed.ts', 'src/lib/services/wallet.ts', 'src/lib/services/wallet.test.ts'],
    spec: `OWNER (2026-09-29 09:00): do not add disclaimer copy anywhere (no 'No custody', 'Not financial advice', 'read-only', 'does not hold funds', 'no trade execution' lines); remove any you find in your owned files. src/lib/services/discover.test.ts currently fails because discover.ts changed the default list: keep code and tests consistent.
Build /wallet/[address] (wallet analytics) and /tracker (live wallet tracker) per the design brief. Validate addresses (isSolanaAddress; invalid → notFound()).
Data hooks:
- usePortfolio(address): runChain [server portfolio proxy (/api/v1/wallet/[a]/portfolio — RPC, always available), jup.getPortfolio (keyless browser fallback)] every 30 s; then price unpriced tokens in the browser: jup.getPrices (≤50 per call; price at most the first 150 mints — prefer ones with metadata; note if more were skipped) + SOL via useSolPrice; metadata (symbol/name/logo) via jup.getRows (≤100). Compute valueUsd/totalUsd only from priced holdings; pricedCount/unpricedCount honest.
- useWalletActivity(address): useInfiniteQuery over the server activity proxy (page size 15; nextCursor → before); first page refetched every 20 s (merge by signature). Show "scanned N signatures" per page.
- useWalletPnl(address): progressive analysis: fetch activity pages until 3 pages (or history exhausted) automatically, then "Analyze more" loads 3 more pages per click (cap 30 pages). Current prices for unrealized: token USD price (jup.getPrices) ÷ SOL USD → priceSol. computePnl (src/lib/analytics/pnl.ts) with historyComplete = !nextCursor. Show the caveats, method (FIFO, SOL-denominated), window (from/to, transactions analysed), and ≈USD conversions labelled "at current SOL price".
- useTrackerFeed(wallets): per tracked wallet (usePreferences().trackedWallets): backfill latest 10 activities via the activity proxy (stagger initial requests 300 ms apart); live via useLogsSubscription(address) (src/client/hooks/useSolanaSubscriptions.ts): on a notification with err === null fetch /api/v1/tx/[signature]?wallet=address (server proxy) and prepend (dedupe by signature+wallet); reconciliation poll every 90 s per wallet (limit 5, staggered) because the browser WS is best-effort. Symbols/logos via jup.getRows for feed mints (cached). USD estimate = solAmount × current SOL price labelled "≈ now". Expose per-wallet status (subscribed / polling only / error).
UI:
- /wallet/[address]: header (address mono + copy + Solscan, Track/Untrack toggle via usePreferences addWallet/removeWallet, SOL balance, portfolio value with "N unpriced"), PnL summary cards (realized SOL + ≈USD, unrealized, win rate, winners/losers, trades, volume, avg hold) with a coverage banner, Tabs [Holdings, Activity, PnL]. Holdings table (token, balance, price, value, share bar, link to /trade). Activity feed (kind badge with icon + text, token avatar/symbol linking to /trade, amounts, SOL, time with exact on hover, program label, TxLink; "Load older"). PnL table per token (bought/sold amounts, cost, proceeds, realized, remaining, unrealized, avg hold, basis-complete badge, expandable audit list of signatures linking to Solscan). Honest empty/error states; FreshnessBadge per panel.
- /tracker: left panel wallet list (inline label edit, remove with confirm-in-place, link to /wallet, per-wallet live status dot), add form (address + optional label; validation message from usePreferences.addWallet); right panel merged live feed (newest first, slide-in, filters by wallet and kind, pause-on-hover), status line "Live via Solana log subscriptions (best effort) + reconciliation every 90 s". Empty state guiding the user to add a wallet. Hydration-safe (tracked wallets are browser-local).
Tests (wallet.test.ts): portfolio pricing/totals honesty (unpriced excluded), tracker dedupe/merge ordering, pnl input assembly.`,
  },
]

function buildPrompt(s) {
  const lead = s.mode === 'complete' ? 'COMPLETION TASK: an earlier agent partially built this slice and was interrupted (usage limit). Inspect every existing file in your owned paths first, keep what is correct, and COMPLETE the slice to the full specification below (pages must be fully wired — no placeholder pages). ' : '';
  return `${PREAMBLE}

${lead}YOUR SLICE: ${s.key}. OWNED PATHS: ${s.owned.join(', ')}

${s.spec}

Return the structured report.`
}

function reviewPrompt(s, impl) {
  return `${PREAMBLE}

You are the INDEPENDENT REVIEWER for slice "${s.key}" (OWNED PATHS: ${s.owned.join(', ')}). Another agent just built it; you now own these paths. Be adversarial — assume defects exist — and FIX them directly.

Builder's report:
${JSON.stringify(impl, null, 1).slice(0, 12000)}

Specification:
${s.spec}

Checklist:
1. Real-data integrity: any fabricated, placeholder, randomized, hardcoded or zero-filled market value? Any "LIVE" label on non-stream data? Any metric shown without a real source? Unknown must render "—".
2. Data flow: correct sources/order per the architecture rules; server-proxy used only when capabilities say so; 501 handled silently; polling cadence within keyless budgets (count requests per minute per page and fix overruns); cleanup of intervals/subscriptions on unmount; AbortSignal passed through.
3. Correctness: units (ms vs s, SOL vs lamports, 0-100 %), sorting, dedupe, pagination, stale-closure bugs in hooks, React key stability, StrictMode double-mount safety, hydration mismatches (browser-only state behind useHydrated), Next 16 async params.
4. UX states: loading skeletons, empty and error states per panel, error boundaries, freshness badges, attribution lines (GeckoTerminal/Jupiter router label/TradingView), keyboard/a11y (aria-sort, labels), responsive at 360/1024/1440 px.
5. Security: no secrets client-side, 'server-only' on server modules, input validation on routes (addresses, enums, limits), no SSRF (never fetch arbitrary user URLs server-side), no dangerouslySetInnerHTML with provider data, external links rel="noopener noreferrer".
6. Tests meaningful and compiling.
Then run npx tsc --noEmit, npx eslint <paths>, npx vitest run <paths> (all clean for your paths). Return the structured review.`
}

const ACTIVE = SLICES.filter((s) => MODES[s.key]).map((s) => ({ ...s, mode: MODES[s.key] }))
const results = await pipeline(
  ACTIVE,
  (s) => s.mode === 'review' ? Promise.resolve({ note: 'Review-only pass: the slice was built earlier; no builder report is available. Read the code and tests directly.' }) : agent(buildPrompt(s), { label: `build:${s.key}`, phase: 'Build', schema: REPORT_SCHEMA }),
  (impl, s) => agent(reviewPrompt(s, impl), { label: `review:${s.key}`, phase: 'Review', schema: REVIEW_SCHEMA }).then((review) => ({ key: s.key, impl, review })),
)
return results.filter(Boolean)
