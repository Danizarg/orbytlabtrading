import type { ProviderId } from '@/lib/core/providers';

export interface JsonRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** JSON-serialisable body for POST. */
  body?: unknown;
  /** Per-attempt timeout (ms). */
  timeoutMs?: number;
  /** Retries for network errors / 5xx (GET default 1, POST default 0). */
  retries?: number;
  /** Label used in errors instead of the URL (URLs may contain API keys). */
  label?: string;
  /** Reuse an identical successful response for this long (ms). Browser fetcher only. */
  cacheMs?: number;
  /** Treat HTTP 404 as ProviderError('not_found') (default true). */
  notFoundAs404?: boolean;
  signal?: AbortSignal;
}

/**
 * Transport injected into provider adapters so the same adapter code runs in
 * the browser (keyless, per-user quotas) and on the server (keys, RPC).
 * Resolves with parsed JSON or rejects with ProviderError.
 */
export type JsonFetcher = <T = unknown>(provider: ProviderId, url: string, init?: JsonRequest) => Promise<T>;
