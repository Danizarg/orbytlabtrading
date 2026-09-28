import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { explorer, shortAddress } from '@/lib/core/solana';
import { CopyButton } from './CopyButton';
import { cn } from './cn';

/** Wallet address linking to ORBYT's wallet analytics, with copy + explorer shortcuts. */
export function WalletLink({ address, label, className, showTools = false }: { address: string; label?: string; className?: string; showTools?: boolean }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <Link href={`/wallet/${address}`} title={address} className="truncate font-mono text-fg-dim hover:text-brand-strong hover:underline">
        {label ?? shortAddress(address)}
      </Link>
      {showTools && (
        <>
          <CopyButton value={address} label="Copy address" />
          <a href={explorer.account(address)} target="_blank" rel="noopener noreferrer" aria-label="View on Solscan" className="text-muted hover:text-fg">
            <ExternalLink className="size-3" />
          </a>
        </>
      )}
    </span>
  );
}

/** Transaction signature linking to Solscan. */
export function TxLink({ signature, className }: { signature: string; className?: string }) {
  return (
    <a
      href={explorer.tx(signature)}
      target="_blank"
      rel="noopener noreferrer"
      title={signature}
      className={cn('inline-flex items-center gap-1 font-mono text-muted hover:text-brand-strong', className)}
    >
      {shortAddress(signature, 4, 4)}
      <ExternalLink className="size-3" />
    </a>
  );
}
