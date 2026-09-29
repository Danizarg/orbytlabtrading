'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { NAV_LINKS } from './nav';

/** Primary navigation. Scrolls horizontally when the header is narrow. */
export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-none lg:flex-none">
      {NAV_LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex shrink-0 items-center px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
              active ? 'text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {link.label}
            {active && <span aria-hidden className="absolute inset-x-2.5 bottom-0 h-0.5 rounded-full bg-brand" />}
          </Link>
        );
      })}
    </nav>
  );
}
