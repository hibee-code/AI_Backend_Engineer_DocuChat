import crypto from 'crypto';
import IORedis from 'ioredis';
import { config } from './config';
import { logger } from './logger';

// Dedicated cache connection, separate from BullMQ's (queues/connection.ts).
// BullMQ needs maxRetriesPerRequest: null (wait forever); a cache should fail
// fast instead, so a Redis outage can't hang API requests.
// lazyConnect: no connection is opened until the first cache call.
export const cacheRedis = new IORedis(config.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});

// TTL constants in seconds
export const CACHE_TTL = {
  PERMISSIONS: 300, // 5 minutes
  DOCUMENT: 600, // 10 minutes
  CONVERSATION_LIST: 120, // 2 minutes
  EMBEDDING: 604800, // 7 days
  RAG_RESULT: 3600, // 1 hour
} as const;

// The cache is an optimisation, so reads and writes fail open: if Redis is
// down, a read is a miss and a write is skipped, and callers fall through to
// the database. Deletes (cache invalidation) still throw, so a failed
// invalidation is never silently ignored.
async function failOpen<T>(operation: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    logger.warn('Cache unavailable, continuing without it', {
      operation,
      error: (error as Error).message,
    });
    return fallback;
  }
}

function parseCached<T>(raw: string | null): T | null {
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  return failOpen('get', null, async () => parseCached<T>(await cacheRedis.get(key)));
}

// One round trip for many keys. Results line up with `keys`; misses are null.
export async function cacheGetMany<T>(keys: string[]): Promise<(T | null)[]> {
  if (keys.length === 0) return [];
  return failOpen('mget', keys.map(() => null), async () => {
    const raws = await cacheRedis.mget(...keys);
    return raws.map((raw) => parseCached<T>(raw));
  });
}

export async function cacheSet(
  key: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  ttlSeconds: number,
): Promise<void> {
  await failOpen('set', undefined, async () => {
    await cacheRedis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  });
}

// One round trip for many writes
export async function cacheSetMany(
  entries: { key: string; value: unknown }[],
  ttlSeconds: number,
): Promise<void> {
  if (entries.length === 0) return;
  await failOpen('mset', undefined, async () => {
    const pipeline = cacheRedis.pipeline();
    for (const { key, value } of entries) {
      pipeline.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    }
    await pipeline.exec();
  });
}

export async function cacheDel(key: string): Promise<void> {
  await cacheRedis.del(key);
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  // Use SCAN, never KEYS (KEYS blocks Redis on large datasets)
  const stream = cacheRedis.scanStream({ match: pattern, count: 100 });
  const pipeline = cacheRedis.pipeline();

  for await (const keys of stream) {
    for (const key of keys) {
      pipeline.del(key);
    }
  }

  await pipeline.exec();
}

export function hashKey(...parts: string[]): string {
  const data = parts.join(':');
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

export async function cacheGetOrSet<T>(
  key: string,
  ttlSeconds: number,
  fetchFn: () => Promise<T>,
): Promise<T> {
  // 1. Try cache
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;

  // 2. Try to acquire lock
  const lockKey = `lock:${key}`;
  const acquired = await failOpen('lock', 'UNAVAILABLE' as const, () =>
    cacheRedis.set(
      lockKey,
      '1',
      'EX',
      5,
      'NX', // Expires in 5s, only if not exists
    ),
  );

  // Redis is down: no cache and no lock, so just fetch
  if (acquired === 'UNAVAILABLE') return fetchFn();

  if (acquired) {
    // We got the lock. Fetch and cache.
    try {
      const value = await fetchFn();
      await cacheSet(key, value, ttlSeconds);
      return value;
    } finally {
      await failOpen('unlock', undefined, async () => {
        await cacheRedis.del(lockKey);
      });
    }
  }

  // 3. Someone else has the lock. Wait briefly, then try cache again.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const retried = await cacheGet<T>(key);
  if (retried !== null) return retried;

  // 4. Lock holder failed or cache still empty. Just fetch directly.
  return fetchFn();
}
