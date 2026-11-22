import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createActivities } from '../../src/activities';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { closeRedisClient, createRedisClient } from '../../src/config/redis';
import { HotelService } from '../../src/services/hotel.service';
import { HotelCacheService, hotelCacheKeys } from '../../src/services/redis.service';
import {
  HotelWorkflowClient,
  type HotelWorkflowExecutor,
  type HotelWorkflowRun,
} from '../../src/temporal/client';
import type { HotelOffer } from '../../src/types/hotel.types';
import { startServer, type RunningServer } from '../helpers/http';
import { connectTestRedis } from '../helpers/redis';
import { installQuietTemporalRuntime, WORKFLOWS_PATH } from '../helpers/temporal';

/**
 * GET /api/hotels end-to-end — NO mocks:
 *   HTTP → Express → HotelService → real Redis (Lua filter)
 *                                 ↘ real Temporal → real Worker → real supplier HTTP + Redis cache
 * Supplier HTTP calls and workflow runs are COUNTED, so "no supplier calls on a
 * cache hit" and "one workflow for concurrent requests" are asserted directly.
 */

const DEGRADED_TTL_SECONDS = 2; // short, so real expiry can be observed quickly
const CITIES = ['delhi', 'mumbai', 'bangalore', 'atlantis'];

const DELHI: HotelOffer[] = [
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
];

let env: TestWorkflowEnvironment;
let redis: Redis;
let cache: HotelCacheService;
let server: RunningServer;
let app: Express;
let workflowClient: HotelWorkflowClient;
let worker: Worker;
let workerRun: Promise<void>;

const supplierCalls = { supplierA: 0, supplierB: 0 };
const workflowRuns: HotelWorkflowRun[] = [];

/** Wraps the real Temporal client to record every workflow run the API waits on. */
const countingWorkflows: HotelWorkflowExecutor = {
  async execute(city) {
    const run = await workflowClient.execute(city);
    workflowRuns.push(run);
    return run;
  },
};

const names = (body: HotelOffer[]) => body.map((h) => h.name);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setSupplier(id: 'supplierA' | 'supplierB', enabled: boolean): Promise<void> {
  await request(app).put(`/dev/suppliers/${id}/availability`).send({ enabled }).expect(200);
}

beforeAll(async () => {
  installQuietTemporalRuntime();
  redis = await connectTestRedis('api-integration');
  env = await TestWorkflowEnvironment.createLocal();

  // Worker-side cache (writes) and API-side cache (reads) share the same real Redis DB.
  const workerCache = new HotelCacheService(redis, {
    ttlSeconds: 300,
    degradedTtlSeconds: DEGRADED_TTL_SECONDS,
  });
  cache = new HotelCacheService(redis, { ttlSeconds: 300, degradedTtlSeconds: 30 });

  const taskQueue = `api-integration-${randomUUID()}`;
  workflowClient = new HotelWorkflowClient(env.client, taskQueue);

  app = createApp(loadConfig({ NODE_ENV: 'development', ENABLE_FAILURE_SIMULATION: 'true' }), {
    hotelService: new HotelService({ cache, workflows: countingWorkflows }),
  });
  // Count every supplier HTTP request made by the worker's activities.
  server = await startServer((req, res) => {
    if (req.url?.startsWith('/supplierA/')) supplierCalls.supplierA += 1;
    if (req.url?.startsWith('/supplierB/')) supplierCalls.supplierB += 1;
    app(req, res);
  });

  const config = loadConfig({
    NODE_ENV: 'test',
    SUPPLIER_A_BASE_URL: `${server.baseUrl}/supplierA`,
    SUPPLIER_B_BASE_URL: `${server.baseUrl}/supplierB`,
  });
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH }),
    activities: createActivities(config, { hotelCache: workerCache }),
  });
  workerRun = worker.run();
}, 120_000);

