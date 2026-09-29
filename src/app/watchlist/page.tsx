import type { Metadata } from 'next';
import { WatchlistView } from '@/components/discover/WatchlistView';

export const metadata: Metadata = {
  title: 'Watchlist',
  description: 'Starred Solana tokens with market data, stored in this browser.',
};

export default function Page() {
  return <WatchlistView />;
}
