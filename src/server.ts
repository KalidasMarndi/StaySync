import { createServer } from 'node:http';
import { createApp } from './app';
import { ConfigError, loadConfig } from './config/env';
import { closeRedisClient, createRedisClient } from './config/redis';
import { createHealthProbes } from './services/health-probes';
import { HealthService } from './services/health.service';
import { HotelService } from './services/hotel.service';
import { HotelCacheService } from './services/redis.service';
import { createTemporalClient, HotelWorkflowClient } from './temporal/client';
import { logger } from './utils/logger';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

function main(): void {
  const config = loadConfig();
  // Lazy Temporal connection and background Redis connection: the API starts even if either
  // is down; requests fall back or fail with 503, and /health reports the outage.
  const temporal = createTemporalClient(config);
  const hotelWorkflows = new HotelWorkflowClient(
    temporal.client,
    config.temporal.taskQueue,
    temporal.connection,
  );
  const redis = createRedisClient(config.redis, 'api');
  const hotelService = new HotelService({
    cache: new HotelCacheService(redis, config.cache),
    workflows: hotelWorkflows,
  });
  const healthService = new HealthService(
    createHealthProbes({
      config,
      redis,
      temporalClient: temporal.client,
      temporalConnection: temporal.connection,
      timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
    }),
    { timeoutMs: HEALTH_PROBE_TIMEOUT_MS },
  );
  const server = createServer(createApp(config, { hotelService, hotelWorkflows, healthService }));

  server.on('error', (err) => {
    logger.fatal({ err }, 'HTTP server error');
    process.exit(1);
  });

  server.listen(config.port, () => {
    // Connection targets only — never passwords or other secrets.
    logger.info(
      {
        port: config.port,
        nodeEnv: config.nodeEnv,
        redis: `${config.redis.host}:${config.redis.port}/${config.redis.db}`,
        temporal: `${config.temporal.address} (${config.temporal.namespace}/${config.temporal.taskQueue})`,
      },
      'StaySync API listening',
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    // A second signal (e.g. SIGTERM then Ctrl+C) must not close Redis/Temporal under
    // requests that are still being drained.
    if (shuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress');
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    // 1) stop accepting connections and let in-flight requests finish, 2) close Temporal + Redis.
    server.close((err) => {
      if (err) logger.error({ err }, 'Error while closing HTTP server');
      Promise.allSettled([hotelWorkflows.close(), closeRedisClient(redis)])
        .then(([temporalClosed, redisClosed]) => {
          const failures = { temporal: temporalClosed, redis: redisClosed };
          for (const [dependency, result] of Object.entries(failures)) {
            if (result.status === 'rejected') {
              logger.error({ dependency, err: result.reason }, 'Error closing connection');
            }
          }
          const clean =
            !err && temporalClosed.status === 'fulfilled' && redisClosed.status === 'fulfilled';
          logger.info({ clean }, 'StaySync API stopped');
          process.exit(clean ? 0 : 1);
        })
        .catch(() => process.exit(1));
    });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

try {
  main();
} catch (err) {
  if (err instanceof ConfigError) {
    logger.fatal({ issues: err.issues }, 'Invalid configuration, refusing to start');
  } else {
    logger.fatal({ err }, 'Failed to start API');
  }
  process.exit(1);
}
