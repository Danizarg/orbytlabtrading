/**
 * Minimal Map-backed LRU cache. Used for immutable on-chain facts (parsed
 * transactions keyed by signature, derived PDAs) so repeated polls do not
 * refetch or re-derive them. Stored values may be `null` (a negative result
 * that is itself immutable, e.g. "this tx contains no trade for the mint"),
 * so use `has()` to distinguish a cached null from a miss.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('LruCache: maxEntries must be a positive integer');
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Returns the value and marks it most recently used (undefined on a miss). */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
