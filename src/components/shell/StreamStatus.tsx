'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { LEVEL_LABEL, type HealthRow, type SystemHealth } from './health';
import { LEVEL_TEXT, StatusDot } from './StatusDot';
import { useSystemHealth } from './useSystemHealth';

const RPC_KIND: Record<string, string> = { public: 'Public RPC', helius: 'Helius RPC', custom: 'Private RPC' };

/**
 * Header connection indicator. Green: everything in use is working. Amber:
 * a provider is cooling down / erroring or a stream is reconnecting. Red: the
 * browser is offline or a stream in use is unavailable. The popover lists
 * each stream and provider with what is actually known about it.
 */
export function StreamStatus() {
  const health = useSystemHealth();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const streaming = health.streams.some((r) => r.level === 'ok');

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Connection status: ${LEVEL_LABEL[health.overall]}`}
        title={`Connection: ${LEVEL_LABEL[health.overall]}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-8 items-center gap-2 rounded-md px-2 text-2xs font-medium transition-colors hover:bg-hover',
          open ? 'bg-hover text-fg' : 'text-muted hover:text-fg',
        )}
      >
        <StatusDot level={health.overall} pulse={streaming} size="md" />
        <span className={cn('hidden xl:inline', health.overall === 'degraded' && 'text-warn', health.overall === 'offline' && 'text-down')}>
          {LEVEL_LABEL[health.overall]}
        </span>
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Connection status"
          // Phones: pinned under the header across the viewport (the trigger sits mid-header, so a
          // right-anchored 340 px panel would overflow the left edge). Wider screens: anchored to the dot.
          className="fixed inset-x-2 top-[52px] z-50 overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60 sm:absolute sm:inset-x-auto sm:top-[calc(100%+6px)] sm:right-0 sm:w-[340px]"
        >
          <ConnectionPanel health={health} />
        </div>
      )}
    </div>
  );
}

/** Popover body: overall state, then streams, keyless browser providers and ORBYT server providers. */
export function ConnectionPanel({ health }: { health: SystemHealth }) {
  return (
    <>
      <div className="flex h-9 items-center justify-between border-b border-line px-3">
        <span className="text-xs font-semibold text-fg">Connection</span>
        <span className={cn('flex items-center gap-1.5 text-2xs font-medium', LEVEL_TEXT[health.overall])}>
          <StatusDot level={health.overall} />
          {LEVEL_LABEL[health.overall]}
        </span>
      </div>

      <div className="max-h-[min(560px,calc(100dvh-120px))] overflow-y-auto overscroll-contain py-1">
        {!health.online && (
          <p role="alert" className="mx-3 my-1.5 rounded bg-down-soft px-2 py-1.5 text-2xs text-down">
            This browser is offline. Data resumes when the connection returns.
          </p>
        )}
        <Section title="Streams" rows={health.streams} />
        <Section title="Browser · keyless APIs" rows={health.browser} />
        <Section title="Server" aside={health.rpc ? RPC_KIND[health.rpc] : undefined} rows={[health.api, ...health.server]} />
      </div>

      <p className="border-t border-line px-3 py-2 text-2xs leading-relaxed text-faint">
        Streams open only while a page uses them. Keyless APIs are called from this browser within its own rate limits; keyed providers
        run on the ORBYT server.
      </p>
    </>
  );
}

function Section({ title, aside, rows }: { title: string; aside?: string; rows: HealthRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="py-1">
      <h3 className="flex h-6 items-center justify-between px-3 text-2xs font-semibold tracking-wide text-faint uppercase">
        <span>{title}</span>
        {aside && <span className="font-medium tracking-normal normal-case">{aside}</span>}
      </h3>
      <ul>
        {rows.map((row) => (
          <li key={row.id} title={row.title} className="flex h-7 items-center gap-2 px-3 text-xs">
            <StatusDot level={row.level} />
            <span className="truncate text-fg-dim">{row.label}</span>
            <span className={cn('ml-auto shrink-0 text-right text-2xs tabular', LEVEL_TEXT[row.level])}>{row.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
