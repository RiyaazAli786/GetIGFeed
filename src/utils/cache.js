'use strict';

/**
 * Lightweight, zero-dependency in-memory LRU TTL Cache.
 * Stores response payloads for frequent API endpoints to avoid redundant network roundtrips.
 */
class MemoryCache {
  /**
   * @param {number} defaultTtlMs TTL in milliseconds (default 30 seconds)
   * @param {number} maxItems Max cached entries before oldest entries are evicted
   */
  constructor(defaultTtlMs = 30000, maxItems = 500) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxItems = maxItems;
    this.store = new Map();
  }

  /**
   * Generate cache key from endpoint and parameters object
   */
  static makeKey(namespace, params) {
    if (typeof params === 'string') return `${namespace}:${params.toLowerCase()}`;
    return `${namespace}:${JSON.stringify(params)}`;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    // Refresh LRU order
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (ttlMs <= 0) return;

    if (this.store.size >= this.maxItems) {
      // Evict oldest item
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  clear() {
    this.store.clear();
  }
}

// Singleton instances for API caching
const feedCache = new MemoryCache(Number(process.env.CACHE_TTL_MS) || 30000); // 30s default
const publicCache = new MemoryCache(Number(process.env.CACHE_TTL_MS) || 30000);

module.exports = { MemoryCache, feedCache, publicCache };
