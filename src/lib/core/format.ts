/**
 * Display formatting. Every formatter returns an em dash for missing values so
 * unavailable metrics are never rendered as zero.
 */

export const DASH = '—';

type Num = number | null | undefined;

const isNum = (n: Num): n is number => typeof n === 'number' && Number.isFinite(n);

const SUBSCRIPT = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
const toSubscript = (n: number) => String(n).split('').map((d) => SUBSCRIPT[Number(d)] ?? d).join('');

/**
 * Token price with trader-style zero compression: 0.00000123 -> 0.0₅123.
 * Keeps 4 significant digits.
 */
export function formatPrice(n: Num, opts: { currency?: boolean } = {}): string {
  if (!isNum(n)) return DASH;
  const prefix = opts.currency === false ? '' : '$';
  if (n === 0) return `${prefix}0`;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000) return `${sign}${prefix}${abs.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (abs >= 1) return `${sign}${prefix}${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  if (abs >= 0.001) return `${sign}${prefix}${abs.toPrecision(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  // Zeros between the decimal point and the first significant digit.
  const zeros = Math.ceil(-Math.log10(abs)) - 1;
  const digits = Math.round(abs * 10 ** (zeros + 4))
    .toString()
    .slice(0, 4)
    .replace(/0+$/, '');
  return `${sign}${prefix}0.0${toSubscript(zeros)}${digits || '0'}`;
}

/** Compact USD: $1.23K, $4.5M, $12B. */
export function formatUsd(n: Num, opts: { compact?: boolean; decimals?: number } = {}): string {
  if (!isNum(n)) return DASH;
  const compact = opts.compact ?? true;
  if (compact) {
    const abs = Math.abs(n);
    if (abs < 1_000) return `${n < 0 ? '-' : ''}$${abs.toFixed(abs < 10 ? 2 : 0)}`;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: opts.decimals ?? (abs < 100_000 ? 1 : 2),
    }).format(n);
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts.decimals ?? 2,
    maximumFractionDigits: opts.decimals ?? 2,
  }).format(n);
}

/** Compact plain number: 1.2K, 3.4M. */
export function formatCompact(n: Num, maxFractionDigits = 1): string {
  if (!isNum(n)) return DASH;
  if (Math.abs(n) < 1_000) return Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 2 : 1);
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: maxFractionDigits }).format(n);
}

/** Token or SOL amount with sensible precision. */
export function formatAmount(n: Num, opts: { maxDecimals?: number } = {}): string {
  if (!isNum(n)) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return formatCompact(n, 2);
  const decimals = opts.maxDecimals ?? (abs >= 1_000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6);
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

export function formatSol(n: Num, opts: { maxDecimals?: number } = {}): string {
  if (!isNum(n)) return DASH;
  return `${formatAmount(n, { maxDecimals: opts.maxDecimals ?? (Math.abs(n) >= 100 ? 1 : Math.abs(n) >= 1 ? 2 : 3) })} SOL`;
}

/** Percent with sign; input is already a percentage (12.3 = 12.3%). */
export function formatPct(n: Num, opts: { signed?: boolean; decimals?: number } = {}): string {
  if (!isNum(n)) return DASH;
  const signed = opts.signed ?? true;
  const abs = Math.abs(n);
  const decimals = opts.decimals ?? (abs >= 1_000 ? 0 : abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  const body = abs >= 10_000 ? formatCompact(abs, 1) : abs.toFixed(decimals);
  const sign = n > 0 && signed ? '+' : n < 0 ? '-' : '';
  return `${sign}${body}%`;
}

/** Age from a timestamp (ms): 12s, 4m, 3h, 5d, 2mo, 1y. */
export function formatAge(fromMs: Num, nowMs: number = Date.now()): string {
  if (!isNum(fromMs)) return DASH;
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d`;
  if (s < 365 * 86_400) return `${Math.floor(s / (30 * 86_400))}mo`;
  return `${Math.floor(s / (365 * 86_400))}y`;
}

/** Duration in seconds -> 45s, 12m, 3.5h, 2.1d. */
export function formatDuration(seconds: Num): string {
  if (!isNum(seconds)) return DASH;
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3_600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3_600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

export function formatTime(ms: Num, opts: { seconds?: boolean } = {}): string {
  if (!isNum(ms)) return DASH;
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: opts.seconds === false ? undefined : '2-digit',
  });
}

export function formatDateTime(ms: Num): string {
  if (!isNum(ms)) return DASH;
  return new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });
}

/** "Updated 4s ago" style freshness label. */
export function formatUpdated(ms: Num, nowMs: number = Date.now()): string {
  if (!isNum(ms)) return 'Waiting for data';
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 2) return 'Updated just now';
  return `Updated ${formatAge(ms, nowMs)} ago`;
}

/** Tailwind text colour class for a signed change. */
export function changeClass(n: Num): string {
  if (!isNum(n) || n === 0) return 'text-muted';
  return n > 0 ? 'text-up' : 'text-down';
}
