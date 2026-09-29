# Project continuity

Read `PROGRESS.md` and `README.md` before making changes. Update `PROGRESS.md` after meaningful work, including validation, deployment status, blockers, and the next concrete step. Preserve the user's scope: **live Solana market data plus the central deposit address**, without fabricated prices, fake balances, or simulated trade execution.

**Deposit address (owner's, do not change):** the site-wide deposit address is `8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3`, defined in `src/config/site.ts`. It belongs to the repository owner. Never replace, rotate, or "fix" it, and never add UI, environment or storage paths that let anyone else change it (the old per-browser edit was removed at the owner's request).

This project uses Vercel and the GitHub repository documented in `PROGRESS.md`. Do not migrate it to another host without a user request. Preserve the configured public receiving address unless the user requests a change. Never commit tokens, private keys, seed phrases, `.env` files, or `.vercel` credentials. Do not overwrite concurrent user changes. Keep market-provider errors visible and distinguish verified facts from pending setup.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
