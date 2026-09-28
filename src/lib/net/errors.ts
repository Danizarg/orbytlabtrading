import type { ProviderId } from '@/lib/core/providers';

/** Isomorphic error type for every provider call (browser and server). */
export type ProviderErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'http'
  | 'not_found'
  | 'network'
  | 'malformed'
  | 'not_configured'
  | 'unsupported'
  | 'aborted';

export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    provider: ProviderId,
    code: ProviderErrorCode,
    message: string,
    opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ProviderError');
}

export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === 'AbortError') ||
    (isProviderError(e) && e.code === 'aborted') ||
    (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError')
  );
}

/** Short, user-safe description of any error (never includes URLs or keys). */
export function describeError(e: unknown): string {
  if (isProviderError(e)) {
    const p = e.provider;
    switch (e.code) {
      case 'rate_limited':
        return `${p}: rate limited`;
      case 'timeout':
        return `${p}: timed out`;
      case 'not_configured':
        return `${p}: not configured`;
      case 'not_found':
        return `${p}: not found`;
      case 'malformed':
        return `${p}: unexpected response`;
      case 'unsupported':
        return `${p}: not supported`;
      case 'aborted':
        return `${p}: cancelled`;
      case 'http':
        return `${p}: HTTP ${e.status ?? 'error'}`;
      default:
        return `${p}: unavailable`;
    }
  }
  if (e instanceof Error && e.message && e.message.length < 160) return e.message;
  return 'unavailable';
}
