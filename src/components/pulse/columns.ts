import type { PulseColumn } from '@/lib/core/types';
import type { PulseFeedId } from '@/lib/services/pulse';

export interface PulseSourceSpec {
  label: string;
  /** Polled feeds behind this source; `stream` = the PumpPortal WebSocket. */
  feeds: readonly PulseFeedId[] | 'stream';
  href?: string;
  /** Tooltip / attribution text. */
  note: string;
}

export interface PulseColumnConfig {
  id: PulseColumn;
  title: string;
  /** Tab label on narrow screens. */
  short: string;
  empty: { title: string; body: string };
  sources: readonly PulseSourceSpec[];
  /** Keyed server list for this column (shown only when configured). */
  serverFeed: PulseFeedId;
  /** The column leaves its loading skeleton once one of these has answered (or the stream delivered, when set). */
  settle: { feeds: readonly PulseFeedId[]; stream: boolean };
}

const PUMPPORTAL: PulseSourceSpec = { label: 'PumpPortal', feeds: 'stream', note: 'PumpPortal WebSocket: pump.fun creates and migrations as they happen' };
const GECKO_NOTE = 'On-chain data powered by GeckoTerminal';
const GECKO_HREF = 'https://www.geckoterminal.com/solana/pools';

export const PULSE_COLUMNS: readonly PulseColumnConfig[] = [
  {
    id: 'new',
    title: 'New Pairs',
    short: 'New',
    empty: {
      title: 'Waiting for launches',
      body: 'pump.fun creates stream in from PumpPortal as they land. Jupiter and GeckoTerminal backfill LaunchLab, Meteora DBC, Bags and other launchpads every few seconds.',
    },
    sources: [
      PUMPPORTAL,
      { label: 'Jupiter', feeds: ['jupRecent', 'jupRows'], note: 'Jupiter Tokens V2: recent launches, holders, activity and audit' },
      { label: 'GeckoTerminal', feeds: ['geckoNew'], href: GECKO_HREF, note: GECKO_NOTE },
      { label: 'Solana RPC', feeds: ['curves'], note: 'pump.fun bonding curves decoded on-chain' },
    ],
    serverFeed: 'serverNew',
    settle: { feeds: ['jupRecent', 'geckoNew', 'serverNew'], stream: true },
  },
  {
    id: 'final',
    title: 'Final Stretch',
    short: 'Final',
    empty: {
      title: 'No curves above 60 %',
      body: 'pump.fun progress is decoded on-chain from each bonding curve every 4 s. Other launchpads use the progress Jupiter reports.',
    },
    sources: [
      { label: 'Solana RPC', feeds: ['curves'], note: 'pump.fun bonding curves decoded on-chain every 4 s' },
      { label: 'GeckoTerminal', feeds: ['geckoPump'], href: GECKO_HREF, note: GECKO_NOTE },
      { label: 'Jupiter', feeds: ['jupUltra', 'jupRows', 'jupTrending'], note: 'Jupiter: launchpad progress, holders, risk and 1 h trending launches' },
    ],
    serverFeed: 'serverFinal',
    settle: { feeds: ['curves', 'jupUltra', 'jupTrending', 'serverFinal'], stream: false },
  },
  {
    id: 'migrated',
    title: 'Migrated',
    short: 'Migrated',
    empty: {
      title: 'No migrations in view yet',
      body: 'Migrations arrive live from PumpPortal. Jupiter trending and token rows and GeckoTerminal new pools backfill graduations from the last 24 h.',
    },
    sources: [
      PUMPPORTAL,
      { label: 'Jupiter', feeds: ['jupRows', 'jupTrending'], note: 'Jupiter Tokens V2: graduation pool and time; 1 h trending launches' },
      { label: 'GeckoTerminal', feeds: ['geckoNew'], href: GECKO_HREF, note: GECKO_NOTE },
      { label: 'Solana RPC', feeds: ['poolDex'], note: 'Destination DEX read on-chain from the owner program of each migration pool' },
    ],
    serverFeed: 'serverMigrated',
    settle: { feeds: ['jupRows', 'jupTrending', 'serverMigrated'], stream: false },
  },
];
