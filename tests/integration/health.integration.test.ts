import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createActivities } from '../../src/activities';
import { createApp } from '../../src/app';
import { loadConfig, type AppConfig } from '../../src/config/env';
import { closeRedisClient, createRedisClient } from '../../src/config/redis';
import { createHealthProbes, SUPPLIER_PROBE_CITY } from '../../src/services/health-probes';
import { HealthService } from '../../src/services/health.service';
import { HotelCacheService, hotelCacheKeys } from '../../src/services/redis.service';
import type { HotelOffer } from '../../src/types/hotel.types';
import { startServer, type RunningServer } from '../helpers/http';
import { connectTestRedis } from '../helpers/redis';
import { installQuietTemporalRuntime, WORKFLOWS_PATH } from '../helpers/temporal';

/**
 * Health endpoints against REAL infrastructure: a real Redis, a real Temporal
 * dev server, a real worker polling its task queue, and the real supplier
 * endpoints over HTTP. Outages are produced with unreachable addresses and the
 * dev-only supplier toggle.
 */

const TIMEOUT_MS = 1_500;

let env: TestWorkflowEnvironment;
let redis: Redis;
let server: RunningServer;
let suppliersApp: Express;
let worker: Worker;
let workerRun: Promise<void>;
let taskQueue: string;
const supplierRequests: string[] = [];

function configFor(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    TEMPORAL_TASK_QUEUE: taskQueue,
    SUPPLIER_A_BASE_URL: `${server.baseUrl}/supplierA`,
    SUPPLIER_B_BASE_URL: `${server.baseUrl}/supplierB`,
    ...overrides,
  });
}

/** Builds an app whose /health uses real probes; any dependency can be swapped for a dead one. */
function healthApp(
  options: {
    redis?: Redis;
    temporal?: { client: Client; connection: Connection };
    queue?: string;
  } = {},
) {
  const config = configFor(options.queue ? { TEMPORAL_TASK_QUEUE: options.queue } : {});
  const temporal = options.temporal ?? { client: env.client, connection: env.connection };
  const healthService = new HealthService(
    createHealthProbes({
      config,
      redis: options.redis ?? redis,
      temporalClient: temporal.client,
      temporalConnection: temporal.connection,
      timeoutMs: TIMEOUT_MS,
    }),
    { timeoutMs: TIMEOUT_MS, cacheTtlMs: 0 },
  );
  return createApp(config, { healthService });
}

/**
 * A lazy connection to an address where nothing listens. Deliberately NOT closed by
 * the test: a probe may give up while the SDK still has a gRPC retry scheduled
 * (grpc-retry.js uses an uncancelled setTimeout), and closing the channel then makes
 * that timer throw "Channel has been shut down". The test process exit releases it.
 */
function deadTemporal(): { client: Client; connection: Connection } {
  const connection = Connection.lazy({ address: '127.0.0.1:1', connectTimeout: '1 second' });
  return { client: new Client({ connection }), connection };
}

async function setSupplier(id: 'supplierA' | 'supplierB', enabled: boolean): Promise<void> {
  await request(suppliersApp)
    .put(`/dev/suppliers/${id}/availability`)
    .send({ enabled })
    .expect(200);
}

async function workflowCount(): Promise<number> {
  return (await env.client.workflow.count()).count;
}

beforeAll(async () => {
  installQuietTemporalRuntime();
  redis = await connectTestRedis('health');
  env = await TestWorkflowEnvironment.createLocal();
  taskQueue = `health-${randomUUID()}`;

  suppliersApp = createApp(
    loadConfig({ NODE_ENV: 'development', ENABLE_FAILURE_SIMULATION: 'true' }),
  );
  server = await startServer((req, res) => {
    if (req.url?.startsWith('/supplier')) supplierRequests.push(req.url);
    suppliersApp(req, res);
  });

  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH }),
    activities: createActivities(configFor(), {
      hotelCache: new HotelCacheService(redis, { ttlSeconds: 300, degradedTtlSeconds: 30 }),
    }),
  });
  workerRun = worker.run();
  // Wait until Temporal has registered the worker's poll.
  for (let i = 0; i < 50; i += 1) {
    const res = await request(healthApp()).get('/health');
    if (res.body.services.worker.status === 'healthy') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 120_000);

beforeEach(async () => {
  await setSupplier('supplierA', true);
  await setSupplier('supplierB', true);
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun;
  await server?.close();
  await env?.teardown();
  if (redis) await closeRedisClient(redis);
});

