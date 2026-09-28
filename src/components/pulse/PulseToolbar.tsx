'use client';

import { useNow } from '@/client/hooks/useNow';
import { usePumpPortalStatus } from '@/client/hooks/usePumpPortal';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { cn } from '@/components/ui/cn';
import { usePulseStore } from '@/data/pulse/store';
import { formatAge } from '@/lib/core/format';
import type { PulseColumn } from '@/lib/core/types';
import { sourceHealth } from '@/lib/services/pulse';
import { PULSE_COLUMNS } from './columns';

const COLUMN_TABS: readonly TabItem<PulseColumn>[] = PULSE_COLUMNS.map((c) => ({ value: c.id, label: c.short }));

function StreamStatus() {
  const s = usePumpPortalStatus();
  const now = useNow();
  let dot: string;
  let label: string;
  switch (s.status) {
    case 'open':
      dot = 'bg-up animate-pulse-dot';
      label = 'Live';
      break;
    case 'connecting':
      dot = 'bg-faint';
      label = 'Connecting';
      break;
    case 'reconnecting':
      dot = 'bg-warn';
      label = s.nextRetryAt && now ? `Retry in ${Math.max(0, Math.ceil((s.nextRetryAt - now) / 1000))} s` : 'Reconnecting';
      break;
    default:
      dot = s.consumers > 0 ? 'bg-down' : 'bg-faint';
      label = s.consumers > 0 ? 'Offline' : 'Idle';
  }
  const detail = s.lastServerError ?? s.lastError;
  return (
    <span className="inline-flex items-center gap-1.5" title={`PumpPortal WebSocket: pump.fun creates and migrations${detail ? ` · ${detail}` : ''}`}>
      <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />
      <span className="text-muted">PumpPortal</span>
      <span className={cn('font-semibold', s.status === 'open' ? 'text-fg-dim' : s.status === 'reconnecting' ? 'text-warn' : 'text-muted')}>{label}</span>
    </span>
  );
}

function CurveStatus() {
  const curves = usePulseStore((s) => s.feeds.curves);
  const now = useNow();
  const health = sourceHealth([curves]);
  const dot = health.state === 'ok' ? 'bg-up' : health.state === 'error' ? 'bg-warn' : 'bg-faint';
  const title =
    health.state === 'error'
      ? (health.error ?? 'On-chain curve reads failing')
      : health.lastOkAt && now
        ? `pump.fun bonding curves decoded on-chain · last read ${formatAge(health.lastOkAt, now)} ago`
        : 'pump.fun bonding curves decoded on-chain';
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />
      <span className="text-muted">Curves</span>
      <span className={cn('font-semibold', health.state === 'error' ? 'text-warn' : 'text-fg-dim')}>
        {health.state === 'error' ? 'Degraded' : health.via ? `On-chain · ${health.via}` : 'On-chain'}
      </span>
    </span>
  );
}

export function PulseToolbar({ active, onActiveChange }: { active: PulseColumn; onActiveChange: (column: PulseColumn) => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
      <h1 className="font-display text-sm font-semibold tracking-tight text-fg">Pulse</h1>
      <Tabs items={COLUMN_TABS} value={active} onChange={onActiveChange} size="xs" ariaLabel="Pulse column" className="lg:hidden" />
      <div className="ml-auto hidden min-w-0 items-center gap-4 overflow-hidden text-2xs whitespace-nowrap md:flex">
        <StreamStatus />
        <CurveStatus />
        <span className="hidden text-faint xl:inline">
          On-chain data powered by{' '}
          <a href="https://www.geckoterminal.com/solana/pools" target="_blank" rel="noopener noreferrer" className="text-muted hover:text-fg">
            GeckoTerminal
          </a>
        </span>
      </div>
    </div>
  );
}
