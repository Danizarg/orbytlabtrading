import type { Metadata } from 'next';
import { TrackerView } from '@/components/tracker/TrackerView';

export const metadata: Metadata = {
  title: 'Tracker',
  description: 'Follow Solana wallets live: recent activity on add, log subscriptions for new transactions, and periodic reconciliation.',
};

export default function Page() {
  return <TrackerView />;
}
