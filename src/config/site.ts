import { isSolanaAddress } from '@/lib/core/solana';

/**
 * Public site configuration.
 *
 * `DEFAULT_DEPOSIT_ADDRESS` is the site-wide public Solana receiving address
 * chosen by the owner (moved here from the original dist/config.js). It is a
 * public address, not a secret. Override per deployment with
 * NEXT_PUBLIC_DEPOSIT_ADDRESS, or per browser via the Deposit dialog.
 * Never put a private key or seed phrase anywhere in this repository.
 */
const DEFAULT_DEPOSIT_ADDRESS = '8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3';

const envDeposit = process.env.NEXT_PUBLIC_DEPOSIT_ADDRESS?.trim();

export const SITE = {
  name: 'ORBYT',
  fullName: 'Orbyt AI Trading',
  tagline: 'Live Solana trading terminal',
  url: 'https://www.orbytai.org',
  depositAddress: envDeposit && isSolanaAddress(envDeposit) ? envDeposit : DEFAULT_DEPOSIT_ADDRESS,
} as const;
