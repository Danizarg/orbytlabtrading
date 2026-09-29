/**
 * Dense table cells for the token page tabs (28 px rows, hairline separators).
 * Header cells are sticky inside each panel's own scroll container.
 */

const CELL = 'h-7 overflow-hidden border-b border-line align-middle whitespace-nowrap px-2 text-xs';

export const TD = `${CELL} text-fg-dim`;
export const TD_NUM = `${CELL} text-right tabular text-fg-dim`;

const HEAD = 'sticky top-0 z-10 h-7 border-b border-line bg-panel px-2 text-2xs font-medium whitespace-nowrap text-muted';

export const TH = `${HEAD} text-left`;
export const TH_NUM = `${HEAD} text-right`;

/** Row hover for tables whose rows link somewhere. */
export const ROW = 'transition-colors duration-150 hover:bg-hover';
