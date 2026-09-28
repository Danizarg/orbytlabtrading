import type { ProviderId } from './providers';
import type { Sourced } from './types';
import { describeError, isAbortError, isProviderError, ProviderError } from '@/lib/net/errors';

/**
 * Provider failover. Steps run in order; the first successful (and accepted)
 * result wins. Failures are collected so the UI can show which sources were
 * tried. Aborts propagate immediately.
 */

export interface ChainStep<T> {
  id: ProviderId;
  run: () => Promise<Sourced<T>>;
  /** Skip without calling (e.g. provider not configured / cooling down). */
  skip?: boolean;
}

export interface ChainAttempt {
  provider: ProviderId;
  ok: boolean;
  error?: string;
  code?: string;
}

export type ChainResult<T> = Sourced<T> & { attempts: ChainAttempt[] };

export class ChainError extends Error {
  readonly attempts: ChainAttempt[];
  readonly allNotFound: boolean;
  readonly allNotConfigured: boolean;

  constructor(label: string, attempts: ChainAttempt[]) {
    const summary = attempts.length ? attempts.map((a) => a.error ?? a.provider).join('; ') : 'no provider available';
    super(`${label}: ${summary}`);
    this.name = 'ChainError';
    this.attempts = attempts;
    this.allNotFound = attempts.length > 0 && attempts.every((a) => a.code === 'not_found');
    this.allNotConfigured = attempts.length > 0 && attempts.every((a) => a.code === 'not_configured');
  }
}

export async function runChain<T>(
  label: string,
  steps: Array<ChainStep<T> | false | null | undefined>,
  opts: {
    /** Reject a successful but unusable result (e.g. empty list) and try the next step. */
    accept?: (result: Sourced<T>) => boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ChainResult<T>> {
  const attempts: ChainAttempt[] = [];
  let fallback: Sourced<T> | undefined;
  for (const step of steps) {
    if (!step || step.skip) continue;
    if (opts.signal?.aborted) throw new ProviderError(step.id, 'aborted', `${label}: aborted`);
    try {
      const result = await step.run();
      if (opts.accept && !opts.accept(result)) {
        attempts.push({ provider: step.id, ok: false, error: `${step.id}: no usable data`, code: 'empty' });
        fallback ??= result;
        continue;
      }
      attempts.push({ provider: step.id, ok: true });
      return { ...result, attempts };
    } catch (error) {
      if (isAbortError(error)) throw error;
      attempts.push({
        provider: step.id,
        ok: false,
        error: describeError(error),
        code: isProviderError(error) ? error.code : undefined,
      });
    }
  }
  // Every step was rejected by `accept` but at least one answered: return that honest (e.g. empty) answer.
  if (fallback) return { ...fallback, attempts };
  throw new ChainError(label, attempts);
}

/**
 * Fill undefined fields of `primary` from `secondary` (shallow). Never
 * overwrites a defined primary value; used to merge provider data without
 * inventing anything.
 */
export function fillMissing<T extends object>(primary: T, secondary: Partial<T> | undefined): T {
  if (!secondary) return primary;
  const out = { ...primary } as Record<string, unknown>;
  for (const [key, value] of Object.entries(secondary)) {
    if (out[key] === undefined && value !== undefined) out[key] = value;
  }
  return out as T;
}

/** Split an array into chunks of `size` (provider batch limits). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Parse a provider numeric value (number or numeric string); undefined when absent/invalid. */
export function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse an ISO string / seconds / milliseconds timestamp into ms. */
export function toMs(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    if (/^\d+(\.\d+)?$/.test(value)) return toMs(Number(value));
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}
