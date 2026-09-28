import type { Metadata } from 'next';
import { PulseView } from '@/components/pulse/PulseView';

export const metadata: Metadata = {
  title: 'Pulse',
  description: 'Real-time Solana launch scanner: new launchpad pairs, bonding curves in their final stretch and fresh migrations from live stream and on-chain data.',
};

export default function PulsePage() {
  return <PulseView />;
}
