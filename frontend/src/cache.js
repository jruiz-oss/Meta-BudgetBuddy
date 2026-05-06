/**
 * Tiny module-level TTL cache.
 * Lives at the JS module scope so it persists across React component
 * mount/unmount cycles (i.e. page navigation), but resets on hard refresh.
 *
 * Usage:
 *   import { getCached, setCached, invalidateCache } from '../cache';
 *   const data = getCached('home');               // null if missing/stale
 *   setCached('home', responseData);
 *   invalidateCache('home');                      // e.g. after a pacing run
 */

const _store = {};
const DEFAULT_TTL_MS = 90_000; // 90 seconds

export function getCached(key, ttlMs = DEFAULT_TTL_MS) {
  const entry = _store[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) {
    delete _store[key];
    return null;
  }
  return entry.data;
}

export function setCached(key, data) {
  _store[key] = { data, ts: Date.now() };
}

export function invalidateCache(...keys) {
  keys.forEach((k) => delete _store[k]);
}

export function invalidateAll() {
  Object.keys(_store).forEach((k) => delete _store[k]);
}
