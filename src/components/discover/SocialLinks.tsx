import { Globe, Send } from 'lucide-react';
import type { Socials } from '@/lib/core/types';
import { cn } from '@/components/ui/cn';

/** X (Twitter) glyph; lucide no longer ships brand marks. */
function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.18h1.7L7.4 4.73H5.58l11.09 14.45Z" />
    </svg>
  );
}

/** Only http(s) links from provider metadata are rendered (it is untrusted third-party content). */
function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const LINK = 'inline-flex size-4 items-center justify-center rounded-sm text-faint transition-colors hover:text-fg';

/** Website / X / Telegram icons as external links. Renders nothing when no link is known. */
export function SocialLinks({ socials, symbol, className }: { socials?: Socials; symbol?: string; className?: string }) {
  const website = safeHref(socials?.website);
  const twitter = safeHref(socials?.twitter);
  const telegram = safeHref(socials?.telegram);
  if (!website && !twitter && !telegram) return null;
  const name = symbol ?? 'token';
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {website && (
        <a href={website} target="_blank" rel="noopener noreferrer nofollow" aria-label={`${name} website`} title={website} className={LINK}>
          <Globe aria-hidden className="size-3" strokeWidth={1.75} />
        </a>
      )}
      {twitter && (
        <a href={twitter} target="_blank" rel="noopener noreferrer nofollow" aria-label={`${name} on X`} title={twitter} className={LINK}>
          <XIcon className="size-2.5" />
        </a>
      )}
      {telegram && (
        <a href={telegram} target="_blank" rel="noopener noreferrer nofollow" aria-label={`${name} on Telegram`} title={telegram} className={LINK}>
          <Send aria-hidden className="size-3" strokeWidth={1.75} />
        </a>
      )}
    </span>
  );
}
