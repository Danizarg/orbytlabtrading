'use client';

import {
  Activity,
  ArrowUpRight,
  Boxes,
  ChartCandlestick,
  ChartLine,
  Radio,
  ShieldCheck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { WalletDialog } from '@/components/connect/WalletDialog';
import { BOOKMARK } from '@/config/bookmark';
import { SITE } from '@/config/site';
import { useWallet, useWalletConnected } from '@/lib/wallet/store';

/**
 * The /discover landing page: the first thing a visitor sees. A hero with a
 * Phantom connect and a skip, real feature highlights, and — further down — a
 * bookmark that drags to the browser's bookmarks bar.
 *
 * `onEnter` reveals the live token terminal (the visitor either connects a
 * wallet or skips). Connecting is handled by the gate above, which swaps to the
 * terminal as soon as a wallet is connected; here `onEnter` covers "skip".
 */
export function DiscoverLanding({ onEnter }: { onEnter: () => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const connected = useWalletConnected();

  // Belt and braces: if a wallet connects (from here or the header) while the
  // landing is still mounted, go straight into the terminal.
  useEffect(() => {
    if (connected) onEnter();
  }, [connected, onEnter]);

  useEffect(() => useWallet.getState().init(), []);

  return (
    <div className="relative flex-1 overflow-y-auto">
      <BackdropGlow />
      <div className="relative mx-auto w-full max-w-6xl px-5 sm:px-8">
        <Hero onConnect={() => setDialogOpen(true)} onSkip={onEnter} />
        <Providers />
        <Features />
        <BookmarkSection />
        <Footer />
      </div>
      {dialogOpen && <WalletDialog initialStep="list" onClose={() => setDialogOpen(false)} />}
    </div>
  );
}

function BackdropGlow() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[560px] overflow-hidden">
      <div className="absolute -top-40 left-1/2 size-[680px] -translate-x-1/2 rounded-full bg-brand/12 blur-[120px]" />
      <div className="absolute -top-24 left-[15%] size-[380px] rounded-full bg-info/8 blur-[110px]" />
      <div
        className="absolute inset-0 opacity-[0.4]"
        style={{
          backgroundImage:
            'linear-gradient(to right, color-mix(in srgb, var(--color-line) 60%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--color-line) 60%, transparent) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse 90% 60% at 50% 0%, black 20%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 90% 60% at 50% 0%, black 20%, transparent 75%)',
        }}
      />
    </div>
  );
}

function Hero({ onConnect, onSkip }: { onConnect: () => void; onSkip: () => void }) {
  return (
    <section className="flex flex-col items-center pt-16 pb-14 text-center sm:pt-24 sm:pb-20">
      <span className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-panel/70 px-3 py-1 text-2xs font-medium text-fg-dim backdrop-blur">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-up opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-up" />
        </span>
        Live Solana market data
      </span>

      <h1 className="mt-6 max-w-3xl font-display text-4xl font-bold tracking-tight text-fg sm:text-6xl">
        Trade Solana at the
        <br className="hidden sm:block" />{' '}
        <span className="bg-gradient-to-r from-brand-strong via-brand to-info bg-clip-text text-transparent">
          speed of the timeline
        </span>
      </h1>

      <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted sm:text-base">
        {SITE.name} pulls every new launch, live chart, whale wallet and risk signal into one dense terminal.
        Connect your wallet and go — no account, no email, no custody.
      </p>

      <div className="mt-8 flex w-full max-w-md flex-col gap-3 sm:flex-row sm:justify-center">
        <button
          type="button"
          onClick={onConnect}
          className="flex h-11 items-center justify-center gap-2 rounded-lg bg-brand px-6 text-sm font-semibold text-bg shadow-lg shadow-brand/20 transition-colors hover:bg-brand-strong"
        >
          <Wallet className="size-4" />
          Connect Phantom
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="group flex h-11 items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-panel/60 px-6 text-sm font-semibold text-fg backdrop-blur transition-colors hover:bg-hover"
        >
          Skip for now
          <ArrowUpRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>

      <p className="mt-4 flex items-center gap-1.5 text-2xs text-faint">
        <ShieldCheck className="size-3.5" />
        Non-custodial · your keys never leave your wallet
      </p>
    </section>
  );
}

const PROVIDERS = ['Jupiter', 'GeckoTerminal', 'DEX Screener', 'Helius', 'Pump.fun'];

function Providers() {
  return (
    <section className="border-t border-line/60 py-8">
      <p className="text-center text-2xs font-medium tracking-wide text-faint uppercase">Aggregating live data from</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
        {PROVIDERS.map((name) => (
          <span key={name} className="text-sm font-semibold text-muted transition-colors hover:text-fg-dim">
            {name}
          </span>
        ))}
      </div>
    </section>
  );
}

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
  href: string;
}

