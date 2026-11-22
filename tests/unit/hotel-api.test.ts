import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { HotelService } from '../../src/services/hotel.service';
import type { HotelCacheReader } from '../../src/services/redis.service';
import type { HotelWorkflowExecutor, HotelWorkflowRun } from '../../src/temporal/client';
import type { CachedHotels, CacheMetadata, PriceRange } from '../../src/types/cache.types';
import type { HotelOffer } from '../../src/types/hotel.types';
import type { HotelOfferWorkflowResult } from '../../src/types/workflow.types';
import {
  CacheOperationError,
  DependencyUnavailableError,
  SupplierUnavailableError,
} from '../../src/utils/errors';

/**
 * HTTP-level tests of GET /api/hotels with the REAL controller, validation and
 * HotelService, but FAKE cache and workflow dependencies — so every branch
 * (hit, miss, Redis failure, uncached workflow result) is deterministic.
 * The same flows run against real Redis + Temporal in hotel-api.integration.test.ts.
 */

const HOTELS: HotelOffer[] = [
  { name: 'Zostel', price: 1800, supplier: 'Supplier B', commissionPct: 7 },
  { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
  { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
];

const BOTH_OK: CacheMetadata['suppliers'] = {
  supplierA: { status: 'success', count: 8 },
  supplierB: { status: 'success', count: 8 },
};
const A_FAILED: CacheMetadata['suppliers'] = {
  supplierA: { status: 'failed', count: 0, error: 'SupplierUnavailable: down' },
  supplierB: { status: 'success', count: 8 },
};

function cachedHotels(hotels: HotelOffer[], suppliers = BOTH_OK): CachedHotels {
  const degraded =
    suppliers.supplierA.status === 'failed' || suppliers.supplierB.status === 'failed';
  return {
    hotels,
    metadata: {
      city: 'delhi',
      count: hotels.length,
      degraded,
      refreshedAt: new Date().toISOString(),
      ttlSeconds: degraded ? 30 : 300,
      suppliers,
    },
  };
}

function workflowRun(overrides: Partial<HotelOfferWorkflowResult> = {}): HotelWorkflowRun {
  return {
    workflowId: 'hotel-offers:delhi',
    runId: 'run-1',
    durationMs: 5,
    result: {
      city: 'delhi',
      hotels: HOTELS,
      suppliers: BOTH_OK,
      degraded: false,
      duplicatesResolved: 5,
      cached: true,
      ...overrides,
    },
  };
}

/** Builds the app with scripted cache replies (one per call) and a scripted workflow. */
function setup(options: {
  cacheReplies?: Array<CachedHotels | null | Error>;
  workflow?: HotelWorkflowRun | Error;
}) {
  const cacheCalls: Array<{ city: string; range: PriceRange }> = [];
  const workflowCalls: string[] = [];
  const replies = [...(options.cacheReplies ?? [null])];

  const cache: HotelCacheReader = {
    async filterHotelsByPrice(city, range) {
      cacheCalls.push({ city, range });
      const reply = replies.length > 1 ? replies.shift() : replies[0];
      if (reply instanceof Error) throw reply;
      return reply ?? null;
    },
  };
  const workflows: HotelWorkflowExecutor = {
    async execute(city) {
      workflowCalls.push(city);
      const outcome = options.workflow ?? workflowRun();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };

  const app = createApp(loadConfig({ NODE_ENV: 'test' }), {
    hotelService: new HotelService({ cache, workflows }),
  });
  return { app, cacheCalls, workflowCalls };
}

describe('GET /api/hotels — query validation', () => {
  it.each([
    ['missing city', ''],
    ['empty city', '?city=%20%20'],
    ['city with ":" (Redis key injection)', '?city=delhi:data'],
    ['repeated city', '?city=delhi&city=mumbai'],
    ['non-numeric minPrice', '?city=delhi&minPrice=abc'],
    ['negative minPrice', '?city=delhi&minPrice=-5'],
    ['negative maxPrice', '?city=delhi&maxPrice=-1'],
    ['NaN maxPrice', '?city=delhi&maxPrice=NaN'],
    ['Infinity minPrice', '?city=delhi&minPrice=Infinity'],
    ['exponent notation', '?city=delhi&minPrice=1e3'],
    ['empty minPrice', '?city=delhi&minPrice='],
    ['repeated maxPrice', '?city=delhi&maxPrice=1&maxPrice=2'],
    ['too large to represent', `?city=delhi&maxPrice=${'9'.repeat(400)}`],
    ['minPrice greater than maxPrice', '?city=delhi&minPrice=8000&maxPrice=3000'],
  ])('rejects %s with 400 before touching Redis or Temporal', async (_label, qs) => {
    const { app, cacheCalls, workflowCalls } = setup({});

    const res = await request(app).get(`/api/hotels${qs}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(cacheCalls).toHaveLength(0);
    expect(workflowCalls).toHaveLength(0);
  });

  it('accepts decimals and equal bounds, and normalizes the city', async () => {
    const { app, cacheCalls } = setup({ cacheReplies: [cachedHotels(HOTELS)] });

    const res = await request(app).get('/api/hotels').query({
      city: '  New   DELHI ',
      minPrice: '5340',
      maxPrice: '5340.00',
    });

    expect(res.status).toBe(200);
    expect(cacheCalls[0]).toEqual({ city: 'new delhi', range: { minPrice: 5340, maxPrice: 5340 } });
  });

  it('passes missing bounds as undefined (unbounded)', async () => {
    const { app, cacheCalls } = setup({ cacheReplies: [cachedHotels(HOTELS)] });
    await request(app).get('/api/hotels?city=delhi&maxPrice=7000');
    expect(cacheCalls[0]?.range).toEqual({ minPrice: undefined, maxPrice: 7000 });
  });
});

describe('GET /api/hotels — cache hit', () => {
  it('serves from Redis with one cache call and no workflow', async () => {
    const { app, cacheCalls, workflowCalls } = setup({ cacheReplies: [cachedHotels(HOTELS)] });

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(HOTELS);
    expect(cacheCalls).toHaveLength(1);
    expect(workflowCalls).toHaveLength(0);
    expect(res.headers).toMatchObject({
      'x-city': 'delhi',
      'x-data-source': 'cache',
      'x-cached': 'true',
      'x-degraded': 'false',
      'x-result-count': '3',
    });
    expect(res.headers['x-failed-suppliers']).toBeUndefined();
  });

  it('treats a cached EMPTY list as a hit, not a miss', async () => {
    const { app, workflowCalls } = setup({ cacheReplies: [cachedHotels([])] });

    const res = await request(app).get('/api/hotels?city=atlantis');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(res.headers['x-data-source']).toBe('cache');
    expect(res.headers['x-result-count']).toBe('0');
    expect(workflowCalls).toHaveLength(0);
  });

  it('reports a degraded cached result', async () => {
    const { app } = setup({ cacheReplies: [cachedHotels(HOTELS.slice(0, 2), A_FAILED)] });

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.headers['x-degraded']).toBe('true');
    expect(res.headers['x-failed-suppliers']).toBe('supplierA');
  });
});

describe('GET /api/hotels — cache miss', () => {
  it('runs the workflow and returns its hotels (unfiltered)', async () => {
    const { app, cacheCalls, workflowCalls } = setup({ cacheReplies: [null] });

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(HOTELS);
    expect(workflowCalls).toEqual(['delhi']);
    expect(cacheCalls).toHaveLength(1); // no extra Redis read when unfiltered
    expect(res.headers).toMatchObject({ 'x-data-source': 'workflow', 'x-cached': 'true' });
  });

  it('filtered miss: runs the workflow, then filters INSIDE Redis over the fresh cache', async () => {
    const filtered = cachedHotels([HOTELS[1]!]);
    const { app, cacheCalls, workflowCalls } = setup({ cacheReplies: [null, filtered] });

    const res = await request(app).get('/api/hotels?city=delhi&minPrice=5000&maxPrice=5500');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([HOTELS[1]]);
    expect(workflowCalls).toHaveLength(1);
    expect(cacheCalls).toHaveLength(2);
    expect(cacheCalls[1]?.range).toEqual({ minPrice: 5000, maxPrice: 5500 });
    expect(res.headers['x-data-source']).toBe('workflow');
  });

  it('filtered miss whose result could not be cached → 503 (never filters in JS)', async () => {
    const { app, cacheCalls } = setup({
      cacheReplies: [null],
      workflow: workflowRun({ cached: false }),
    });

    const res = await request(app).get('/api/hotels?city=delhi&maxPrice=6000');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'Price filtering is temporarily unavailable',
    });
    expect(cacheCalls).toHaveLength(1);
  });

  it('unfiltered miss whose result could not be cached still returns the data', async () => {
    const { app } = setup({ cacheReplies: [null], workflow: workflowRun({ cached: false }) });

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(HOTELS);
    expect(res.headers['x-cached']).toBe('false');
  });

  it('propagates "all suppliers down" as 502', async () => {
    const { app } = setup({
      cacheReplies: [null],
      workflow: new SupplierUnavailableError('All suppliers are unavailable for city "delhi"'),
    });

    const res = await request(app).get('/api/hotels?city=delhi');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SUPPLIERS_UNAVAILABLE');
  });
});

describe('GET /api/hotels — Redis read failure', () => {
  it.each([
    ['Redis unreachable', new DependencyUnavailableError('redis', 'Cache is unavailable')],
    ['Redis command error', new CacheOperationError('Cache filter failed')],
  ])('%s → falls back to the workflow (200)', async (_label, error) => {
    const { app, workflowCalls } = setup({ cacheReplies: [error] });

    const res = await request(app).get('/api/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(HOTELS);
    expect(workflowCalls).toEqual(['delhi']);
    expect(res.headers['x-data-source']).toBe('workflow');
  });

  it('filtered request with Redis down → 503 with no internal details', async () => {
    const redisDown = new DependencyUnavailableError('redis', 'Cache is unavailable', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:6379'),
    });
    const { app, workflowCalls } = setup({ cacheReplies: [redisDown] });

    const res = await request(app).get('/api/hotels?city=delhi&minPrice=4000');

    expect(res.status).toBe(503);
    expect(workflowCalls).toHaveLength(1); // the workflow may still cache if Redis recovered
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|6379|stack|ioredis/i);
  });
});

describe('GET /api/hotels — response consistency', () => {
  it('cache hit and workflow result produce the same body and the same headers', async () => {
    const hit = setup({ cacheReplies: [cachedHotels(HOTELS)] });
    const miss = setup({ cacheReplies: [null] });

    const [fromCache, fromWorkflow] = await Promise.all([
      request(hit.app).get('/api/hotels?city=delhi'),
      request(miss.app).get('/api/hotels?city=delhi'),
    ]);

    expect(fromCache.body).toEqual(fromWorkflow.body);
    for (const body of [fromCache.body, fromWorkflow.body]) {
      for (const hotel of body) {
        expect(Object.keys(hotel).sort()).toEqual(['commissionPct', 'name', 'price', 'supplier']);
      }
    }
    const metaHeaders = (h: Record<string, unknown>) =>
      Object.keys(h)
        .filter((k) => k.startsWith('x-'))
        .sort();
    expect(metaHeaders(fromCache.headers)).toEqual(metaHeaders(fromWorkflow.headers));
  });
});
