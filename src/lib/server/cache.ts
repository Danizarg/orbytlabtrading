import 'server-only';

/**
 * Small in-memory TTL cache with in-flight request de-duplication and
 * stale-if-error semantics. Instances are per serverless worker: this is a
 * first-level cache in front of Vercel's CDN (which caches whole API
 * responses via `s-maxage`), not a shared store.
 */

interface Entry<V> {
  value: V;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
}

export interface CachedResult<V> {
  value: V;
  /** When the value was produced by the loader (ms epoch). */
  storedAt: number;
  /** True when served from memory without calling the loader. */
  fromCache: boolean;
  /** True when the loader failed and an expired value was served instead. */
  stale: boolean;
  /** The loader error that forced a stale response, if any. */
  error?: unknown;
}

export interface CacheOptions {
  /** How long a value is served without re-loading. */
  ttlMs: number;
  /** Extra time an expired value may be served if the loader fails. */
  staleMs?: number;
}

const MAX_ENTRIES = 2_000;

class TtlCache {
  private entries = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<CachedResult<unknown>>>();

  get<V>(key: string): Entry<V> | undefined {
    const entry = this.entries.get(key) as Entry<V> | undefined;
    if (!entry) return undefined;
    if (Date.now() > entry.staleUntil) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set<V>(key: string, value: V, opts: CacheOptions): Entry<V> {
    const now = Date.now();
    const entry: Entry<V> = {
      value,
      storedAt: now,
      freshUntil: now + opts.ttlMs,
      staleUntil: now + opts.ttlMs + (opts.staleMs ?? 0),
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > MAX_ENTRIES) {
      // Map preserves insertion order: drop the oldest entries first.
      const excess = this.entries.size - MAX_ENTRIES;
      let i = 0;
      for (const k of this.entries.keys()) {
        if (i++ >= excess) break;
        this.entries.delete(k);
      }
    }
    return entry;
  }

  async getOrLoad<V>(key: string, opts: CacheOptions, loader: () => Promise<V>): Promise<CachedResult<V>> {
    const existing = this.get<V>(key);
    if (existing && Date.now() <= existing.freshUntil) {
      return { value: existing.value, storedAt: existing.storedAt, fromCache: true, stale: false };
    }
    const pending = this.inflight.get(key) as Promise<CachedResult<V>> | undefined;
    if (pending) return pending;

    const run = (async (): Promise<CachedResult<V>> => {
      try {
        const value = await loader();
        const entry = this.set(key, value, opts);
        return { value, storedAt: entry.storedAt, fromCache: false, stale: false };
      } catch (error) {
        const fallback = this.get<V>(key);
        if (fallback) {
          return { value: fallback.value, storedAt: fallback.storedAt, fromCache: true, stale: true, error };
        }
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, run as Promise<CachedResult<unknown>>);
    return run;
  }
}

const globalCache = globalThis as unknown as { __orbytCache?: TtlCache };
export const memoryCache: TtlCache = globalCache.__orbytCache ?? (globalCache.__orbytCache = new TtlCache());

/** Convenience wrapper: cache the loader's value under `key`. */
export function cached<V>(key: string, opts: CacheOptions, loader: () => Promise<V>): Promise<CachedResult<V>> {
  return memoryCache.getOrLoad(key, opts, loader);
}

/** TTL presets (ms) by data volatility. */
export const TTL = {
  stream: 2_000,
  trades: 3_000,
  price: 5_000,
  market: 10_000,
  discovery: 15_000,
  holders: 60_000,
  candlesRecent: 15_000,
  candlesHistoric: 10 * 60_000,
  metadata: 30 * 60_000,
  static: 6 * 60 * 60_000,
} as const;
