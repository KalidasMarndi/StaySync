import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createActivities } from '../../src/activities';
import { createApp } from '../../src/app';
import { loadConfig, type AppConfig } from '../../src/config/env';
import { closeRedisClient } from '../../src/config/redis';
import { HotelCacheService, hotelCacheKeys } from '../../src/services/redis.service';
import { HotelWorkflowClient } from '../../src/temporal/client';
import type { SupplierId } from '../../src/types/supplier.types';
import { SupplierUnavailableError } from '../../src/utils/errors';
import { startServer, type RunningServer } from '../helpers/http';
import { connectTestRedis } from '../helpers/redis';
import { installQuietTemporalRuntime, WORKFLOWS_PATH } from '../helpers/temporal';

/**
 * End-to-end Temporal integration — NO mocks:
 *   real Temporal dev server  ←→  real Worker (bundled workflow + real activities)
 *   real activities  ──HTTP──►  real Express mock-supplier endpoints
 *   real cache activity ──────►  real Redis (database 15)
 *   real HotelWorkflowClient starts the workflow
 * Supplier outages are triggered through the real dev-only toggle endpoint.
 */

const LATENCY_MS = 700;

let env: TestWorkflowEnvironment;
let api: RunningServer;
let worker: Worker;
let workerRun: Promise<void>;
let workflows: HotelWorkflowClient;
let redis: Redis;
let hotelCache: HotelCacheService;
const CITIES = ['delhi', 'mumbai', 'bangalore', 'atlantis'];

async function setSupplier(supplierId: SupplierId, enabled: boolean): Promise<void> {
  const res = await fetch(`${api.baseUrl}/dev/suppliers/${supplierId}/availability`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  installQuietTemporalRuntime();
  redis = await connectTestRedis('integration');
  hotelCache = new HotelCacheService(redis, { ttlSeconds: 300, degradedTtlSeconds: 30 });
  for (const city of CITIES) await hotelCache.deleteCityCache(city);
  env = await TestWorkflowEnvironment.createLocal();

  // Real Express app with mock suppliers, artificial latency and the outage toggle.
  api = await startServer(
    createApp(
      loadConfig({
        NODE_ENV: 'development',
        ENABLE_FAILURE_SIMULATION: 'true',
        SUPPLIER_LATENCY_MS: String(LATENCY_MS),
      }),
    ),
  );

  const config: AppConfig = loadConfig({
    NODE_ENV: 'test',
    SUPPLIER_A_BASE_URL: `${api.baseUrl}/supplierA`,
    SUPPLIER_B_BASE_URL: `${api.baseUrl}/supplierB`,
  });
  const taskQueue = `integration-${randomUUID()}`;

  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH }),
    activities: createActivities(config, { hotelCache }), // the same wiring the real worker uses
  });
  workerRun = worker.run();
  workflows = new HotelWorkflowClient(env.client, taskQueue);
}, 120_000);

afterEach(async () => {
  await setSupplier('supplierA', true);
  await setSupplier('supplierB', true);
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun;
  await api?.close();
  await env?.teardown();
  for (const city of CITIES) await hotelCache?.deleteCityCache(city);
  if (redis) await closeRedisClient(redis);
});

