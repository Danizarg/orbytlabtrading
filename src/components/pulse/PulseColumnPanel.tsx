'use client';

import { Pause } from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent, type UIEvent } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { useNow } from '@/client/hooks/useNow';
import { usePumpPortalStatus } from '@/client/hooks/usePumpPortal';
import { EmptyState } from '@/components/ui/EmptyState';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { cn } from '@/components/ui/cn';
import { useSolPrice } from '@/data/hooks/useSolPrice';
import { usePulseFilters } from '@/data/pulse/filters';
import { usePulseStore } from '@/data/pulse/store';
import { usePulseColumn } from '@/data/pulse/usePulseColumn';
import { formatAge } from '@/lib/core/format';
import type { PulseColumn } from '@/lib/core/types';
import type { PumpPortalStatus } from '@/lib/streams/pumpportal';
import {
  COLUMN_BACKFILL,
  columnFreshness,
  feedFailing,
  LIVE_WINDOW_MS,
  marketCapUsdOf,
  sourceHealth,
  type PulseFeedId,
  type PulseFeeds,
  type SourceState,
} from '@/lib/services/pulse';
import type { PulseColumnConfig, PulseSourceSpec } from './columns';
import { PulseCard, PulseCardSkeleton } from './PulseCard';
import { PulseFilterMenu } from './PulseFilterMenu';

/** Scrolling this far down pauses insertion (touch devices have no hover). */
const SCROLL_PAUSE_PX = 8;
/** Leave the skeleton this long after the first feed answered, even if the column is still empty. */
const SETTLE_AFTER_MS = 8_000;

// ---------------------------------------------------------------------------
// Header freshness
// ---------------------------------------------------------------------------

function ColumnFreshness({ column }: { column: PulseColumn }) {
  const stream = usePumpPortalStatus();
  const feeds = usePulseStore((s) => s.feeds);
  const now = useNow();
  // min-w-0: on a 360 px column the badge yields space to the Paused chip and the filter button.
  if (!now) return <FreshnessBadge updatedAt={null} className="min-w-0 overflow-hidden" />;
  const f = columnFreshness(column, { streamOpen: stream.status === 'open', streamLastAt: stream.lastMessageAt, feeds, now });
  return <FreshnessBadge updatedAt={f.updatedAt} live={f.live} error={f.error} liveWindowMs={LIVE_WINDOW_MS} className="min-w-0 overflow-hidden" />;
}

// ---------------------------------------------------------------------------
// Source line
// ---------------------------------------------------------------------------

interface SourceTagView {
  label: string;
  state: SourceState;
  title: string;
  href?: string;
}

function streamState(stream: PumpPortalStatus, now: number): { state: SourceState; detail: string } {
  if (stream.status === 'open') {
    const last = stream.lastMessageAt;
    return last !== undefined && now - last < 30_000
      ? { state: 'ok', detail: `last frame ${formatAge(last, now)} ago` }
      : { state: 'ok', detail: 'connected, waiting for events' };
  }
  if (stream.status === 'connecting') return { state: 'idle', detail: 'connecting' };
  if (stream.status === 'reconnecting' || stream.consumers > 0) {
    return { state: 'error', detail: stream.lastServerError ?? stream.lastError ?? 'disconnected, reconnecting' };
  }
  return { state: 'idle', detail: 'not connected' };
}

function feedTag(spec: PulseSourceSpec, feeds: PulseFeeds, now: number): SourceTagView {
  const ids = spec.feeds === 'stream' ? [] : spec.feeds;
  const health = sourceHealth(ids.map((id) => feeds[id]));
  const detail =
    health.state === 'error'
      ? (health.error ?? 'unavailable')
      : health.lastOkAt !== undefined
        ? `updated ${formatAge(health.lastOkAt, now)} ago${health.via ? ` via ${health.via}` : ''}`
        : 'waiting for first response';
  return { label: spec.label, state: health.state, title: `${spec.note} · ${detail}`, href: spec.href };
}

const DOT: Record<SourceState, string> = { ok: 'bg-up', error: 'bg-warn', idle: 'bg-faint' };

