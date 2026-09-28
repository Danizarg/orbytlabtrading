import type { ApiEnvelope, ApiErrorBody, ApiMeta } from '@/lib/core/api';

/** Error thrown by the typed client fetcher; carries the server's meta when present. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly meta?: ApiMeta;

  constructor(status: number, code: string, message: string, meta?: ApiMeta) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.meta = meta;
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined | null | readonly string[]>;

export function buildUrl(path: string, params?: QueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * GET an ORBYT API route and return its envelope. Throws ApiError for non-2xx
 * responses so React Query keeps the last good data and exposes the error.
 */
export async function apiGet<T>(path: string, params?: QueryParams, init?: { signal?: AbortSignal }): Promise<ApiEnvelope<T>> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, params), { signal: init?.signal, headers: { accept: 'application/json' } });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Network unavailable. Check your connection.');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, 'malformed', `Unexpected response (${res.status}).`);
  }
  if (!res.ok) {
    const err = body as Partial<ApiErrorBody>;
    throw new ApiError(res.status, err.error?.code ?? 'error', err.error?.message ?? `Request failed (${res.status}).`, err.meta);
  }
  return body as ApiEnvelope<T>;
}
