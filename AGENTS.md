# Project continuity

Read `PROGRESS.md` and `README.md` before making changes. Update `PROGRESS.md` after meaningful work, including validation, deployment status, blockers, and the next concrete step. Preserve the user's scope: **live Solana market data plus an editable receiving address**, without fabricated prices, fake balances, or simulated trade execution.

**Deposit address (owner's, do not change):** the site-wide deposit address is `8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3`, defined in `src/config/site.ts`. It belongs to the repository owner. Never replace, rotate, or "fix" it, and never add code paths that change what other visitors see, unless the owner explicitly asks.

This project uses Vercel and the GitHub repository documented in `PROGRESS.md`. Do not migrate it to another host without a user request. Preserve the configured public receiving address unless the user requests a change. Never commit tokens, private keys, seed phrases, `.env` files, or `.vercel` credentials. Do not overwrite concurrent user changes. Keep market-provider errors visible and distinguish verified facts from pending setup.
