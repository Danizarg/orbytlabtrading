'use client';

import { ExternalLink } from 'lucide-react';
import { WalletLink } from '@/components/ui/AddressLink';
import { CopyButton } from '@/components/ui/CopyButton';
import type { TokenOverviewState } from '@/data/hooks/useTokenOverview';
import { formatAmount, formatDateTime } from '@/lib/core/format';
import { shortAddress } from '@/lib/core/solana';
import { explorerLinks, safeHttpUrl } from '@/lib/services/token';
import { Dash, KV, SocialLinks } from './parts';

function authorityText(value: string | null | undefined): React.ReactNode {
  if (value === undefined) return <Dash />;
  if (value === null) return <span className="text-up">Revoked</span>;
  return (
    <span className="text-down" title={value}>
      Enabled · {shortAddress(value)}
    </span>
  );
}

export function InfoPanel({ state }: { state: TokenOverviewState }) {
  const { meta, mintInfo, supply, market, primaryPool } = state;
  const links = explorerLinks(state.mint, { pool: primaryPool?.address, launchpad: meta.launchpad?.launchpad });
  const website = safeHttpUrl(meta.socials.website);
  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
      {meta.description && <p className="mb-2 max-w-3xl text-xs leading-5 text-fg-dim">{meta.description}</p>}
      <div className="grid gap-x-8 gap-y-0 md:grid-cols-2">
        <div>
          <KV label="Mint">
            <span className="inline-flex items-center gap-1 font-mono">
              {shortAddress(state.mint, 8, 8)}
              <CopyButton value={state.mint} label="Copy mint address" />
            </span>
          </KV>
          <KV label="Name">{meta.name ?? <Dash />}</KV>
          <KV label="Symbol">{meta.symbol ?? <Dash />}</KV>
          <KV label="Decimals">{meta.decimals ?? <Dash />}</KV>
          <KV label="Token program">{meta.tokenProgram ?? mintInfo?.tokenProgram ?? <Dash />}</KV>
          <KV label="Supply" title={supply === undefined ? 'On-chain supply unavailable' : 'Current supply from the mint account'}>
            {supply === undefined ? <Dash /> : formatAmount(supply, { maxDecimals: 0 })}
          </KV>
          <KV label="Mint authority">{authorityText(mintInfo?.mintAuthority)}</KV>
          <KV label="Freeze authority">{authorityText(mintInfo?.freezeAuthority)}</KV>
        </div>
        <div>
          <KV label="Created">{meta.createdAt === undefined ? <Dash /> : formatDateTime(meta.createdAt)}</KV>
          <KV label="Creator">{meta.creator ? <WalletLink address={meta.creator} showTools /> : <Dash />}</KV>
          <KV label="Launchpad">{meta.launchpad?.launchpad ? `${meta.launchpad.launchpad} · ${meta.launchpad.stage}` : (meta.launchpad?.stage ?? <Dash />)}</KV>
          <KV label="Verified">{meta.verified === undefined ? <Dash /> : meta.verified ? <span className="text-info">Jupiter verified</span> : 'No'}</KV>
          <KV label="Tags">{meta.tags?.length ? meta.tags.join(', ') : <Dash />}</KV>
          <KV label="Holders">{market?.holders === undefined ? <Dash /> : market.holders.toLocaleString('en-US')}</KV>
          <KV label="Socials">
            <span className="inline-flex items-center gap-2">
              <SocialLinks socials={meta.socials} />
              {website && (
                <a href={website} target="_blank" rel="noopener noreferrer nofollow" className="max-w-40 truncate hover:text-brand-strong" title={website}>
                  {website.replace(/^https?:\/\//, '')}
                </a>
              )}
              {!website && !meta.socials.twitter && !meta.socials.telegram && <Dash />}
            </span>
          </KV>
          <KV label="Explorers">
            <span className="inline-flex flex-wrap items-center gap-2">
              {links.map((l) => (
                <a key={l.id} href={l.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:text-brand-strong">
                  {l.label}
                  <ExternalLink className="size-3" />
                </a>
              ))}
            </span>
          </KV>
        </div>
      </div>
    </div>
  );
}