const FEATURES: Feature[] = [
  { icon: Boxes, title: 'Discover', body: 'Every Solana token from the keyless sources in one sortable table — price, market cap, liquidity, volume and holders.', href: '/discover' },
  { icon: Radio, title: 'Pulse', body: 'A real-time feed of new launches as they mint, graduate and start trading, streamed straight from the chain.', href: '/pulse' },
  { icon: ChartCandlestick, title: 'Live charts', body: 'Real candlestick charts built from on-chain trades, with the pool, transactions and risk beside every token.', href: '/discover' },
  { icon: ChartLine, title: 'Wallet analytics', body: 'Paste any address to see holdings, realized PnL and full transaction history, labelled and priced.', href: '/discover' },
  { icon: ShieldCheck, title: 'Risk scan', body: 'Mint authority, LP status and holder concentration surfaced per token, so you see the traps before you buy.', href: '/discover' },
  { icon: Users, title: 'Holders & whales', body: 'Track top holders and follow the wallets that move markets across every token you watch.', href: '/tracker' },
];

function Features() {
  return (
    <section className="py-14 sm:py-20">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-2xl font-bold tracking-tight text-fg sm:text-3xl">One terminal, the whole market</h2>
        <p className="mt-3 text-sm text-muted">Everything you need to find, size up and follow a Solana token — no tab-hopping.</p>
      </div>
      <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, body, href }) => (
          <Link
            key={title}
            href={href}
            className="group flex flex-col rounded-xl border border-line bg-panel/70 p-5 transition-colors hover:border-line-strong hover:bg-panel-2"
          >
            <span className="flex size-9 items-center justify-center rounded-lg border border-line bg-panel-2 text-brand transition-colors group-hover:border-brand/40">
              <Icon className="size-4.5" />
            </span>
            <h3 className="mt-4 flex items-center gap-1 text-sm font-semibold text-fg">
              {title}
              <ArrowUpRight className="size-3.5 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">{body}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

/**
 * The draggable bookmark. Its target (href + label) comes entirely from
 * `src/config/bookmark.ts`, so the owner can drop in a private bookmarklet
 * there without touching this component.
 */
function BookmarkSection() {
  const ref = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);

  // Set the href imperatively: React scrubs `javascript:` URLs passed as props,
  // which would break a bookmarklet. Assigning the attribute on the DOM node
  // keeps the exact string the owner configured, so the drag saves it verbatim.
  useEffect(() => {
    ref.current?.setAttribute('href', BOOKMARK.href);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(BOOKMARK.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <section className="py-14 sm:py-20">
      <div className="overflow-hidden rounded-2xl border border-line bg-panel/70">
        <div className="grid gap-8 p-6 sm:p-10 lg:grid-cols-2 lg:items-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-panel-2 px-3 py-1 text-2xs font-medium text-brand">
              <BookmarkGlyph className="size-3" />
              Bookmarklet
            </span>
            <h2 className="mt-4 font-display text-2xl font-bold tracking-tight text-fg sm:text-3xl">
              Add the ORBYT bookmark
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">{BOOKMARK.blurb}</p>
            <ol className="mt-6 space-y-3 text-sm text-fg-dim">
              <li className="flex gap-3">
                <Step n={1} />
                Show your browser&apos;s bookmarks bar (<kbd className="rounded border border-line-strong bg-panel-2 px-1.5 py-0.5 text-2xs">Ctrl</kbd>+<kbd className="rounded border border-line-strong bg-panel-2 px-1.5 py-0.5 text-2xs">Shift</kbd>+<kbd className="rounded border border-line-strong bg-panel-2 px-1.5 py-0.5 text-2xs">B</kbd>).
              </li>
              <li className="flex gap-3">
                <Step n={2} />
                Drag the button on the right up onto the bookmarks bar.
              </li>
              <li className="flex gap-3">
                <Step n={3} />
                Click it from any page to jump into ORBYT.
              </li>
            </ol>
          </div>

          <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-line-strong bg-bg/40 p-8">
            <p className="text-2xs font-medium tracking-wide text-faint uppercase">Drag me to your bookmarks bar</p>
            <a
              ref={ref}
              draggable
              onClick={(e) => e.preventDefault()}
              title="Drag me to your bookmarks bar"
              className="group flex cursor-grab items-center gap-2 rounded-lg border border-brand/40 bg-brand/10 px-5 py-2.5 text-sm font-semibold text-brand-strong shadow-lg shadow-brand/10 transition-transform active:cursor-grabbing active:scale-[0.98]"
            >
              <BookmarkGlyph className="size-4" />
              {BOOKMARK.label}
            </a>
            <button
              type="button"
              onClick={copy}
              className="text-2xs font-medium text-muted underline-offset-2 hover:text-fg-dim hover:underline"
            >
              {copied ? 'Copied ✓' : "Can't drag? Copy the bookmark link"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong bg-panel-2 text-2xs font-semibold text-brand">
      {n}
    </span>
  );
}

function BookmarkGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
    </svg>
  );
}

function Footer() {
  return (
    <footer className="flex flex-col items-center gap-3 border-t border-line/60 py-10 text-center">
      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Activity className="size-4 text-brand" />
        {SITE.name}
      </div>
      <p className="max-w-md text-2xs leading-relaxed text-faint">
        {SITE.fullName} shows live on-chain data only. Nothing here is financial advice. You are responsible for every
        transaction you approve in your own wallet.
      </p>
    </footer>
  );
}
