import 'server-only';

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
