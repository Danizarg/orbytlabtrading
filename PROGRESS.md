# Orbyt AI Trading — progress and assistant handoff

Last updated: 2026-09-28 (Europe/Madrid).

## Start here in Claude, ChatGPT, or another coding assistant

Clone https://github.com/Danizarg/orbytlabtrading.git, then read this file and `README.md`. Treat this repository as the source of truth. The app is ordinary HTML, CSS, and JavaScript: it has no dependency on the originating assistant, its account, or its hosting service. Give a new assistant access to the repository or upload the complete project folder, not just this file, when asking it to edit the application.

Suggested continuation prompt:

> Continue work on Orbyt AI Trading in this repository. Read AGENTS.md, PROGRESS.md, and README.md first. Preserve the real-data-only behavior and configured public deposit address. Check Git status and current Vercel deployment before changing anything. Complete outstanding tasks, run npm run check, and update PROGRESS.md with verified results. Never claim deployment or DNS setup succeeded without checking it.

## User requirements and decisions

- A dark, Axiom-inspired memecoin market website, branded **Orbyt AI Trading**.
- Real, live Solana tokens, prices, candlesticks, and on-chain transactions; the initial simulated prototype was explicitly rejected.
- User chose **Live markets + editable deposit address**, rather than wallet-connected swaps.
- Repository: `https://github.com/Danizarg/orbytlabtrading.git`.
- Hosting requested: **Vercel**. Intended primary domain: `https://www.orbytai.org`.
- The receiving address was configured by the user in `dist/config.js` and must be preserved. It is a public address, not a secret.
- Include this progress file so development can move between assistants/accounts.

## Implemented

- Responsive dark terminal with Orbyt branding, a custom favicon, title, and canonical domain metadata.
- GeckoTerminal public API: trending Solana pools, new pools, token/address search, pool statistics, OHLCV candles, and recent trades.
- Chart intervals: 1m, 5m, 15m, 1h, 4h, and 1D. Source timestamps and real transaction links to Solscan.
- Automatic 30-second refresh while the tab is visible, manual refresh, pause, request caching/deduplication, timeout handling, and rate-limit backoff.
- No fabricated data on API failure. Provider failures and delayed updates are explicitly shown.
- Gainers sorts the current trending-pool sample; it is not an exhaustive network-wide ranking. Tokens may have several pools, which are tracked by unique pool address.
- Device-local watchlist of up to 30 pools, refreshed through the multi-pool API.
- Deposit panel: editable public Solana address, 32-byte base58 validation, copy, and Solscan link. Local overrides are labeled as browser-only.
- Site-wide default receiving address is in `dist/config.js` as `window.ORBYT_CONFIG.depositAddress`.
- Dependency-free local server and syntax checks, Vercel static output configuration, and assistant handoff instructions.

## Architecture and file map

| File | Purpose |
| --- | --- |
| `dist/index.html` | Page structure, metadata, address dialog |
| `dist/style.css` | Responsive terminal styling |
| `dist/app.js` | Live API integration, charts, watchlists, address settings |
| `dist/config.js` | Public, site-wide receiving address |
| `dist/favicon.svg` | Orbyt mark |
| `scripts/serve.cjs` | Local static server, port 4173 by default |
| `package.json` | `dev`, `check`, and `build` scripts |
| `vercel.json` | Static deployment, output directory `dist` |
| `AGENTS.md` | Continuity instructions |

No runtime API keys, backend database, wallet connection, or paid dependencies are required. Google Fonts and token-provider images are loaded remotely. GeckoTerminal data is subject to its cache, availability, CORS policy, and rate limits. API documentation: https://api.geckoterminal.com/docs/index.html.

## Financial behavior: preserve these boundaries

The website displays market information and a receiving address. It **does not execute swaps, hold funds, monitor/verify deposits, create user accounts, credit trading balances, or process withdrawals**. The brand includes “AI” because the user requested that name; no AI model or automated trading system is implemented. Do not imply otherwise in the UI or handoff.

## Validation completed before the hosting migration

- Verified live API responses for trending pools, candlesticks, recent trades, and saved-pool lookup.
- Browser verified live tokens/prices, candlestick rendering, real transaction links, token selection, interval switching, pool statistics, and live token search.
- Invalid receiving-address input was rejected; existing receiving address preserved.
- Mobile viewport checked with no page-level horizontal overflow.
- Browser console reported no JavaScript errors during checks.
- Syntax checks passed on the live-data app.

## GitHub, Vercel, and domain status

- GitHub repository was reachable and empty when cloned on 2026-09-28.
- Local branch: `main`; remote `origin` points to the requested GitHub repository.
- GitHub initial push: pending at this checkpoint.
- Vercel authentication, project creation/linking, production deploy, Git integration, and custom-domain attachment: pending at this checkpoint.
- `www.orbytai.org` and apex DNS records have not yet been changed. Do not assume the canonical HTML metadata configures DNS.
- An earlier prototype was registered with the original assistant's Sites service; its registration is deliberately omitted from this Vercel project. Vercel is the requested host going forward.

## Next steps

1. Run `npm run check` in this repository; commit and push `main` to the requested GitHub remote.
2. Authenticate with Vercel using the user's own account if necessary. Do not request access tokens in chat or commit credentials.
3. Import/connect `Danizarg/orbytlabtrading` to Vercel. Framework: Other; output: `dist`; build: `npm run build`.
4. Deploy production and verify the returned deployment URL and live-data loading.
5. Add `www.orbytai.org` to the project. Use the exact DNS values Vercel supplies; inspect existing DNS first and preserve unrelated email/TXT records. Optionally redirect the apex only after confirming the desired domain setup.
6. Update this file with actual deployment URLs, completed steps, remaining DNS requirements, and verification evidence; commit and push that update.

## Continue locally

Use Node.js 20 or later. Run `npm run dev` and open the printed local URL. No dependencies need installing. Run `npm run check` before committing. Edits to static files require a browser refresh. A receiving-address override is local to one origin/browser and does not travel with the repo; the default in `dist/config.js` does.
