'use client';

import { Fragment } from 'react';
import { cn } from '@/components/ui/cn';
import { LEVEL_LABEL, type BarEntry } from './health';
import { SolPriceChip } from './SolPriceChip';
import { StatusDot } from './StatusDot';
import { useSystemHealth } from './useSystemHealth';

export const ATTRIBUTION =
  'Data: Jupiter · GeckoTerminal (on-chain data powered by GeckoTerminal) · DEX Screener · PumpPortal · Solana RPC · Charts: TradingView Lightweight Charts';
export const DISCLAIMER = 'Market data only · No custody · No trade execution · Not financial advice';

const LINKS: Partial<Record<BarEntry['id'], string>> = {
  geckoterminal: 'https://www.geckoterminal.com',
};

/**
 * Bottom status bar (28 px, sticky). Each data provider in the attribution
 * line carries its live health dot; hover for details. On narrow screens the
 * line scrolls horizontally instead of wrapping.
 */
export function StatusBar() {
  const { bar } = useSystemHealth();

  return (
    <footer className="sticky bottom-0 z-30 flex h-7 shrink-0 items-center gap-4 overflow-x-auto border-t border-line bg-panel px-3 text-2xs whitespace-nowrap text-faint scrollbar-none lg:overflow-hidden lg:px-4">
      <SolPriceChip variant="bare" className="flex sm:hidden" />
      <p className="lg:min-w-0 lg:truncate" title={ATTRIBUTION}>
        <span>Data: </span>
        {bar.map((entry, i) => (
          <Fragment key={entry.id}>
            {i > 0 && <span aria-hidden> · </span>}
            <Provider entry={entry} />
            {entry.id === 'geckoterminal' && <span> (on-chain data powered by GeckoTerminal)</span>}
          </Fragment>
        ))}
        <span aria-hidden> · </span>
        <span>
          Charts:{' '}
          <a href="https://www.tradingview.com" target="_blank" rel="noopener noreferrer" className="hover:text-fg hover:underline">
            TradingView Lightweight Charts
          </a>
        </span>
      </p>
      <p className="ml-auto shrink-0 text-muted">{DISCLAIMER}</p>
    </footer>
  );
}

function Provider({ entry }: { entry: BarEntry }) {
  const href = LINKS[entry.id];
  const body = (
    <>
      <StatusDot level={entry.level} className="mr-1 align-middle" />
      {entry.label}
      <span className="sr-only"> ({LEVEL_LABEL[entry.level]})</span>
    </>
  );
  const className = entry.level === 'degraded' ? 'text-warn' : entry.level === 'offline' ? 'text-down' : 'text-muted';
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" title={entry.title} className={cn(className, 'hover:text-fg hover:underline')}>
      {body}
    </a>
  ) : (
    <span title={entry.title} className={className}>
      {body}
    </span>
  );
}
