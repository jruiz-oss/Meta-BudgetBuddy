/**
 * Stale-while-revalidate module cache.
 *
 * getCached(key)      — returns data if it exists, regardless of age
 * isStale(key, ttl)   — true if the entry is older than ttl ms (default 90s)
 * setCached(key, data)
 * invalidateCache(...keys)
 *
 * Usage pattern in a component:
 *
 *   const cached = getCached('home');
 *   if (cached) {
 *     showData(cached);            // instant — never block on cache hit
 *     if (!isStale('home')) return; // fresh enough, done
 *     // else fall through and refresh silently in background
 *   }
 *   const fresh = await fetchFromServer();
 *   showData(fresh);
 *   setCached('home', fresh);
 */

const _store = {};
const DEFAULT_TTL_MS = 90_000; // 90 s — controls background-refresh frequency

export function getCached(key) {
  return _store[key]?.data ?? null;
}

export function isStale(key, ttlMs = DEFAULT_TTL_MS) {
  const entry = _store[key];
  if (!entry) return true;
  return Date.now() - entry.ts > ttlMs;
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
