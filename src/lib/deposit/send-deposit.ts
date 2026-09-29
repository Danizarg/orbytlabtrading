import { PUBLIC_ENDPOINTS } from '@/lib/config/capabilities';
import { buildSolTransferTransaction } from './build-transaction';

/** Fee of a one-signature transaction; the deposit leaves nothing else behind. */
export const FEE_LAMPORTS = 5_000n;

export type WalletChain = 'solana:mainnet' | 'solana:devnet' | 'solana:testnet';

/** The cluster the configured browser RPC belongs to (devnet/testnet URLs are recognisable; anything else is mainnet). */
export function chainForRpc(url: string): WalletChain {
  if (/devnet/i.test(url)) return 'solana:devnet';
  if (/testnet/i.test(url)) return 'solana:testnet';
  return 'solana:mainnet';
}

export const DEPOSIT_CHAIN = chainForRpc(PUBLIC_ENDPOINTS.solanaRpc);

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(PUBLIC_ENDPOINTS.solanaRpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? 'Solana RPC error');
  return json.result as T;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Build the transfer of the whole balance (minus the fee) with a fresh blockhash. */
export async function prepareDeposit(from: string, to: string, balanceLamports: bigint): Promise<Uint8Array> {
  const lamports = balanceLamports - FEE_LAMPORTS;
  if (lamports <= 0n) throw new Error('Balance is too small to cover the network fee.');
  const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return buildSolTransferTransaction(from, to, lamports, value.blockhash);
}

/** Send a wallet-signed transaction and wait until it is confirmed. Returns the signature. */
export async function submitAndConfirm(signed: Uint8Array): Promise<string> {
  const signature = await rpc<string>('sendTransaction', [
    toBase64(signed),
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const { value } = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[signature]]);
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature;
  }
  throw new Error(`Not confirmed after 60 s. Check signature ${signature} on a block explorer.`);
}
