import type { DiscoverWindow } from '@/lib/core/providers';
import type { RiskMetric, SortKey } from '@/lib/services/discover';

export type ColumnId =
  | 'rank'
  | 'token'
  | 'age'
  | 'price'
  | 'change'
  | 'mc'
  | 'liq'
  | 'vol'
  | 'txns'
  | 'traders'
  | 'holders'
  | 'top10'
  | 'dev'
  | 'snipers'
  | 'insiders'
  | 'bundlers'
  | 'dex'
  | 'action';

export interface ColumnDef {
  id: ColumnId;
  label: (window: DiscoverWindow) => string;
  /** Header tooltip. */
  title?: (window: DiscoverWindow) => string;
  sortKey?: SortKey;
  align: 'left' | 'right' | 'center';
  /** Literal Tailwind width class for the <col> (the token column takes the rest). */
  width?: string;
  risk?: RiskMetric;
}

const fixed = (s: string) => () => s;

/** Table columns in display order (the brief's Discover column set, plus a separate Age column). */
export const COLUMNS: readonly ColumnDef[] = [
  { id: 'rank', label: fixed('#'), sortKey: 'rank', align: 'right', width: 'w-9', title: fixed('Provider rank') },
  { id: 'token', label: fixed('Token'), align: 'left' },
  { id: 'age', label: fixed('Age'), sortKey: 'age', align: 'right', width: 'w-10', title: fixed('Time since the first pool was created') },
  { id: 'price', label: fixed('Price'), sortKey: 'price', align: 'right', width: 'w-[76px]', title: fixed('Price (USD)') },
  { id: 'change', label: (w) => `Chg ${w}`, sortKey: 'change', align: 'right', width: 'w-16', title: (w) => `Price change, ${w}` },
  { id: 'mc', label: fixed('MC'), sortKey: 'mc', align: 'right', width: 'w-[68px]', title: fixed('Market cap (USD)') },
  { id: 'liq', label: fixed('Liq'), sortKey: 'liq', align: 'right', width: 'w-[68px]', title: fixed('Liquidity (USD)') },
  { id: 'vol', label: (w) => `V ${w}`, sortKey: 'vol', align: 'right', width: 'w-[68px]', title: (w) => `Volume (USD), ${w}` },
  { id: 'txns', label: (w) => `TXs ${w}`, sortKey: 'txns', align: 'right', width: 'w-20', title: (w) => `Buys / sells, ${w}` },
  { id: 'traders', label: fixed('Traders'), sortKey: 'traders', align: 'right', width: 'w-16', title: (w) => `Unique traders, ${w}` },
  { id: 'holders', label: fixed('Holders'), sortKey: 'holders', align: 'right', width: 'w-16', title: fixed('Holder count') },
  { id: 'top10', label: fixed('Top10'), sortKey: 'top10', align: 'right', width: 'w-14', risk: 'top10', title: fixed('Supply held by the top 10 holders') },
  { id: 'dev', label: fixed('Dev'), sortKey: 'dev', align: 'right', width: 'w-11', risk: 'dev', title: fixed('Supply held by the creator') },
  { id: 'snipers', label: fixed('Snipers'), sortKey: 'snipers', align: 'right', width: 'w-16', risk: 'snipers', title: fixed('Supply held by snipers') },
  { id: 'insiders', label: fixed('Insiders'), sortKey: 'insiders', align: 'right', width: 'w-16', risk: 'insiders', title: fixed('Supply held by insiders') },
  { id: 'bundlers', label: fixed('Bundlers'), sortKey: 'bundlers', align: 'right', width: 'w-[68px]', risk: 'bundlers', title: fixed('Supply held by bundlers') },
  { id: 'dex', label: fixed('DEX'), align: 'left', width: 'w-[104px]', title: fixed('Main pool venue') },
  { id: 'action', label: fixed(''), align: 'center', width: 'w-9' },
];

/** Minimum table width: fixed columns (1064 px) + 200 px for the token column. */
export const TABLE_MIN_WIDTH = 'min-w-[1264px]';
