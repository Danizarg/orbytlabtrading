/**
 * Shared cell classes so header, rows and skeletons stay aligned. Each
 * variant sets padding / z-index exactly once (no conflicting utilities).
 */

/** 36 px body cell with a hairline separator; every cell carries the row hover (sticky cells are opaque). */
const CELL = 'h-9 overflow-hidden border-b border-line align-middle whitespace-nowrap transition-colors duration-150 group-hover:bg-hover';

export const TD = `${CELL} px-1.5`;

/** Sticky rank column (w-9). */
export const TD_RANK = `${CELL} sticky left-0 z-10 bg-panel px-1.5`;

/** Sticky token column, offset by the rank column, with a hairline edge while scrolling sideways. */
export const TD_TOKEN = `${CELL} sticky left-9 z-10 border-r bg-panel px-2`;

/** Icon-button column. */
export const TD_ACTION = `${CELL} px-0 text-center`;

const HEAD = 'sticky top-0 h-8 border-b border-line bg-panel text-2xs font-medium whitespace-nowrap text-muted';

export const TH = `${HEAD} z-20 px-1.5`;
export const TH_RANK = `${HEAD} left-0 z-30 px-1.5`;
export const TH_TOKEN = `${HEAD} left-9 z-30 border-r px-2`;
