# ORBYT UI design brief (for implementation agents)

ORBYT is a dark, dense, professional Solana trading terminal in the Axiom / GMGN class. Information density beats whitespace, but everything stays aligned, legible and calm. The brand is the existing Orbyt palette: purple brand #a895ff, mint "up" #69e6b2, rose "down" #fa788d on near-black panels. Use ONLY the design tokens in src/app/globals.css (Tailwind v4 `@theme`): bg, panel, panel-2, panel-3, hover, line, line-strong, fg, fg-dim, muted, faint, brand, brand-strong, brand-soft, up, up-soft, down, down-soft, warn, warn-soft, info. Fonts: Inter (font-sans and font-display) for all UI text and numbers with tabular figures, JetBrains Mono (font-mono) for addresses and signatures. No other fonts.

## Principles
1. **Real data or an honest gap.** A missing metric renders "—" (formatters in src/lib/core/format.ts already do this). Never show 0 for unknown. A delayed source is labelled as delayed.
2. **Freshness is visible.** Every live panel shows a FreshnessBadge (src/components/ui/FreshnessBadge.tsx). Use `live` only for stream-fed or on-chain realtime data. Indexed sources show their age, e.g. "12s ago". Where useful, the badge title carries the source name.
3. **Provenance is visible but quiet.** Put a small "Source: Jupiter · GeckoTerminal" line in panel footers or tooltips. Attribution text required by licences: "On-chain data powered by GeckoTerminal" near GeckoTerminal-sourced tables and charts. Quote panels must label the router exactly as the adapter returns it ("Metis" / "Jupiter Ultra"). TradingView attribution stays on in the chart (attributionLogo). DEX Screener gets plain text only, never its logo.
4. **Live updates are local.** Update rows and cells in place and never reload whole views. Flash changed prices (useFlash hook), slide new rows in (animate-slide-in), and keep scroll position stable when new items arrive at the top. For Pulse, pause insertion while the pointer hovers a column and show "Paused".
5. **Degrade gracefully.** Each panel owns its loading skeleton (Skeleton), empty state (EmptyState) and error state. One failing provider never blanks the page. Wrap each major panel in an error boundary. Error copy is short and factual ("GeckoTerminal is rate limiting this browser; retrying in 20 s").
6. **Keyboard and accessibility.** "/" focuses the search box. Tables use real <table> semantics with sortable <th> buttons carrying aria-sort. Tabs use the Tabs primitive. Links are real <a>/<Link> elements, so rows that navigate use a Link on the token cell and an onClick on the row that respects modifier keys. Focus rings come from globals. Colour is never the only signal: Buy/Sell have text labels.
7. **Responsive.** Desktop is ≥1280 px (primary). Laptop is 1024 px. Mobile is ≥360 px: tables scroll horizontally inside their panel, the trade page stacks (chart, stats, tabs), and Pulse becomes a column switcher (tabs) instead of three columns.

## Shared primitives (already in src/components/ui)
Panel, Tabs, Skeleton, EmptyState, Change, FreshnessBadge, TokenAvatar (with bonding progress ring), CopyButton, WalletLink/TxLink (AddressLink.tsx). Reuse them and extend in feature folders when needed. Don't fork primitives.

## Pages
### Global shell
- **Header (48 px):**
  - Logo · Nav (Discover, Pulse, Tracker, Watchlist).
  - Global search (center): accepts a name, symbol or mint. The dropdown shows token hits (avatar, symbol, name, MC, liquidity, verified badge). If the input is a valid address, it offers "Open token" and "Open wallet". Enter opens the first hit.
  - Right side: SOL price chip (◎ $x.xx ±%), stream status dot (popover lists PumpPortal / Solana WS / provider health with cooldowns), Deposit button (existing).
- **Status bar (28 px, bottom, sticky):** provider health dots, the data attribution line.

### /discover
- **Title row:** "Discover" + list Tabs [Trending, Top volume, Organic, New, Gainers] + window Tabs [5m, 1h, 6h, 24h] + filters popover (min liquidity, min MC, max age, launch stage, hide flagged) + FreshnessBadge.
- **Dense sortable table:** # · Token (avatar with progress ring when bonding, symbol, name, age, short mint + copy, social icons, launchpad badge) · Price · Change(window) · MC · Liquidity · Volume(window) · Txns(window) as buys/sells with a thin ratio bar · Traders · Holders · Top10% · Dev% · Snipers% · Insiders% · Bundlers% · DEX · ☆ watch. Risk percentages turn warn/down above thresholds (top10 > 30 warn, > 50 danger; dev > 10 warn; snipers/insiders/bundlers > 20 warn).
- Rows link to /trade/[mint]. Gainers = the current list sorted by change, labelled "sorted sample".