beforeEach(async () => {
  for (const city of CITIES) await cache.deleteCityCache(city);
  await setSupplier('supplierA', true);
  await setSupplier('supplierB', true);
  supplierCalls.supplierA = 0;
  supplierCalls.supplierB = 0;
  workflowRuns.length = 0;
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun;
  await server?.close();
  await env?.teardown();
  for (const city of CITIES) await cache?.deleteCityCache(city);
  if (redis) await closeRedisClient(redis);
});

describe('cache miss → Temporal, then cache hit → Redis only', () => {
  it('first request runs the workflow; second is served from Redis with no supplier calls', async () => {
    const miss = await request(app).get('/api/hotels?city=delhi').expect(200);

    expect(miss.body).toEqual(DELHI);
    expect(miss.headers).toMatchObject({
      'x-data-source': 'workflow',
      'x-cached': 'true',
      'x-degraded': 'false',
      'x-result-count': '11',
    });
    expect(workflowRuns).toHaveLength(1);
    expect(supplierCalls).toEqual({ supplierA: 1, supplierB: 1 });

    const hit = await request(app).get('/api/hotels?city=delhi').expect(200);

    expect(hit.headers['x-data-source']).toBe('cache');
    expect(hit.body).toEqual(miss.body); // identical response shape and content
    expect(workflowRuns).toHaveLength(1); // no new workflow
    expect(supplierCalls).toEqual({ supplierA: 1, supplierB: 1 }); // no new supplier calls
  });

  it('filters inside Redis on cache hits: both bounds, min only, max only, inclusive', async () => {
    await request(app).get('/api/hotels?city=delhi').expect(200); // warm the cache
    const calls = { ...supplierCalls };

    const both = await request(app).get('/api/hotels?city=delhi&minPrice=4000&maxPrice=7000');
    const minOnly = await request(app).get('/api/hotels?city=delhi&minPrice=11000');
    const maxOnly = await request(app).get('/api/hotels?city=delhi&maxPrice=4200');
    const inclusive = await request(app).get('/api/hotels?city=delhi&minPrice=5340&maxPrice=5900');
    const none = await request(app).get('/api/hotels?city=delhi&minPrice=19000');

    expect(names(both.body)).toEqual(['Lemon Tree', 'Ibis New Delhi', 'Holtin', 'Radison']);
    expect(names(minOnly.body)).toEqual([
      'ITC Maurya',
      'Taj Palace',
      'The Oberoi',
      'The Leela Palace',
    ]);
    expect(names(maxOnly.body)).toEqual(['Zostel', 'Bloomrooms', 'Lemon Tree']);
    expect(names(inclusive.body)).toEqual(['Holtin', 'Radison']);
    expect(none.body).toEqual([]);
    for (const res of [both, minOnly, maxOnly, inclusive, none]) {
      expect(res.status).toBe(200);
      expect(res.headers['x-data-source']).toBe('cache');
    }
    expect(supplierCalls).toEqual(calls);
    expect(workflowRuns).toHaveLength(1);
  });

  it('a filtered request on a cold cache runs the workflow, then filters in Redis', async () => {
    const res = await request(app).get('/api/hotels?city=delhi&minPrice=4000&maxPrice=7000');

    expect(res.status).toBe(200);
    expect(res.headers['x-data-source']).toBe('workflow');
    expect(names(res.body)).toEqual(['Lemon Tree', 'Ibis New Delhi', 'Holtin', 'Radison']);
    expect(res.headers['x-result-count']).toBe('4');
    expect(await cache.isCacheFresh('delhi')).toBe(true); // full list cached, not just the slice
  });

  it('rejects invalid price ranges without running a workflow', async () => {
    for (const qs of ['minPrice=-1', 'maxPrice=abc', 'minPrice=8000&maxPrice=3000']) {
      const res = await request(app).get(`/api/hotels?city=delhi&${qs}`);
      expect(res.status).toBe(400);
    }
    expect(workflowRuns).toHaveLength(0);
    expect(supplierCalls).toEqual({ supplierA: 0, supplierB: 0 });
  });
});

