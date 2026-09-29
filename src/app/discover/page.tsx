import type { Metadata } from 'next';
import { DiscoverView } from '@/components/discover/DiscoverView';

export const metadata: Metadata = {
  title: 'Discover',
  description:
    'Solana tokens from Jupiter, GeckoTerminal and DEX Screener lists: price, market cap, liquidity, volume, transactions, holder concentration and launch stage.',
};

export default async function Page({ searchParams }: PageProps<'/discover'>) {
  // The view is driven by the URL (list, window, filters): render per request so
  // useSearchParams is available during the server render.
  await searchParams;
  return <DiscoverView />;
}