### /watchlist
Same table fed by the user's watchlist, with an empty state that explains how to star tokens.

### /pulse
- **Three columns:** New Pairs · Final Stretch · Migrated.
  - Each column header shows a count, FreshnessBadge (LIVE when the PumpPortal stream is open), a filter button (min MC, launchpad pump/bonk/all, require socials) and hover-pause.
- **Cards (≈ 88 px tall):**
  - Left: avatar with progress ring.
  - Middle: symbol (bold) and name (dim), age ticking live, short mint copy, social icons, creator short link.
  - Right: MC (big), V (volume), TX buys/sells, holders.
  - Bottom strip: progress %, dev buy SOL, top10%, dev%, snipers%, insiders%, bundlers%. Show "—" when unknown.
  - Click opens /trade/[mint].
- New cards slide in. Migrated cards show "migrated Xs ago" and the destination DEX.
- Mobile: a column switcher.

### /trade/[mint]
- **Header strip:** avatar, symbol, name, verified badge, short mint + copy, age, socials, explorer links (Solscan, GeckoTerminal, DEX Screener, Jupiter), watch star. Big price + change. Stat pills: MC, FDV, Liquidity, Vol 24h, Holders, Supply. FreshnessBadge.
- **Main (left):**
  - Chart panel: interval buttons [1s 5s 15s 1m 5m 15m 1h 4h 1D]. Unsupported intervals are disabled with an explanatory tooltip; trade-derived ones are marked with a dot.
  - Price/MC toggle (MC = price × on-chain supply, only when supply is known), OHLCV legend following the crosshair, and a source line ("GeckoTerminal OHLCV · Raydium CPMM pool …" or "Built from 214 real trades since 12:01:03").
  - Below: Tabs [Trades, Holders, Pools, Info].
    - Trades: time (age; exact on hover), side, price USD, amount, SOL, USD, MC at trade if known, wallet link, tx link. Filters: min USD, buys/sells. New rows flash.
- **Sidebar (right, 320 px):**
  - "Swap preview" read-only quote panel: Buy/Sell toggle, SOL amount presets, token output, price impact, route labels, router label, "Open in Jupiter ↗". State plainly that ORBYT does not execute trades.
  - Token stats: a 5m/1h/6h/24h grid of change, volume, buys, sells, traders.
  - Audit/risk card: flags list with levels.
  - Launchpad card: bonding progress bar from on-chain data, "complete"/"migrated to X" state, creator link.
  - Deposit shortcut.

### /wallet/[address]
- **Header:** address (mono, copy, Solscan), "Track wallet" toggle (tracker store), SOL balance, portfolio value (priced subtotal + "N tokens unpriced").
- **PnL summary cards:** realized (SOL, ≈USD at current SOL price, labelled), unrealized, win rate, winners/losers, trades, volume, avg hold. Show a coverage banner: "Based on N transactions (history incomplete) · Analyze more".
- **Tabs:**
  - Holdings: token, balance, price, value, share bar, trade link.
  - Activity: kind badge, token, amounts, SOL, USD est., time, tx link; infinite "Load older".
  - PnL: a per-token table with a basis-complete badge and an expandable signature audit list.

### /tracker
- **Left:** tracked wallets (label inline-editable, address, remove, link to /wallet). Add form (address + label, validated).
- **Right:** live merged activity feed across tracked wallets (newest first), filter by wallet/kind, and a status line explaining the live mechanism: "Live via Solana log subscriptions (best effort) + reconciliation every 90 s". New rows slide in.

## Motion and polish
- Keep motion subtle: 150 ms colour transitions, 900 ms price flash, 350 ms slide-in. Honour prefers-reduced-motion by disabling slide/flash (Tailwind motion-safe:).
- Every scrolling area gets thin scrollbars (global). Sticky table headers use the bg-panel background.
- Keep empty cells visually quiet: the "—" dash uses text-faint.


## Owner directives (2026-09-29)
- No disclaimer copy anywhere ("No custody", "Not financial advice", "read-only", "does not hold funds", "coming soon").
- The deposit dialog shows only the central deposit address, the owner's official QR image (public/deposit-qr.png), copy, Solscan, and a one-line network hint.
- The look should be sober, institutional and dense, like a big DEX. It must not read as an AI template.
