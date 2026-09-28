import type { Metadata } from 'next';
import { WatchlistView } from '@/components/discover/WatchlistView';

export const metadata: Metadata = {
  title: 'Watchlist',
  description: 'Your starred Solana tokens with live market data, stored in this browser.',
};

export default function Page() {
  return <WatchlistView />;
}
