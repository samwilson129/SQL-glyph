import { createHash } from 'node:crypto';
import type { ConversionResult } from '../types/conversion';

export interface ConversionCacheKeyParts {
  readonly action: 'transpile' | 'format';
  readonly sql: string;
  readonly source: string;
  readonly target: string;
  readonly pretty: boolean;
  readonly sqlglotVersion: string;
}

export interface ConversionCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface ConversionCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
}

interface CacheEntry {
  readonly payload: ConversionResult;
  readonly expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 40;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Small in-memory cache for successful conversions.
 *
 * The key deliberately includes the SQL content hash, the dialect pair, the
 * pretty-print flag, and the SQLGlot version so a dependency upgrade cannot
 * serve stale output. Failed requests are never cached.
 */
export class ConversionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;

  constructor(options: ConversionCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  static key(parts: ConversionCacheKeyParts): string {
    const hash = createHash('sha256').update(parts.sql, 'utf8').digest('hex');
    return [
      parts.action,
      hash,
      parts.source,
      parts.target,
      parts.pretty ? 'pretty' : 'compact',
      parts.sqlglotVersion
    ].join(':');
  }

  get(key: string): ConversionResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (this.ttlMs > 0 && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Refresh insertion order for a simple LRU eviction policy.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.payload;
  }

  set(key: string, payload: ConversionResult): void {
    if (payload.status === 'unsupported') {
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, {
      payload,
      expiresAt: this.ttlMs > 0 ? this.now() + this.ttlMs : Number.POSITIVE_INFINITY
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  get stats(): ConversionCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }
}
