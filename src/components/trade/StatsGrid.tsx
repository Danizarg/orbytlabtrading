'use client';

import { cn } from '@/components/ui/cn';
import { Skeleton } from '@/components/ui/Skeleton';
import { changeClass, formatCompact, formatPct, formatUsd } from '@/lib/core/format';
import { STAT_WINDOWS, type StatWindow, type TokenMarket, type WindowStats } from '@/lib/core/types';
import { Dash, Pane } from './parts';

const WINDOW_LABEL: Record<StatWindow, string> = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' };

function count(n: number | undefined) {
  return n === undefined ? <Dash /> : <span className="tabular">{formatCompact(n)}</span>;
}

interface BuyShare {
  pct: number;
  basis: 'volume' | 'trades';
}

/** Buy share of volume (falls back to trade counts, and says so) for the thin bar under each window. */
function buyShare(s: WindowStats | undefined): BuyShare | undefined {
  if (!s) return undefined;
  if (s.buyVolumeUsd !== undefined && s.sellVolumeUsd !== undefined && s.buyVolumeUsd + s.sellVolumeUsd > 0) {
    return { pct: (s.buyVolumeUsd / (s.buyVolumeUsd + s.sellVolumeUsd)) * 100, basis: 'volume' };
  }
  if (s.buys !== undefined && s.sells !== undefined && s.buys + s.sells > 0) return { pct: (s.buys / (s.buys + s.sells)) * 100, basis: 'trades' };
  return undefined;
}

/**
 * 5m / 1h / 6h / 24h grid: change, volume, buys, sells, unique traders and
 * the buy-share bar. Traders is the provider's unique-wallet count only; it
 * is never estimated from buyer / seller counts.
 */
export function StatsGrid({ market, loading = false, className }: { market?: TokenMarket; loading?: boolean; className?: string }) {
  const stats = market?.stats;
  // While the market row loads, show the grid's structure instead of "—" (which means "not reported").
  const pending = loading && !market;
  return (
    <Pane title="Stats" className={className} bodyClassName="px-3 py-2">
      <div className="grid grid-cols-4 gap-x-2 text-xs" aria-busy={pending || undefined}>
        {STAT_WINDOWS.map((w) => {
          const s = stats?.[w];
          if (pending) {
            return (
              <div key={w} className="min-w-0">
                <div className="flex items-baseline justify-between gap-1 border-b border-line pb-1">
                  <span className="text-2xs font-medium text-muted">{WINDOW_LABEL[w]}</span>
                  <Skeleton className="h-2.5 w-8" />
                </div>
                {['Vol', 'Buys', 'Sells', 'Traders'].map((label) => (
                  <Row key={label} label={label}>
                    <Skeleton className="ml-auto h-2.5 w-8" />
                  </Row>
                ))}
                <Bar />
              </div>
            );
          }
          return (
            <div key={w} className="min-w-0">
              <div className="flex items-baseline justify-between gap-1 border-b border-line pb-1">
                <span className="text-2xs font-medium text-muted">{WINDOW_LABEL[w]}</span>
                <span className={cn('tabular font-medium', changeClass(s?.priceChangePct))}>{s?.priceChangePct === undefined ? <Dash /> : formatPct(s.priceChangePct)}</span>
              </div>
              <Row label="Vol">{s?.volumeUsd === undefined ? <Dash /> : <span className="tabular">{formatUsd(s.volumeUsd)}</span>}</Row>
              <Row label="Buys">
                <span className="text-up">{count(s?.buys)}</span>
              </Row>
              <Row label="Sells">
                <span className="text-down">{count(s?.sells)}</span>
              </Row>
              <Row label="Traders">{count(s?.traders)}</Row>
              <Bar share={buyShare(s)} />
            </div>
          );
        })}
      </div>
    </Pane>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-5 items-center justify-between gap-1">
      <span className="text-2xs text-faint">{label}</span>
      <span className="min-w-0 truncate text-right text-fg-dim">{children}</span>
    </div>
  );
}

function Bar({ share }: { share?: BuyShare }) {
  return (
    <div
      aria-hidden
      className={cn('mt-1 flex h-[3px] w-full overflow-hidden rounded-full', share === undefined ? 'bg-line-strong' : 'bg-down/60')}
      title={share === undefined ? undefined : `${share.pct.toFixed(0)}% ${share.basis === 'volume' ? 'buy volume' : 'of trades are buys'}`}
    >
      {share !== undefined && <span className="h-full bg-up" style={{ width: `${share.pct}%` }} />}
    </div>
  );
}
