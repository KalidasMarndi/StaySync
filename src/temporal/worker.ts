/**
 * Temporal worker entry point — a separate process from the Express API.
 *
 * It long-polls the task queue on the Temporal server, runs workflow code in
 * Temporal's deterministic sandbox, and runs activities (supplier HTTP calls)
 * as normal Node.js code. It shuts down gracefully on SIGINT/SIGTERM.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { makeTelemetryFilterString, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { createActivities } from '../activities';
import { ConfigError, loadConfig, type AppConfig } from '../config/env';
import { closeRedisClient, createRedisClient } from '../config/redis';
import { HotelCacheService } from '../services/redis.service';
import { logger } from '../utils/logger';
import { PinoTemporalLogger } from './logger';

const CONNECT_ATTEMPTS = 10;
const CONNECT_RETRY_DELAY_MS = 2_000;
const workerLogger = logger.child({ component: 'worker' });

/** Temporal may still be booting (e.g. in Docker Compose), so retry the initial connection. */
async function connectWithRetry(address: string): Promise<NativeConnection> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await NativeConnection.connect({ address });
    } catch (err) {
      if (attempt >= CONNECT_ATTEMPTS) throw err;
      workerLogger.warn(
        { address, attempt, maxAttempts: CONNECT_ATTEMPTS, err },
        'Temporal not reachable yet, retrying',
      );
      await delay(CONNECT_RETRY_DELAY_MS);
    }
  }
}

async function run(config: AppConfig): Promise<void> {
  // Must run before any connection is created. Signals make worker.run() resolve gracefully.
  Runtime.install({
    logger: new PinoTemporalLogger(workerLogger),
    shutdownSignals: ['SIGINT', 'SIGTERM'],
    telemetryOptions: {
      logging: { forward: {}, filter: makeTelemetryFilterString({ core: 'WARN' }) },
    },
  });

  // Redis is used by the cache activity. ioredis connects (and reconnects) in the background.
  const redis = createRedisClient(config.redis, 'worker');
  const hotelCache = new HotelCacheService(redis, config.cache);

  const connection = await connectWithRetry(config.temporal.address);
  try {
    const worker = await Worker.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue: config.temporal.taskQueue,
      // Workflow code runs in Temporal's isolated, deterministic sandbox. In Docker the bundle
      // is pre-built at image build time; locally it is bundled from source at startup.
      ...(config.temporal.workflowBundlePath
        ? { workflowBundle: { codePath: config.temporal.workflowBundlePath } }
        : { workflowsPath: require.resolve('../workflows') }),
      activities: createActivities(config, { hotelCache }),
      shutdownGraceTime: '10 seconds',
    });

    workerLogger.info(
      {
        address: config.temporal.address,
        namespace: config.temporal.namespace,
        taskQueue: config.temporal.taskQueue,
        supplierA: config.suppliers.supplierA.baseUrl,
        supplierB: config.suppliers.supplierB.baseUrl,
        redis: `${config.redis.host}:${config.redis.port}/${config.redis.db}`,
        workflowCode: config.temporal.workflowBundlePath ?? 'bundled at startup',
      },
      'Temporal worker started',
    );

    await worker.run(); // resolves once a shutdown signal has drained in-flight tasks
    workerLogger.info('Temporal worker stopped gracefully');
  } finally {
    await connection.close();
    await closeRedisClient(redis);
  }
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      workerLogger.fatal({ issues: err.issues }, 'Invalid configuration, refusing to start');
      process.exit(1);
    }
    throw err;
  }

  await run(config);
}

// Same safety net as the API: crash loudly with a structured log, never silently.
process.on('unhandledRejection', (reason) => {
  workerLogger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  workerLogger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

main().catch((err: unknown) => {
  workerLogger.fatal({ err }, 'Temporal worker crashed');
  process.exit(1);
});