describe('cache validity', () => {
  it('unknown city: an empty result is cached and served as a hit', async () => {
    const first = await request(app).get('/api/hotels?city=atlantis').expect(200);
    const second = await request(app).get('/api/hotels?city=atlantis').expect(200);

    expect(first.body).toEqual([]);
    expect(first.headers['x-data-source']).toBe('workflow');
    expect(second.body).toEqual([]);
    expect(second.headers['x-data-source']).toBe('cache');
    expect(workflowRuns).toHaveLength(1);
  });

  it('missing metadata key is treated as a miss → workflow runs again', async () => {
    await request(app).get('/api/hotels?city=delhi').expect(200);
    await redis.del(hotelCacheKeys('delhi').meta); // zset + hash still present

    const res = await request(app).get('/api/hotels?city=delhi').expect(200);

    expect(res.headers['x-data-source']).toBe('workflow');
    expect(workflowRuns).toHaveLength(2);
  });

  it('degraded result: cached with a short TTL, served as degraded, then expires', async () => {
    await setSupplier('supplierA', false);
    const degraded = await request(app).get('/api/hotels?city=delhi').expect(200);

    expect(degraded.headers).toMatchObject({
      'x-data-source': 'workflow',
      'x-degraded': 'true',
      'x-failed-suppliers': 'supplierA',
    });
    expect(degraded.body.every((h: HotelOffer) => h.supplier === 'Supplier B')).toBe(true);

    const cachedDegraded = await request(app).get('/api/hotels?city=delhi').expect(200);
    expect(cachedDegraded.headers).toMatchObject({
      'x-data-source': 'cache',
      'x-degraded': 'true',
      'x-failed-suppliers': 'supplierA',
    });

    // Real Redis expiry, then a fresh, complete aggregation.
    await setSupplier('supplierA', true);
    await sleep(DEGRADED_TTL_SECONDS * 1000 + 300);
    const recovered = await request(app).get('/api/hotels?city=delhi').expect(200);

    expect(recovered.headers).toMatchObject({ 'x-data-source': 'workflow', 'x-degraded': 'false' });
    expect(recovered.body).toEqual(DELHI);
    expect(workflowRuns).toHaveLength(2);
  });
});

describe('concurrency', () => {
  it('concurrent requests for an uncached city share ONE workflow run', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(app).get('/api/hotels?city=mumbai')),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual(responses[0]!.body);
    }
    expect(responses[0]!.body.length).toBeGreaterThan(0);
    expect(new Set(workflowRuns.map((r) => r.runId)).size).toBe(1); // one Temporal execution
    expect(supplierCalls).toEqual({ supplierA: 1, supplierB: 1 }); // one call per supplier
  });
});

describe('Redis failure on the API side', () => {
  it('unfiltered request falls back to the workflow; filtered request answers 503 safely', async () => {
    const deadRedis = createRedisClient(
      { host: '127.0.0.1', port: 1, db: 0, password: undefined, tls: false },
      'api-dead',
    );
    const brokenApp = createApp(loadConfig({ NODE_ENV: 'test' }), {
      hotelService: new HotelService({
        cache: new HotelCacheService(deadRedis, { ttlSeconds: 300, degradedTtlSeconds: 30 }),
        workflows: countingWorkflows,
      }),
    });

    const unfiltered = await request(brokenApp).get('/api/hotels?city=bangalore');
    const filtered = await request(brokenApp).get('/api/hotels?city=bangalore&maxPrice=5000');
    await closeRedisClient(deadRedis);

    expect(unfiltered.status).toBe(200);
    expect(unfiltered.headers['x-data-source']).toBe('workflow');
    expect(unfiltered.body).toHaveLength(4);

    expect(filtered.status).toBe(503);
    expect(filtered.body.error.message).toBe('Price filtering is temporarily unavailable');
    expect(JSON.stringify(filtered.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|stack|ioredis/i);
  });
});