function SourceLine({ config }: { config: PulseColumnConfig }) {
  const caps = useCapabilities();
  const feeds = usePulseStore((s) => s.feeds);
  const stream = usePumpPortalStatus();
  const clock = useNow();

  const tags: SourceTagView[] = config.sources.map((spec) => {
    if (spec.feeds !== 'stream') return feedTag(spec, feeds, clock);
    const s = streamState(stream, clock);
    return { label: spec.label, state: s.state, title: `${spec.note} · ${s.detail}` };
  });
  const serverStatus = feeds[config.serverFeed];
  if (caps.serverPulse && !serverStatus?.disabled) {
    const health = sourceHealth([serverStatus]);
    tags.push({
      label: health.via ?? 'ORBYT API',
      state: health.state,
      title: `Keyed launchpad list via ORBYT API · ${health.state === 'error' ? (health.error ?? 'unavailable') : health.lastOkAt ? `updated ${formatAge(health.lastOkAt, clock)} ago` : 'waiting'}`,
    });
  }

  return (
    <footer className="flex h-7 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-line px-3 text-2xs whitespace-nowrap text-faint scrollbar-none">
      <span>Source</span>
      {tags.map((tag, i) => (
        <Fragment key={tag.label}>
          {i > 0 && <span aria-hidden>·</span>}
          <span className={cn('inline-flex items-center gap-1', tag.state === 'error' ? 'text-warn' : 'text-muted')} title={tag.title}>
            <span aria-hidden className={cn('size-1.5 rounded-full', DOT[tag.state])} />
            {tag.href ? (
              <a href={tag.href} target="_blank" rel="noopener noreferrer" className="hover:text-fg">
                {tag.label}
              </a>
            ) : (
              tag.label
            )}
            <span className="sr-only">{tag.state === 'ok' ? ' (ok)' : tag.state === 'error' ? ' (failing)' : ' (waiting)'}</span>
          </span>
        </Fragment>
      ))}
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Empty / loading
// ---------------------------------------------------------------------------

function columnFeedIds(config: PulseColumnConfig): PulseFeedId[] {
  const ids = new Set<PulseFeedId>([...COLUMN_BACKFILL[config.id], ...config.settle.feeds]);
  for (const spec of config.sources) if (spec.feeds !== 'stream') spec.feeds.forEach((id) => ids.add(id));
  return [...ids];
}

function ColumnPlaceholder({ config, hiddenByFilter }: { config: PulseColumnConfig; hiddenByFilter: boolean }) {
  const resetFilter = usePulseFilters((s) => s.resetFilter);
  const feeds = usePulseStore((s) => s.feeds);
  const stream = usePumpPortalStatus();
  const now = useNow();

  if (hiddenByFilter) {
    return (
      <EmptyState title="No tokens match these filters">
        <p>Tokens are arriving, but none pass the current filters.</p>
        <button
          type="button"
          onClick={() => resetFilter(config.id)}
          className="mt-3 h-6 rounded bg-brand-soft px-2.5 text-2xs font-semibold text-brand-strong hover:bg-brand/25"
        >
          Reset filters
        </button>
      </EmptyState>
    );
  }

  const answered = (id: PulseFeedId) => {
    const s = feeds[id];
    return !!s && !s.disabled && (s.lastOkAt !== undefined || s.lastErrorAt !== undefined);
  };
  const ids = columnFeedIds(config);
  const firstAnswer = Math.min(...ids.map((id) => Math.min(feeds[id]?.lastOkAt ?? Infinity, feeds[id]?.lastErrorAt ?? Infinity)));
  const settled =
    config.settle.feeds.some(answered) ||
    (config.settle.stream && stream.lastMessageAt !== undefined) ||
    (!!now && Number.isFinite(firstAnswer) && now - firstAnswer > SETTLE_AFTER_MS) ||
    (!!now && stream.openedAt !== undefined && now - stream.openedAt > SETTLE_AFTER_MS);

  if (!settled) {
    return (
      <div aria-busy="true" aria-label={`Loading ${config.title}`}>
        {Array.from({ length: 6 }, (_, i) => (
          <PulseCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  const errors = new Set<string>();
  for (const id of ids) {
    const s = feeds[id];
    if (feedFailing(s) && s?.error) errors.add(s.error);
  }
  const streamSource = config.sources.some((spec) => spec.feeds === 'stream');
  if (streamSource && stream.status !== 'open' && stream.consumers > 0) errors.add(`PumpPortal stream: ${stream.lastError ?? 'disconnected, reconnecting'}`);

  return (
    <EmptyState title={config.empty.title} tone={errors.size ? 'warn' : 'neutral'}>
      <p>{config.empty.body}</p>
      {errors.size > 0 && (
        <ul className="mt-2 space-y-0.5 text-warn">
          {[...errors].map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </EmptyState>
  );
}

// ---------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------

export function PulseColumnPanel({ config, className }: { config: PulseColumnConfig; className?: string }) {
  const solPriceUsd = useSolPrice().data?.data.priceUsd;
  const view = usePulseColumn(config.id, solPriceUsd);
  const headingId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  const focused = useRef(false);
  const scrolled = useRef(false);
  const [ready, setReady] = useState(false);
  const hasItems = view.shown.length > 0;
  const { pause, resume } = view;

  // Tokens mounted after the first paint slide in; the initial batch does not.
  useEffect(() => {
    if (ready || !hasItems) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [ready, hasItems]);

  const sync = () => (hovering.current || focused.current || scrolled.current ? pause() : resume());

  // An empty column is not frozen (usePulseColumn); once the first tokens land
  // under a pointer that is already resting on the column, pause then.
  useEffect(() => {
    if (hasItems && (hovering.current || focused.current || scrolled.current)) pause();
  }, [hasItems, pause]);

  const onPointerEnter = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    hovering.current = true;
    sync();
  };
  const onPointerLeave = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    hovering.current = false;
    sync();
  };
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    let keyboard = false;
    try {
      keyboard = e.target.matches(':focus-visible');
    } catch {
      keyboard = false;
    }
    if (!keyboard) return;
    focused.current = true;
    sync();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    focused.current = false;
    sync();
  };
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const down = e.currentTarget.scrollTop > SCROLL_PAUSE_PX;
    if (down === scrolled.current) return;
    scrolled.current = down;
    sync();
  };
  const resumeAtTop = () => {
    hovering.current = false;
    focused.current = false;
    scrolled.current = false;
    listRef.current?.scrollTo({ top: 0 });
    resume();
  };

  return (
    <section aria-labelledby={headingId} className={cn('min-h-0 min-w-0 flex-col bg-panel', className)}>
      {/* No overflow clipping here: the filter popover hangs below the header. The freshness badge shrinks instead. */}
      <header className="flex h-10 min-w-0 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 id={headingId} className="shrink-0 font-display text-[13px] font-semibold tracking-tight text-fg">
          {config.title}
        </h2>
        <span className="shrink-0 rounded bg-panel-3 px-1.5 text-2xs leading-5 font-semibold text-muted tabular" title={`${view.shown.length} tokens shown`}>
          {view.shown.length}
        </span>
        <ColumnFreshness column={config.id} />
        {view.paused && (
          <button
            type="button"
            onClick={resumeAtTop}
            title="Insertion paused while you hover, focus or scroll this column. Click to resume."
            className="inline-flex h-5 shrink-0 items-center gap-1 rounded bg-brand-soft px-1.5 text-2xs font-semibold text-brand-strong hover:bg-brand/25"
          >
            <Pause aria-hidden className="size-3" strokeWidth={1.75} />
            Paused
            {view.queued > 0 && <span className="font-medium tabular">· {view.queued} new</span>}
          </button>
        )}
        <div className="ml-auto flex shrink-0 items-center">
          <PulseFilterMenu column={config.id} title={config.title} />
        </div>
      </header>

      <div
        ref={listRef}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {hasItems ? (
          <ol aria-labelledby={headingId}>
            {view.shown.map((item) => (
              <li key={item.mint}>
                <PulseCard item={item} column={config.id} mcUsd={marketCapUsdOf(item, solPriceUsd)} animateIn={ready} />
              </li>
            ))}
          </ol>
        ) : (
          <ColumnPlaceholder config={config} hiddenByFilter={view.hiddenByFilter} />
        )}
      </div>

      <SourceLine config={config} />
    </section>
  );
}
