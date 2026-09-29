'use client';

import { ArrowLeft, Check, Download, ExternalLink, KeyRound, LoaderCircle, ShieldCheck, Smartphone, Wallet, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { shortAddress } from '@/lib/core/solana';
import { useWallet } from '@/lib/wallet/store';
import { shouldAutoSignIn } from './autoSign';
import { isMobileUserAgent, PHANTOM_DOWNLOAD_URL, phantomBrowseLink } from './phantom';
import { WalletIcon } from './WalletIcon';

export type WalletDialogStep = 'list' | 'sign';

/**
 * Connect + Sign-In With Solana dialog. Native modal <dialog>: the page
 * behind is inert (focus stays inside), Esc closes, and focus returns to the
 * trigger when it closes.
 */
export function WalletDialog({ initialStep, onClose }: { initialStep: WalletDialogStep; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<WalletDialogStep>(initialStep);
  const [pending, setPending] = useState<string | null>(null);
  // Opened from the menu's "Sign in", or a wallet was just connected here: ask the wallet right away.
  const [autoSign, setAutoSign] = useState(initialStep === 'sign');
  const address = useWallet((s) => s.address);
  const status = useWallet((s) => s.status);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Drop feedback left over from a prompt answered after the last dialog closed.
    useWallet.getState().clearFeedback();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => useWallet.getState().clearFeedback();
  }, []);

  const close = () => ref.current?.close();
  const showSign = step === 'sign' && !!address && status !== 'connecting';
  const view = pending ? 'connecting' : showSign ? 'sign' : 'list';

  // Move focus into each new view (the element that had focus was just unmounted).
  useEffect(() => {
    if (ref.current?.open) ref.current.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [view]);
  const title = pending ? `Connecting ${pending}` : showSign ? 'Sign in' : 'Connect a wallet';

  async function choose(name: string) {
    setPending(name);
    const ok = await useWallet.getState().connect(name);
    setPending((current) => (current === name ? null : current));
    if (ok) {
      setStep('sign');
      setAutoSign(true);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      aria-labelledby="wallet-dialog-title"
      className="m-auto w-[min(400px,calc(100vw-2rem))] rounded-lg border border-line-strong bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/75"
    >
      <div className="flex h-12 items-center justify-between gap-2 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2">
          {pending && (
            <button type="button" data-autofocus="" aria-label="Back to wallet list" onClick={() => setPending(null)} className="-ml-1 rounded p-1 text-muted hover:bg-hover hover:text-fg">
              <ArrowLeft className="size-4" />
            </button>
          )}
          <h2 id="wallet-dialog-title" className="truncate text-sm font-semibold">
            {title}
          </h2>
        </div>
        <button type="button" aria-label="Close" onClick={close} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
          <X className="size-4" />
        </button>
      </div>

      <div className="p-4">
        {pending ? <ConnectingView name={pending} /> : showSign ? <SignInView onDone={close} autoStart={autoSign} /> : <WalletList onChoose={choose} />}
      </div>
    </dialog>
  );
}

function Feedback() {
  const error = useWallet((s) => s.error);
  const notice = useWallet((s) => s.notice);
  if (error) {
    return (
      <p role="alert" className="rounded-md bg-down-soft px-3 py-2 text-xs text-down">
        {error}
      </p>
    );
  }
  if (notice) {
    return (
      <p role="status" className="rounded-md border border-line bg-panel-2 px-3 py-2 text-xs text-muted">
        {notice}
      </p>
    );
  }
  return null;
}

function WalletList({ onChoose }: { onChoose: (name: string) => void }) {
  const wallets = useWallet((s) => s.wallets);
  const hasPhantom = wallets.some((w) => w.name.toLowerCase() === 'phantom');

  if (!wallets.length) return <NoWallet />;

  return (
    <div className="space-y-3">
      <ul className="space-y-1.5" aria-label="Detected wallets">
        {wallets.map((w, i) => (
          <li key={w.name}>
            <button
              type="button"
              data-autofocus={i === 0 ? '' : undefined}
              onClick={() => onChoose(w.name)}
              className="flex h-11 w-full items-center gap-3 rounded-md border border-line bg-panel-2 px-3 text-left text-[13px] font-medium text-fg transition-colors hover:border-line-strong hover:bg-hover"
            >
              <WalletIcon icon={w.icon} name={w.name} className="size-6" />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="rounded bg-up-soft px-1.5 py-0.5 text-2xs font-medium text-up">Installed</span>
            </button>
          </li>
        ))}
      </ul>
      <Feedback />
      <p className="text-2xs leading-relaxed text-muted">
        Connecting shares only your public address. Your keys stay in your wallet, and every transaction needs your approval there.
      </p>
      {!hasPhantom && (
        <a
          href={PHANTOM_DOWNLOAD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-2xs font-medium text-fg-dim hover:text-fg"
        >
          Get Phantom <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}

function NoWallet() {
  const mobile = useMemo(() => typeof navigator !== 'undefined' && isMobileUserAgent(navigator.userAgent), []);
  const deepLink = useMemo(() => (typeof window === 'undefined' ? null : phantomBrowseLink(window.location.href, window.location.origin)), []);

  return (
    <div className="space-y-3">
      <div className="flex flex-col items-center rounded-md border border-line bg-panel-2 px-4 py-5 text-center">
        <span className="flex size-9 items-center justify-center rounded-md bg-panel-3 text-muted">
          <Wallet className="size-4" />
        </span>
        <p className="mt-2.5 text-[13px] font-medium text-fg">No Solana wallet detected</p>
        <p className="mt-1 max-w-[280px] text-2xs leading-relaxed text-muted">
          {mobile
            ? 'Mobile browsers cannot run wallet extensions. Open ORBYT inside the Phantom app to connect.'
            : 'Install the Phantom browser extension, then reload this page. Other Wallet Standard wallets (Solflare, Backpack) appear here too.'}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        {mobile && deepLink && (
          <a
            data-autofocus=""
            href={deepLink}
            className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md bg-brand px-3 text-xs font-semibold text-bg transition-colors hover:bg-brand-strong sm:flex-1"
          >
            <Smartphone className="size-3.5" /> Open in Phantom
          </a>
        )}
        <a
          data-autofocus={mobile ? undefined : ''}
          href={PHANTOM_DOWNLOAD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors sm:flex-1',
            mobile ? 'border border-line-strong text-fg hover:bg-hover' : 'bg-brand text-bg hover:bg-brand-strong',
          )}
        >
          <Download className="size-3.5" /> Get Phantom
          <ExternalLink className="size-3 opacity-70" />
        </a>
      </div>
    </div>
  );
}

function ConnectingView({ name }: { name: string }) {
  const icon = useWallet((s) => s.wallets.find((w) => w.name === name)?.icon);
  return (
    <div className="flex flex-col items-center py-4 text-center" role="status" aria-live="polite">
      <div className="relative">
        <WalletIcon icon={icon} name={name} className="size-11 rounded-lg" />
        <LoaderCircle className="absolute -right-1.5 -bottom-1.5 size-4 animate-spin rounded-full bg-panel text-brand" />
      </div>
      <p className="mt-3 text-[13px] font-medium text-fg">Approve the connection in {name}</p>
      <p className="mt-1 text-2xs text-muted">ORBYT asks only for your public address.</p>
    </div>
  );
}

function SignInView({ onDone, autoStart }: { onDone: () => void; autoStart: boolean }) {
  const walletName = useWallet((s) => s.walletName) ?? 'your wallet';
  const walletIcon = useWallet((s) => s.walletIcon);
  const address = useWallet((s) => s.address);
  const verified = useWallet((s) => s.verified);
  const status = useWallet((s) => s.status);
  const canSign = useWallet((s) => {
    const w = s.wallets.find((o) => o.name === s.walletName);
    return !!w && (w.canSignIn || w.canSignMessage);
  });
  const signing = status === 'signing';
  // Survives StrictMode's effect replay, so the wallet is asked exactly once per dialog.
  const autoRequested = useRef(false);

  async function signIn() {
    const ok = await useWallet.getState().signIn();
    if (ok) onDone();
  }

  useEffect(() => {
    if (!shouldAutoSignIn({ autoStart, alreadyRequested: autoRequested.current, canSign, verified, status })) return;
    autoRequested.current = true;
    void useWallet
      .getState()
      .signIn()
      .then((ok) => {
        if (ok) onDone();
      });
  }, [autoStart, canSign, verified, status, onDone]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-md border border-line bg-panel-2 px-3 py-2.5">
        <WalletIcon icon={walletIcon} name={walletName} className="size-7 rounded-md" />
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-fg">{walletName}</div>
          <div className="font-mono text-2xs text-muted">{shortAddress(address, 6, 6)}</div>
        </div>
        <span className={cn('ml-auto flex items-center gap-1 text-2xs font-medium', verified ? 'text-up' : 'text-fg-dim')}>
          {verified ? <Check className="size-3" /> : <span className="size-1.5 rounded-full bg-up" aria-hidden />}
          {verified ? 'Signed in' : 'Connected'}
        </span>
      </div>

      {canSign ? (
        <>
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Sign in with {walletName}</h3>
            <ul className="mt-2 space-y-2 text-xs leading-relaxed text-fg-dim">
              <li className="flex gap-2">
                <KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted" />
                Signing a short message proves you own this wallet.
              </li>
              <li className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-muted" />
                It is free: no transaction is sent and no funds move.
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-muted" />
                {walletName} shows the exact message, including this site&apos;s address, before you approve.
              </li>
            </ul>
          </div>
          <Feedback />
          <div className="flex gap-2">
            <button
              type="button"
              data-autofocus=""
              onClick={signIn}
              disabled={signing}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-brand px-3 text-xs font-semibold text-bg transition-colors hover:bg-brand-strong disabled:opacity-70"
            >
              {signing ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" /> Check {walletName}
                </>
              ) : (
                `Sign in with ${walletName}`
              )}
            </button>
            <button
              type="button"
              onClick={onDone}
              className="h-9 rounded-md border border-line-strong px-4 text-xs font-medium text-fg-dim transition-colors hover:bg-hover hover:text-fg"
            >
              Skip
            </button>
          </div>
          <p className="text-2xs leading-relaxed text-faint">Skip keeps the wallet connected without signing in. You can sign in later from the wallet menu.</p>
        </>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-fg-dim">{walletName} cannot sign messages, so sign-in is unavailable. The wallet stays connected.</p>
          <button
            type="button"
            data-autofocus=""
            onClick={onDone}
            className="h-9 w-full rounded-md border border-line-strong text-xs font-medium text-fg transition-colors hover:bg-hover"
          >
            Done
          </button>
        </>
      )}
    </div>
  );
}
