'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/cn';

const LINKS = [
  { href: '/discover', label: 'Discover' },
  { href: '/pulse', label: 'Pulse' },
  { href: '/tracker', label: 'Tracker' },
  { href: '/watchlist', label: 'Watchlist' },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex h-full items-stretch gap-1 overflow-x-auto scrollbar-none">
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex items-center px-2.5 text-[13px] font-semibold whitespace-nowrap transition-colors',
              active ? 'text-brand-strong' : 'text-muted hover:text-fg',
            )}
          >
            {link.label}
            {active && <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" />}
          </Link>
        );
      })}
    </nav>
  );
}
