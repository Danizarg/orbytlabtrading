import Link from 'next/link';

export function Logo() {
  return (
    <Link href="/discover" aria-label="ORBYT home" className="flex shrink-0 items-center gap-2">
      <svg viewBox="0 0 40 40" className="size-7" aria-hidden>
        <rect width="40" height="40" rx="11" fill="#15161d" />
        <circle cx="20" cy="20" r="11" fill="none" stroke="#a895ff" strokeWidth="4" />
        <circle cx="29" cy="11" r="4" fill="#e8ddff" />
        <circle cx="20" cy="20" r="3" fill="#a895ff" />
      </svg>
      <span className="font-display text-lg leading-none font-bold tracking-tight">
        ORBYT
        <span className="ml-1 hidden align-top text-[9px] font-semibold tracking-[0.18em] text-brand xl:inline">AI TRADING</span>
      </span>
    </Link>
  );
}
