import 'server-only';
import type { ProviderId } from '@/lib/core/providers';

/**
 * Errors thrown by route services and mapped to responses by `handle()`.
 * Messages are static, user-safe text: they never echo request input,
 * upstream URLs or keys.
 */

/** Invalid request input → HTTP 400. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** No server-side provider is configured for this data → HTTP 501 (clients fall back silently). */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

/**
 * The routing provider answered but cannot quote this pair / amount (no
 * route, token not tradable, dust amount) → HTTP 404 `no_route`. This is a
 * final answer about the request, not an outage: it must not read as
 * "providers unavailable, retrying".
 */
export class NoRouteError extends Error {
  readonly provider: ProviderId;

  constructor(provider: ProviderId, message = 'No swap route found for this pair and amount.') {
    super(message);
    this.name = 'NoRouteError';
    this.provider = provider;
  }
}
