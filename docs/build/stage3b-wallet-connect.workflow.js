export const meta = {
  name: 'orbyt-wallet-connect',
  description: 'Add Phantom / Wallet Standard connection, Sign-In With Solana (server-verified), header wallet menu and a Jupiter swap execution module',
  phases: [
    { title: 'Build', detail: 'wallet connection, SIWS auth routes, header menu, swap execution module' },
    { title: 'Review', detail: 'adversarial security + UX review and fixes' },
  ],
}

const SPEC = `You are adding wallet connection to ORBYT, a real-data Solana trading terminal, in the current repository root (Next.js 16 App Router, React 19, TypeScript 5.9 strict + noUncheckedIndexedAccess, Tailwind v4 with tokens in src/app/globals.css, Inter font, zustand 5, @tanstack/react-query 5, @solana/kit 8.4, Vitest 5). Other agents are concurrently editing src/components/trade/**, src/components/wallet/**, src/components/tracker/**, src/components/discover/**, src/components/pulse/**, src/data/hooks/**, src/lib/services/** — do NOT touch those. Read AGENTS.md, PROGRESS.md, docs/DESIGN_BRIEF.md, src/components/shell/AppShell.tsx, src/components/shell/DepositDialog.tsx (visual reference), src/lib/core/solana.ts, src/client/store/preferences.ts, src/lib/server/respond.ts, src/lib/server/env.ts, src/lib/net/browser.ts, src/lib/providers/jupiter/*, src/data/sources.ts before starting.

OWNER REQUEST: "add a wallet so you can add your Phantom or sign in using Phantom, so the user signs with Phantom and the Phantom wallet is connected to the site." Also the trade panel must become Axiom-like with in-app trading once a wallet is connected.

INSTALLED PACKAGES (do not install others): @wallet-standard/app 1.1.1 (getWallets), @wallet-standard/base, @wallet-standard/features (standard:connect/disconnect/events), @solana/wallet-standard-features 1.5.0 (solana:signIn, solana:signMessage, solana:signTransaction, solana:signAndSendTransaction), @solana/kit (address/codec helpers, verifySignature/getPublicKeyFromAddress or WebCrypto Ed25519 on the server).

BUILD (owned paths: src/lib/wallet/**, src/components/connect/**, src/app/api/v1/auth/**, src/lib/swap/**, src/components/shell/AppShell.tsx (only to mount the connect button next to Deposit), .env.example (only to add AUTH_SECRET docs)):
1. src/lib/wallet/ — framework-agnostic wallet layer on Wallet Standard: discover wallets via getWallets() (listen to 'register'/'unregister'), filter to wallets supporting solana:mainnet + standard:connect; order Phantom first, then Solflare, Backpack, others. Connect (standard:connect, silent option for auto-reconnect of the last used wallet stored in localStorage key 'orbyt-wallet-v1'), disconnect, listen to standard:events 'change' (account switch / disconnect), expose selected account address. signMessage (solana:signMessage), signIn (solana:signIn when supported, else build a Sign-In With Solana (EIP-4361-style / CAIP-122) message and use signMessage), signTransaction (solana:signTransaction, chain 'solana:mainnet'). Zustand store (src/lib/wallet/store.ts) with status: 'idle'|'connecting'|'connected'|'signing'|'error', wallets list, account, verified (server-verified sign-in) flag, error. All wallet calls wrapped with user-safe errors (user rejected → quiet message, not an error banner).
2. Sign-In With Solana: GET /api/v1/auth/nonce → { nonce, issuedAt, expiresAt, domain, uri, statement }. When AUTH_SECRET is set, the nonce is an HMAC-signed token (stateless) including expiry; without it, a random nonce with issuedAt/expiry is still returned. POST /api/v1/auth/verify with { address, signedMessage (base64 of exact bytes signed), signature (base64) } → validate the address, parse the message and check: domain equals the request host, address matches, nonce valid (HMAC + not expired when AUTH_SECRET set; issuedAt within 10 min otherwise), chain mainnet; verify the Ed25519 signature on the server (WebCrypto Ed25519 via @solana/kit getPublicKeyFromAddress + verifySignature, or crypto.subtle directly). On success: when AUTH_SECRET is set, set an HttpOnly, Secure (in production), SameSite=Lax cookie 'orbyt_session' = HMAC-signed { address, exp (7 days) }; respond { address, verified: true, session: boolean }. GET /api/v1/auth/session → { address } | null (verifies the cookie). POST /api/v1/auth/logout → clears the cookie. Never log signatures; rate-limit-friendly; no-store caching. Unit-test the message builder/parser, nonce signing/expiry, cookie signing/verification and signature verification with a generated Ed25519 keypair (WebCrypto in Node 24).
3. src/components/connect/ — ConnectWalletButton for the header (left of Deposit): disconnected → "Connect" button (outline style, wallet icon); click → a compact dialog/popover listing detected wallets with their icons (wallet.icon data URIs) and names, "Installed" tags; when no wallet is detected: "Get Phantom" link to https://phantom.app/download and, on mobile user agents, "Open in Phantom" deep link https://phantom.app/ul/browse/<encodeURIComponent(current URL)>?ref=<encodeURIComponent(origin)>. After connect, automatically request the sign-in signature ("Sign in with Phantom" step with a clear explanation: signing a message proves ownership, costs nothing, sends no transaction); allow "Skip" (stay connected, unverified). Connected → pill with wallet icon, short address, verified check when signed in; menu: SOL balance (read via the browser RPC in src/data/sources.ts browserRpc.getBalance with a server fallback /api/v1/wallet/[address]/portfolio), "Portfolio" (/wallet/<address>), "Track wallet" (usePreferences addWallet), "Copy address", "Sign in" (if not verified), "Disconnect". Institutional look matching the header (h-8 controls, hairline borders, no gradients except the wallet's own icon). Hydration-safe. Keyboard accessible (Esc closes, focus trap in dialog).
4. src/lib/swap/ — Jupiter swap execution for the trade panel (non-custodial; the user's wallet signs): buildOrder({ inputMint, outputMint, amountRaw, taker, slippageBps? }) → GET https://api.jup.ag/swap/v2/order with taker (keyless allowed; consult docs/research/jupiter.json and developers.jup.ag docs via WebFetch for the CURRENT order/execute contract: response transaction base64 + requestId, errorCode/errorMessage on unbuildable quotes) returning a typed order (inAmount, outAmount, priceImpact, router label, feeBps, transaction bytes, requestId, expiry if any); executeOrder({ signedTransaction bytes, requestId }) → POST /swap/v2/execute → { status, signature, code, error } mapped to typed results; a helper swap(order, signTransaction) that signs via the wallet layer and executes, returning { signature, status }. Validate everything; surface Jupiter errors verbatim-but-safe; never retry an execute automatically (double-spend risk); label router per licence ("Jupiter Ultra"). Unit tests with mocked fetch covering success, unbuildable quote, execute failure, user rejection.
Everything real: no mocked balances or fake success. Verify: npx tsc --noEmit (fix errors in your files; other agents' files may be mid-edit), npx eslint <your paths>, npx vitest run <your paths>. No git, no npm install, no dev server start (one is already running at http://localhost:3000 — you MAY use the mcp__Claude_Browser__* tools to check the header button renders and the dialog opens; no wallet extension exists in that browser, so verify the no-wallet state).`

const SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    exports: { type: 'string', description: 'Public API with signatures (wallet store/hooks, swap module, routes)' },
    verification: { type: 'string' },
    caveats: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'summary', 'exports', 'verification', 'caveats'],
}

phase('Build')
const built = await agent(SPEC, { label: 'build:wallet-connect', phase: 'Build', schema: SCHEMA })

phase('Review')
const reviewed = await agent(`${SPEC}

You are now the INDEPENDENT ADVERSARIAL REVIEWER of this feature (same owned paths). The builder reported:
${JSON.stringify(built, null, 1).slice(0, 10000)}

Review for: signature verification correctness (exact signed bytes, Ed25519 public key from base58 address, reject malformed/long inputs), SIWS message parsing (domain binding to request host, nonce expiry, replay within window, address mismatch), cookie security (HttpOnly, Secure in prod, SameSite, HMAC with timing-safe compare, expiry), secrets never exposed (AUTH_SECRET server-only), wallet-standard event handling (account change, disconnect, unregister), auto-reconnect only silent, user-rejection handling, hydration safety, a11y of the dialog/menu, swap module correctness against the CURRENT Jupiter docs (verify with WebFetch) — especially never auto-retrying execute, correct base64 handling of transaction bytes, taker set, error mapping. Fix every defect directly, add tests for each fix, then run tsc/eslint/vitest for your paths. Return the same structured report (files, summary of defects fixed, exports, verification, caveats).`, { label: 'review:wallet-connect', phase: 'Review', schema: SCHEMA })

return { built, reviewed }
