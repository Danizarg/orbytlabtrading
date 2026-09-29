import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TradePage } from '@/components/trade/TradePage';
import { isSolanaAddress, shortAddress } from '@/lib/core/solana';

/** Title from the mint alone: no upstream fetch in metadata. */
export async function generateMetadata({ params }: PageProps<'/trade/[mint]'>): Promise<Metadata> {
  const { mint } = await params;
  const label = isSolanaAddress(mint) ? shortAddress(mint) : 'token';
  return {
    title: `Trade ${label}`,
    description: 'Live chart, trades, holders, pools, audit and read-only Jupiter quotes for a Solana token.',
  };
}

export default async function Page({ params, searchParams }: PageProps<'/trade/[mint]'>) {
  const { mint } = await params;
  if (!isSolanaAddress(mint)) notFound();
  // ?pool= drives the client view; render per request so useSearchParams is available during SSR.
  await searchParams;
  return <TradePage mint={mint} />;
}
