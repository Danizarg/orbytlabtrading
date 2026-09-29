/**
 * Shared classes for the wallet and tracker tables (32 px rows, 28 px sticky
 * headers, hairline separators). Padding and z-index are set exactly once.
 */

const CELL = 'h-8 overflow-hidden border-b border-line px-2 align-middle whitespace-nowrap transition-colors duration-150 group-hover:bg-hover';

export const TD = CELL;
/** First column stays visible while the table scrolls sideways on narrow screens. */
export const TD_STICKY = `${CELL} sticky left-0 z-10 bg-panel`;

const HEAD = 'sticky top-0 h-7 border-b border-line bg-panel px-2 text-2xs font-medium whitespace-nowrap text-muted';
export const TH = `${HEAD} z-20`;
export const TH_STICKY = `${HEAD} left-0 z-30`;

export const BTN = 'inline-flex h-6 shrink-0 items-center gap-1 rounded border border-line-strong px-2 text-2xs font-medium text-fg-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-50';
export const BTN_PRIMARY = 'inline-flex h-6 shrink-0 items-center gap-1 rounded bg-brand-soft px-2 text-2xs font-semibold text-brand-strong transition-colors hover:bg-brand/25 disabled:opacity-50';
export const BTN_DANGER = 'inline-flex h-6 shrink-0 items-center gap-1 rounded bg-down-soft px-2 text-2xs font-semibold text-down transition-colors hover:bg-down/25 disabled:opacity-50';
export const INPUT = 'h-7 min-w-0 rounded border border-line-strong bg-panel-2 px-2 text-xs text-fg placeholder:text-faint focus:border-brand focus:outline-none';
export const FOOTER = 'flex h-7 shrink-0 items-center gap-2 overflow-x-auto border-t border-line bg-panel px-3 text-2xs whitespace-nowrap text-muted scrollbar-none';