describe('GET /health with real dependencies', () => {
  it('all dependencies healthy (including a live worker) → 200 healthy', async () => {
    const res = await request(healthApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.ready).toBe(true);
    for (const name of ['api', 'redis', 'temporal', 'worker', 'supplierA', 'supplierB']) {
      expect(res.body.services[name].status).toBe('healthy');
    }
    expect(res.body.services.worker.details.activePollers).toBeGreaterThanOrEqual(1);
  });

  it('Temporal reachable but NO worker on the task queue → worker unhealthy', async () => {
    const res = await request(healthApp({ queue: `nobody-polls-${randomUUID()}` })).get('/health');

    expect(res.body.services.temporal.status).toBe('healthy');
    expect(res.body.services.worker).toMatchObject({
      status: 'unhealthy',
      error: expect.stringContaining('no worker polling task queue'),
    });
    expect(res.body.status).toBe('degraded');
  });

  it('Redis unavailable → redis unhealthy, degraded, still ready', async () => {
    const deadRedis = createRedisClient(
      { host: '127.0.0.1', port: 1, db: 0, password: undefined },
      'dead',
    );
    const res = await request(healthApp({ redis: deadRedis })).get('/health');
    await closeRedisClient(deadRedis);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.ready).toBe(true);
    expect(res.body.services.redis.status).toBe('unhealthy');
    expect(res.body.services.redis.error).toMatch(/^not connected/);
  });

  it('Temporal unavailable → temporal unhealthy, worker unknown, within the timeout', async () => {
    const started = Date.now();
    const res = await request(healthApp({ temporal: deadTemporal() })).get('/health');
    const elapsed = Date.now() - started;

    expect(res.body.services.temporal.status).toBe('unhealthy');
    expect(res.body.services.worker.status).toBe('unknown');
    expect(res.body.status).toBe('degraded'); // Redis still serves cache hits
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 1_000);
  });

  it('Redis AND Temporal unavailable → 503 unhealthy; ready 503; live 200', async () => {
    const deadRedis = createRedisClient(
      { host: '127.0.0.1', port: 1, db: 0, password: undefined },
      'dead',
    );
    const app = healthApp({ redis: deadRedis, temporal: deadTemporal() });

    const [health, ready, live] = await Promise.all([
      request(app).get('/health'),
      request(app).get('/health/ready'),
      request(app).get('/health/live'),
    ]);
    await closeRedisClient(deadRedis);

    expect(health.status).toBe(503);
    expect(health.body.status).toBe('unhealthy');
    expect(ready.status).toBe(503);
    expect(ready.body.status).toBe('not_ready');
    expect(live.status).toBe(200);
    expect(live.body.status).toBe('alive');
  });

  it('Supplier A down → only Supplier A unhealthy', async () => {
    await setSupplier('supplierA', false);
    const res = await request(healthApp()).get('/health');

    expect(res.body.services.supplierA).toMatchObject({ status: 'unhealthy', error: 'HTTP 503' });
    expect(res.body.services.supplierB.status).toBe('healthy');
    expect(res.body.status).toBe('degraded');
  });

  it('Supplier B down → only Supplier B unhealthy', async () => {
    await setSupplier('supplierB', false);
    const res = await request(healthApp()).get('/health');

    expect(res.body.services.supplierB).toMatchObject({ status: 'unhealthy', error: 'HTTP 503' });
    expect(res.body.services.supplierA.status).toBe('healthy');
  });

  it('both suppliers down → 503 unhealthy, but ready (cache hits still served)', async () => {
    await setSupplier('supplierA', false);
    await setSupplier('supplierB', false);
    const app = healthApp();

    const health = await request(app).get('/health');
    const ready = await request(app).get('/health/ready');

    expect(health.status).toBe(503);
    expect(health.body.status).toBe('unhealthy');
    expect(ready.status).toBe(200);
  });

  it('a supplier that hangs is reported as timed out', async () => {
    const hanging = await startServer(() => undefined); // accepts, never answers
    const config = configFor({ SUPPLIER_A_BASE_URL: `${hanging.baseUrl}/supplierA` });
    const app = createApp(config, {
      healthService: new HealthService(
        createHealthProbes({
          config,
          redis,
          temporalClient: env.client,
          temporalConnection: env.connection,
          timeoutMs: 300,
        }),
        { timeoutMs: 300, cacheTtlMs: 0 },
      ),
    });

    const res = await request(app).get('/health');
    await hanging.close();

    expect(res.body.services.supplierA).toMatchObject({
      status: 'unhealthy',
      error: 'timed out after 300ms',
    });
    expect(res.body.services.supplierB.status).toBe('healthy');
  });
});

describe('health checks have no side effects', () => {
  it('never start a workflow, never aggregate, and never change cached hotel data', async () => {
    const city = `health side effects ${randomUUID().slice(0, 8)}`;
    const cache = new HotelCacheService(redis, { ttlSeconds: 300, degradedTtlSeconds: 30 });
    const hotels: HotelOffer[] = [
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
    ];
    await cache.saveHotels(city, hotels, {
      degraded: false,
      suppliers: {
        supplierA: { status: 'success', count: 1 },
        supplierB: { status: 'success', count: 1 },
      },
    });
    const keys = hotelCacheKeys(city);
    const snapshot = async () => ({
      zset: await redis.zrange(keys.zset, 0, -1, 'WITHSCORES'),
      hash: await redis.hgetall(keys.hash),
      meta: await redis.get(keys.meta),
      expiresAt: await Promise.all(
        [keys.zset, keys.hash, keys.meta].map((k) => redis.call('PEXPIRETIME', k)),
      ),
      dbsize: await redis.dbsize(),
    });

    const workflowsBefore = await workflowCount();
    const cacheBefore = await snapshot();
    supplierRequests.length = 0;

    const app = healthApp();
    for (let i = 0; i < 5; i += 1) {
      await request(app).get('/health').expect(200);
      await request(app).get('/health/ready').expect(200);
    }

    expect(await workflowCount()).toBe(workflowsBefore); // no workflow started
    expect(await snapshot()).toEqual(cacheBefore); // cache untouched (same data, same expiry)
    // Supplier probes only ever ask for the probe city — never a real aggregation.
    expect(supplierRequests.length).toBeGreaterThan(0);
    expect(supplierRequests.every((url) => url.includes(`city=${SUPPLIER_PROBE_CITY}`))).toBe(true);
    await cache.deleteCityCache(city);
  });
});