describe('Temporal + real supplier HTTP endpoints', () => {
  it('aggregates Delhi from both real supplier APIs', async () => {
    const run = await workflows.execute('delhi');

    expect(run.workflowId).toBe('hotel-offers:delhi');
    expect(run.result.suppliers).toEqual({
      supplierA: { status: 'success', count: 8 },
      supplierB: { status: 'success', count: 8 },
    });
    expect(run.result.degraded).toBe(false);
    expect(run.result.duplicatesResolved).toBe(5);
    expect(run.result.hotels).toEqual([
      { name: 'Zostel', price: 1800, supplier: 'Supplier B', commissionPct: 7 },
      { name: 'Bloomrooms', price: 3500, supplier: 'Supplier A', commissionPct: 9 },
      { name: 'Lemon Tree', price: 4200, supplier: 'Supplier A', commissionPct: 8 },
      { name: 'Ibis New Delhi', price: 4800, supplier: 'Supplier B', commissionPct: 12 },
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
      { name: 'Hyatt Regency', price: 9000, supplier: 'Supplier B', commissionPct: 15 },
      { name: 'ITC Maurya', price: 11000, supplier: 'Supplier A', commissionPct: 16 },
      { name: 'Taj Palace', price: 11800, supplier: 'Supplier B', commissionPct: 17 },
      { name: 'The Oberoi', price: 15000, supplier: 'Supplier A', commissionPct: 12 },
      { name: 'The Leela Palace', price: 18000, supplier: 'Supplier A', commissionPct: 14 },
    ]);

    // The cache activity wrote the same result to Redis (normal 300s TTL).
    expect(run.result.cached).toBe(true);
    const cached = await hotelCache.getHotels('delhi');
    expect(cached?.hotels).toEqual(run.result.hotels);
    expect(cached?.metadata).toMatchObject({ count: 11, degraded: false, ttlSeconds: 300 });
    const keys = hotelCacheKeys('delhi');
    expect(await redis.zscore(keys.zset, 'holtin')).toBe('5340');
    expect(await redis.ttl(keys.meta)).toBeGreaterThan(290);
    // Price filtering in Redis over the workflow's data.
    const filtered = await hotelCache.filterHotelsByPrice('delhi', {
      minPrice: 4000,
      maxPrice: 7000,
    });
    expect(filtered?.hotels.map((h) => h.name)).toEqual([
      'Lemon Tree',
      'Ibis New Delhi',
      'Holtin',
      'Radison',
    ]);
  });

  it('calls both suppliers in parallel (total ≈ one supplier latency, not two)', async () => {
    const run = await workflows.execute('mumbai');

    expect(run.result.hotels.length).toBeGreaterThan(0);
    expect(run.durationMs).toBeGreaterThanOrEqual(LATENCY_MS);
    expect(run.durationMs).toBeLessThan(LATENCY_MS * 2);
  });

  it('Bangalore: Supplier B returns [] successfully — not degraded', async () => {
    const run = await workflows.execute('bangalore');

    expect(run.result.degraded).toBe(false);
    expect(run.result.suppliers.supplierB).toEqual({ status: 'success', count: 0 });
    expect(run.result.hotels).toHaveLength(4);
    expect(run.result.hotels.every((h) => h.supplier === 'Supplier A')).toBe(true);
  });

  it('unknown city: empty, non-degraded result', async () => {
    const run = await workflows.execute('atlantis');
    expect(run.result.hotels).toEqual([]);
    expect(run.result.degraded).toBe(false);
    // An empty result is still a cache HIT.
    expect(run.result.cached).toBe(true);
    expect(await hotelCache.getHotels('atlantis')).toMatchObject({
      hotels: [],
      metadata: { count: 0 },
    });
  });

  it('Supplier A down (HTTP 503, retried 3×): returns Supplier B results, degraded', async () => {
    await setSupplier('supplierA', false);

    const run = await workflows.execute('delhi');

    expect(run.result.degraded).toBe(true);
    expect(run.result.suppliers.supplierA).toEqual({
      status: 'failed',
      count: 0,
      error: 'SupplierUnavailable: Supplier A is unavailable (HTTP 503)',
    });
    expect(run.result.hotels).toHaveLength(8);
    expect(run.result.hotels.every((h) => h.supplier === 'Supplier B')).toBe(true);
    // 3 attempts with 500ms + 1s backoff in between.
    expect(run.durationMs).toBeGreaterThanOrEqual(1_500);
    // Degraded results are cached with the short TTL.
    expect(run.result.cached).toBe(true);
    expect(await hotelCache.getCacheMetadata('delhi')).toMatchObject({
      degraded: true,
      ttlSeconds: 30,
      count: 8,
    });
    expect(await redis.ttl(hotelCacheKeys('delhi').zset)).toBeLessThanOrEqual(30);
  });

  it('Supplier B down: returns Supplier A results, degraded', async () => {
    await setSupplier('supplierB', false);

    const run = await workflows.execute('delhi');

    expect(run.result.degraded).toBe(true);
    expect(run.result.suppliers.supplierB.status).toBe('failed');
    expect(run.result.hotels.every((h) => h.supplier === 'Supplier A')).toBe(true);
  });

  it('both suppliers down: SupplierUnavailableError (HTTP 502)', async () => {
    await setSupplier('supplierA', false);
    await setSupplier('supplierB', false);

    const before = await hotelCache.getCacheMetadata('delhi');
    const err = await workflows.execute('delhi').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SupplierUnavailableError);
    // A total failure never overwrites what is cached.
    expect((await hotelCache.getCacheMetadata('delhi'))?.refreshedAt).toBe(before?.refreshedAt);
    expect((err as SupplierUnavailableError).statusCode).toBe(502);
    expect((err as SupplierUnavailableError).details).toMatchObject({
      supplierA: { status: 'failed' },
      supplierB: { status: 'failed' },
    });
  });
});
