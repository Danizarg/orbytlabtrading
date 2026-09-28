import Link from 'next/link';

/** ORBYT mark + wordmark (the mark alone on small screens). */
export function Logo() {
  return (
    <Link href="/discover" aria-label="ORBYT — Discover" className="flex shrink-0 items-center gap-2 rounded-md">
      <svg viewBox="0 0 40 40" className="size-7" aria-hidden>
        <rect width="40" height="40" rx="9" fill="var(--color-panel-3)" />
        <circle cx="20" cy="20" r="11" fill="none" stroke="var(--color-brand)" strokeWidth="4" />
        <circle cx="29" cy="11" r="4" fill="var(--color-brand-strong)" />
        <circle cx="20" cy="20" r="3" fill="var(--color-brand)" />
      </svg>
      <span className="hidden font-display text-[17px] leading-none font-bold tracking-tight text-fg sm:inline">ORBYT</span>
    </Link>
  );
}
