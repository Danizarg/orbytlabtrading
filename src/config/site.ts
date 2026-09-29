/**
 * Public site configuration.
 *
 * `depositAddress` is ORBYT's central deposit address, a public Solana address
 * owned by the site owner. It is the same for every visitor and cannot be
 * changed from the UI or through environment variables. Only the owner may
 * change this constant. Never put a private key or seed phrase anywhere in
 * this repository.
 */
export const SITE = {
  name: 'ORBYT',
  fullName: 'Orbyt AI Trading',
  tagline: 'Solana trading terminal',
  url: 'https://www.orbytai.org',
  depositAddress: '8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3',
} as const;
