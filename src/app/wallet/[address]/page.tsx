import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WalletView } from '@/components/wallet/WalletView';
import { isSolanaAddress, shortAddress } from '@/lib/core/solana';

type Params = Promise<{ address: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { address } = await params;
  if (!isSolanaAddress(address)) return { title: 'Wallet' };
  return {
    title: `Wallet ${shortAddress(address)}`,
    description: `Holdings, activity and FIFO PnL for Solana wallet ${address}.`,
  };
}

/** Wallet analytics for one address; anything that is not a Solana address is a 404. */
export default async function Page({ params }: { params: Params }) {
  const { address } = await params;
  if (!isSolanaAddress(address)) notFound();
  return <WalletView address={address} />;
}
