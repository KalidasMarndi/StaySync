import type { Redis } from 'ioredis';
import { closeRedisClient, createRedisClient, waitForRedisReady } from '../../src/config/redis';
import type { AppConfig } from '../../src/config/env';

/**
 * Integration tests use a REAL Redis server (start one with `npm run redis:up`).
 * They use logical database 15 and unique city names, and delete only the keys
 * they created — never FLUSHDB — so they cannot touch other data.
 */
export const TEST_REDIS_CONFIG: AppConfig['redis'] = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  db: 15,
  password: process.env.REDIS_PASSWORD,
};

export async function connectTestRedis(name = 'test'): Promise<Redis> {
  const redis = createRedisClient(TEST_REDIS_CONFIG, name);
  try {
    await waitForRedisReady(redis); // commands fail fast until connected (no offline queue)
    await redis.ping();
  } catch (err) {
    await closeRedisClient(redis);
    throw new Error(
      `Redis integration tests need Redis at ${TEST_REDIS_CONFIG.host}:${TEST_REDIS_CONFIG.port}. ` +
        'Start one with: npm run redis:up',
      { cause: err },
    );
  }
  return redis;
}
