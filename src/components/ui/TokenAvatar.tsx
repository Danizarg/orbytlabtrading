'use client';

import { useState } from 'react';
import { cn } from './cn';

/** Only render https images (token metadata is untrusted). */
function safeImage(src: string | null | undefined): string | undefined {
  if (!src) return undefined;
  try {
    const url = new URL(src);
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'ipfs:') return `https://ipfs.io/ipfs/${url.href.slice('ipfs://'.length)}`;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Token logo with initials fallback. `progress` (0-100) draws a bonding-curve
 * ring around the avatar, like launch scanners do.
 */
export function TokenAvatar({
  src,
  symbol,
  size = 32,
  progress,
  className,
}: {
  src?: string | null;
  symbol?: string | null;
  size?: number;
  progress?: number | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = failed ? undefined : safeImage(src);
  const initials = (symbol ?? '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
  const ring = typeof progress === 'number' && Number.isFinite(progress);
  const pct = ring ? Math.min(100, Math.max(0, progress)) : 0;
  const stroke = 2.5;
  const r = size / 2 + 1;
  const c = 2 * Math.PI * r;

  return (
    <span className={cn('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: size + 8, height: size + 8 }}>
      {ring && (
        <svg className="absolute inset-0 -rotate-90" width={size + 8} height={size + 8} aria-hidden>
          <circle cx={(size + 8) / 2} cy={(size + 8) / 2} r={r} fill="none" stroke="var(--color-line-strong)" strokeWidth={stroke} />
          <circle
            cx={(size + 8) / 2}
            cy={(size + 8) / 2}
            r={r}
            fill="none"
            stroke={pct >= 85 ? 'var(--color-warn)' : 'var(--color-up)'}
            strokeWidth={stroke}
            strokeDasharray={`${(pct / 100) * c} ${c}`}
            strokeLinecap="round"
          />
        </svg>
      )}
      <span
        className="flex items-center justify-center overflow-hidden rounded-full bg-panel-3 text-2xs font-bold text-fg-dim"
        style={{ width: size, height: size }}
      >
        {url ? (
          <img src={url} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailed(true)} />
        ) : (
          initials
        )}
      </span>
    </span>
  );
}
