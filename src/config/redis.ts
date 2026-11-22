import { once } from 'node:events';
import { Redis } from 'ioredis';
import { logger } from '../utils/logger';
import type { AppConfig } from './env';

/**
 * Creates an ioredis client from configuration (host/port/password/db come
 * from environment variables — "redis" in Docker, "localhost" locally).
 *
 * Failure behaviour:
 *  - Reconnects forever in the background with capped backoff (200ms, 400ms … max 5s).
 *  - While disconnected, commands fail IMMEDIATELY (no offline queue), and a command
 *    whose caller already received an error is never re-sent after reconnecting.
 *    Otherwise a cache write that "failed" (and was reported as cached: false) could
 *    still land in Redis seconds later — possibly over newer data. Resilience comes
 *    from Temporal activity retries and the API's workflow fallback instead.
 *  - Commands on a live connection time out after 3s.
 */
export function createRedisClient(redisConfig: AppConfig['redis'], name: string): Redis {
  const log = logger.child({ component: 'redis', connection: name });

  const client = new Redis({
    host: redisConfig.host,
    port: redisConfig.port,
    db: redisConfig.db,
    password: redisConfig.password,
    // Upstash requires the ACL username "default" alongside the password.
    ...(redisConfig.tls && redisConfig.password ? { username: 'default' } : {}),
    tls: redisConfig.tls ? {} : undefined,
    connectionName: `staysync-${name}`,
    connectTimeout: 5_000,
    commandTimeout: 3_000,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  client.on('ready', () =>
    log.info({ host: redisConfig.host, port: redisConfig.port, db: redisConfig.db }, 'Redis ready'),
  );
  client.on('error', (err: Error) => log.warn({ err: { message: err.message } }, 'Redis error'));
  client.on('close', () => log.debug('Redis connection closed'));
  client.on('reconnecting', (delayMs: number) => log.info({ delayMs }, 'Redis reconnecting'));
  client.on('end', () => log.info('Redis connection ended'));

  return client;
}

/** Resolves once the client is connected (useful at startup and in tests). */
export async function waitForRedisReady(client: Redis, timeoutMs = 5_000): Promise<void> {
  if (client.status === 'ready') return;
  await once(client, 'ready', { signal: AbortSignal.timeout(timeoutMs) });
}

/** Graceful close: QUIT lets pending replies finish; force-disconnect if that fails. */
export async function closeRedisClient(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  try {
    if (client.status === 'ready') {
      await client.quit();
    } else {
      client.disconnect();
    }
  } catch {
    client.disconnect();
  }
}
