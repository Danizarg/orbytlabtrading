# Orbyt AI Trading

An Axiom-inspired, responsive Solana market dashboard with real GeckoTerminal data and an editable receiving address.

**New assistant? Read [PROGRESS.md](PROGRESS.md) first.** It records the scope, architecture, validation, deployment status, and next steps for Claude, ChatGPT, or another development environment.

## Run

Requires Node.js 20 or later. There are no runtime package dependencies.

```sh
npm run dev
npm run check
```

Open the URL printed by the development server (normally http://127.0.0.1:4173). Refresh after static-file edits. Set the `PORT` environment variable if that port is occupied.

## Live market data

- Trending Solana pools and newly created pairs
- Search by token name or contract address
- Real price, market cap, liquidity, volume, and transaction counts
- On-chain candlesticks and recent trades linked to Solscan
- 30-second refresh while visible, pause, manual refresh, and a local watchlist
- Clear missing-data, rate-limit, and delayed-data states; no simulated fallback

Data source: [GeckoTerminal public API](https://api.geckoterminal.com/docs/index.html). Provider caching and delays apply. Gainers sorts the current trending-pool sample, not every token on Solana.

## Receiving address

- **All visitors:** edit `depositAddress` in `dist/config.js`, commit, push, and deploy.
- **This browser:** use **Deposit → Edit**. This overrides the site default only on the current browser/origin.
- **Restore site default:** choose **Use site default** in the address dialog.

The user-configured public address has been preserved. Never enter a seed phrase or private key. Transfers go to the displayed address. The app does not hold funds, verify deposits, credit balances, or execute trades.

## Deploy on Vercel

Repository: https://github.com/Danizarg/orbytlabtrading

Import the repository into your Vercel account. `vercel.json` selects the `dist` output folder and runs `npm run build` (syntax validation only). Framework preset: **Other**. No environment variables or API keys are required. Keep the root directory at the repository root.

For CLI deployment after authentication:

```sh
npx vercel login
npx vercel link
npx vercel --prod
```

Primary intended domain: **www.orbytai.org**. Add it in the Vercel project's Domains settings and use the exact DNS records Vercel supplies. Domain metadata in the HTML does not configure DNS. See PROGRESS.md for the verified current status.

## Portability

Clone the repo or give another assistant the complete folder plus `PROGRESS.md`. No OpenAI, ChatGPT, or Claude account integration is required. Vercel account authentication and domain ownership are handled separately. Browser-local watchlists and address overrides do not transfer; the public default address does.
