import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { ApplicationFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { DefaultLogger } from '@temporalio/worker';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCacheActivities } from '../../src/activities/cache.activities';
import { closeRedisClient, createRedisClient, waitForRedisReady } from '../../src/config/redis';
import { HotelCacheService, hotelCacheKeys } from '../../src/services/redis.service';
import { CACHE_ERROR_TYPES } from '../../src/temporal/constants';
import type { CacheHotelOffersInput, CacheWriteContext } from '../../src/types/cache.types';
import type { HotelOffer } from '../../src/types/hotel.types';
import {
  CacheOperationError,
  DependencyUnavailableError,
  ValidationError,
} from '../../src/utils/errors';
import { connectTestRedis, TEST_REDIS_CONFIG } from '../helpers/redis';

/** Real Redis (database 15). Each test uses its own city; created keys are deleted afterwards. */

let redis: Redis;
let cache: HotelCacheService;
const usedCities = new Set<string>();

const TTL = { ttlSeconds: 300, degradedTtlSeconds: 30 };
const OK: CacheWriteContext = {
  degraded: false,
  suppliers: {
    supplierA: { status: 'success', count: 8 },
    supplierB: { status: 'success', count: 8 },
  },
};
const DEGRADED: CacheWriteContext = {
  degraded: true,
  suppliers: {
    supplierA: { status: 'failed', count: 0, error: 'SupplierUnavailable: down' },
    supplierB: { status: 'success', count: 8 },
  },
};

// The Delhi result produced by the workflow (already deduplicated and sorted).
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

/** A unique, valid city name for one test (tracked for cleanup). */
function testCity(label = 'city'): string {
  const city = `test ${label} ${randomUUID().slice(0, 8)}`;
  usedCities.add(city);
  return city;
}

const names = (hotels: HotelOffer[] | undefined) => hotels?.map((h) => h.name);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  redis = await connectTestRedis();
  cache = new HotelCacheService(redis, TTL);
});

afterEach(async () => {
  for (const city of usedCities) await cache.deleteCityCache(city);
  usedCities.clear();
});

afterAll(async () => {
  await closeRedisClient(redis);
});

describe('connection', () => {
  it('connects to a real Redis server and answers PING', async () => {
    expect(await cache.ping()).toBe(true);
    expect(redis.status).toBe('ready');
  });

  it('maps an unreachable Redis to DependencyUnavailableError (503) quickly', async () => {
    const dead = createRedisClient(
      { host: '127.0.0.1', port: 1, db: 0, password: undefined },
      'dead',
    );
    const deadCache = new HotelCacheService(dead, TTL);
    const started = Date.now();

    const err = await deadCache.getHotels('delhi').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DependencyUnavailableError);
    expect((err as DependencyUnavailableError).statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(5_000);
    await closeRedisClient(dead);
  });
});

describe('Redis outage and recovery', () => {
  /** A TCP proxy in front of the real Redis that can be "unplugged" to simulate an outage. */
  async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  function startProxy(port: number) {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((client) => {
      const upstream = net.connect(TEST_REDIS_CONFIG.port, TEST_REDIS_CONFIG.host);
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('error', () => socket.destroy());
        socket.on('close', () => sockets.delete(socket));
      }
      client.pipe(upstream).pipe(client);
    });
    return new Promise<{ close: () => Promise<void> }>((resolve) =>
      server.listen(port, '127.0.0.1', () =>
        resolve({
          close: () =>
            new Promise<void>((done) => {
              for (const socket of sockets) socket.destroy();
              server.close(() => done());
            }),
        }),
      ),
    );
  }

  it('a write during an outage fails at once and is NEVER applied later, after reconnecting', async () => {
    const port = await freePort(); // nothing listening yet → "Redis is down"
    const client = createRedisClient({ ...TEST_REDIS_CONFIG, host: '127.0.0.1', port }, 'outage');
    const outageCache = new HotelCacheService(client, TTL);
    const city = testCity('late-write');

    const started = Date.now();
    await expect(outageCache.saveHotels(city, DELHI, OK)).rejects.toBeInstanceOf(
      DependencyUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(300); // not queued, not waiting for a reconnect

    const proxy = await startProxy(port); // Redis "comes back"
    try {
      await waitForRedisReady(client, 10_000);
      await sleep(300);
      // The failed write must not have been replayed from a queue after reconnecting.
      expect(await cache.getHotels(city)).toBeNull();
      // The client recovered on its own and works normally again.
      await outageCache.saveHotels(city, DELHI, OK);
      expect((await cache.getHotels(city))?.hotels).toEqual(DELHI);
    } finally {
      await closeRedisClient(client);
      await proxy.close();
    }
  });
});

describe('saving and reading', () => {
  it('stores the three keys with the documented types and contents', async () => {
    const city = testCity('layout');
    await cache.saveHotels(city, DELHI, OK);
    const keys = hotelCacheKeys(city);

    expect(await redis.type(keys.zset)).toBe('zset');
    expect(await redis.type(keys.hash)).toBe('hash');
    expect(await redis.type(keys.meta)).toBe('string');

    // Sorted set: member = normalized name, score = price.
    expect(await redis.zrange(keys.zset, 0, 2, 'WITHSCORES')).toEqual([
      'zostel',
      '1800',
      'bloomrooms',
      '3500',
      'lemon tree',
      '4200',
    ]);
    expect(await redis.zscore(keys.zset, 'holtin')).toBe('5340');
    // Hash: same member → the complete offer as JSON.
    expect(JSON.parse((await redis.hget(keys.hash, 'the oberoi'))!)).toEqual(DELHI[9]);
    expect(await redis.hlen(keys.hash)).toBe(11);
  });

  it('round-trips every offer through JSON unchanged (ascending price)', async () => {
    const city = testCity('roundtrip');
    await cache.saveHotels(city, DELHI, OK);

    const cached = await cache.getHotels(city);
    expect(cached?.hotels).toEqual(DELHI);
  });

  it('round-trips decimals, unicode and quotes in names', async () => {
    const city = testCity('json');
    const tricky: HotelOffer[] = [
      { name: 'Hôtel "Élan" — Ünïcode', price: 99.99, supplier: 'Supplier A', commissionPct: 12.5 },
      { name: "O'Brien's Inn", price: 100.01, supplier: 'Supplier B', commissionPct: 0 },
    ];
    await cache.saveHotels(city, tricky, OK);
    expect((await cache.getHotels(city))?.hotels).toEqual(tricky);
  });

  it('returns null (cache miss) for a city that was never cached', async () => {
    expect(await cache.getHotels(testCity('unknown'))).toBeNull();
    expect(await cache.filterHotelsByPrice(testCity('unknown'), { minPrice: 1 })).toBeNull();
  });

  it('normalizes the city: " Test  X " and "test x" share one cache entry', async () => {
    const city = testCity('Norm');
    await cache.saveHotels(`  ${city.toUpperCase().replace(/ /g, '   ')} `, DELHI.slice(0, 2), OK);
    expect(names((await cache.getHotels(city))?.hotels)).toEqual(['Zostel', 'Bloomrooms']);
  });
});

describe('price filtering inside Redis (Lua: ZRANGE BYSCORE + HMGET)', () => {
  let city: string;
  beforeAll(async () => {
    city = `test filter ${randomUUID().slice(0, 8)}`;
    await cache.saveHotels(city, DELHI, OK);
  });
  afterAll(async () => {
    await cache.deleteCityCache(city);
  });

  it('minPrice only (inclusive)', async () => {
    const r = await cache.filterHotelsByPrice(city, { minPrice: 11000 });
    expect(names(r?.hotels)).toEqual([
      'ITC Maurya',
      'Taj Palace',
      'The Oberoi',
      'The Leela Palace',
    ]);
  });

  it('maxPrice only (inclusive)', async () => {
    const r = await cache.filterHotelsByPrice(city, { maxPrice: 4200 });
    expect(names(r?.hotels)).toEqual(['Zostel', 'Bloomrooms', 'Lemon Tree']);
  });

  it('min and max together', async () => {
    const r = await cache.filterHotelsByPrice(city, { minPrice: 4000, maxPrice: 7000 });
    expect(names(r?.hotels)).toEqual(['Lemon Tree', 'Ibis New Delhi', 'Holtin', 'Radison']);
  });

  it('includes hotels exactly on both boundaries', async () => {
    const r = await cache.filterHotelsByPrice(city, { minPrice: 5340, maxPrice: 5900 });
    expect(names(r?.hotels)).toEqual(['Holtin', 'Radison']);
    const exact = await cache.filterHotelsByPrice(city, { minPrice: 5340, maxPrice: 5340 });
    expect(names(exact?.hotels)).toEqual(['Holtin']);
  });

  it('no limits returns every hotel', async () => {
    expect((await cache.filterHotelsByPrice(city, {}))?.hotels).toHaveLength(11);
  });

  it('returns [] (not null) when the city is cached but nothing matches', async () => {
    const r = await cache.filterHotelsByPrice(city, { minPrice: 19000 });
    expect(r?.hotels).toEqual([]);
    expect(r?.metadata.count).toBe(11);
  });

  it('works with decimal bounds', async () => {
    const r = await cache.filterHotelsByPrice(city, { minPrice: 1799.5, maxPrice: 1800.5 });
    expect(names(r?.hotels)).toEqual(['Zostel']);
  });

  it('orders equal prices by normalized name, matching the workflow sort', async () => {
    const tieCity = testCity('ties');
    const ties: HotelOffer[] = [
      { name: 'alpha', price: 100, supplier: 'Supplier A', commissionPct: 1 },
      { name: 'Bravo', price: 100, supplier: 'Supplier B', commissionPct: 2 },
      { name: 'charlie', price: 100, supplier: 'Supplier A', commissionPct: 3 },
    ];
    await cache.saveHotels(tieCity, ties, OK);
    expect(names((await cache.getHotels(tieCity))?.hotels)).toEqual(['alpha', 'Bravo', 'charlie']);
  });

  it.each([
    [{ minPrice: -1 }],
    [{ maxPrice: Number.NaN }],
    [{ minPrice: Number.POSITIVE_INFINITY }],
    [{ minPrice: 8000, maxPrice: 3000 }],
  ])('rejects an invalid range %j before calling Redis', async (range) => {
    await expect(cache.filterHotelsByPrice(city, range)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('empty results', () => {
  it('caches an empty list as a HIT (meta key), not a miss', async () => {
    const city = testCity('empty');
    await cache.saveHotels(city, [], OK);
    const keys = hotelCacheKeys(city);

    // Redis keeps no empty sorted set / hash — only the meta key proves the entry exists.
    expect(await redis.exists(keys.zset, keys.hash)).toBe(0);
    expect(await redis.exists(keys.meta)).toBe(1);

    const cached = await cache.getHotels(city);
    expect(cached).not.toBeNull();
    expect(cached?.hotels).toEqual([]);
    expect(cached?.metadata.count).toBe(0);
    expect(await cache.isCacheFresh(city)).toBe(true);
    expect((await cache.filterHotelsByPrice(city, { minPrice: 1, maxPrice: 2 }))?.hotels).toEqual(
      [],
    );
  });
});

describe('atomic refresh', () => {
  it('replaces the previous dataset completely — no stale members survive', async () => {
    const city = testCity('refresh');
    await cache.saveHotels(city, DELHI, OK);
    const next: HotelOffer[] = [
      { name: 'Holtin', price: 4999, supplier: 'Supplier A', commissionPct: 11 },
      { name: 'Brand New', price: 7000, supplier: 'Supplier B', commissionPct: 9 },
    ];

    await cache.saveHotels(city, next, OK);

    const keys = hotelCacheKeys(city);
    expect(await redis.zrange(keys.zset, 0, -1)).toEqual(['holtin', 'brand new']);
    expect((await redis.hkeys(keys.hash)).sort()).toEqual(['brand new', 'holtin']);
    expect(await redis.zscore(keys.zset, 'holtin')).toBe('4999'); // updated score
    expect((await cache.getHotels(city))?.hotels).toEqual(next);
  });

  it('refreshing to an empty list removes all previous hotels', async () => {
    const city = testCity('to-empty');
    await cache.saveHotels(city, DELHI, OK);
    await cache.saveHotels(city, [], OK);

    expect((await cache.getHotels(city))?.hotels).toEqual([]);
    expect(await redis.exists(hotelCacheKeys(city).zset)).toBe(0);
  });

  it('rejects invalid input BEFORE touching Redis, keeping the previous data intact', async () => {
    const city = testCity('reject');
    await cache.saveHotels(city, DELHI, OK);

    const bad: HotelOffer[] = [
      { name: 'Good', price: 100, supplier: 'Supplier A', commissionPct: 5 },
      { name: 'Bad', price: Number.NaN, supplier: 'Supplier B', commissionPct: 5 },
    ];
    await expect(cache.saveHotels(city, bad, OK)).rejects.toBeInstanceOf(ValidationError);

    const duplicated: HotelOffer[] = [
      { name: 'Holtin', price: 100, supplier: 'Supplier A', commissionPct: 5 },
      { name: ' HOLTIN ', price: 90, supplier: 'Supplier B', commissionPct: 5 },
    ];
    await expect(cache.saveHotels(city, duplicated, OK)).rejects.toThrow(/deduplicated/);

    expect((await cache.getHotels(city))?.hotels).toEqual(DELHI);
  });

  it('never exposes a mixed dataset to concurrent readers during concurrent refreshes', async () => {
    const city = testCity('concurrent');
    // 12 distinct datasets (some empty); every hotel name carries its dataset id.
    // Large enough (≈30–60 KB per refresh) that a NON-atomic write would be split across
    // Redis's ~16 KB socket reads, letting readers see a half-written state.
    const datasets: HotelOffer[][] = Array.from({ length: 12 }, (_, d) =>
      Array.from({ length: d % 4 === 0 ? 0 : 400 + d * 25 }, (_, h) => ({
        name: `set${d} hotel${h}`,
        price: 1000 + h * 100,
        supplier: h % 2 ? 'Supplier B' : 'Supplier A',
        commissionPct: d,
      })),
    );
    await cache.saveHotels(city, datasets[1]!, OK);

    // Readers use a SEPARATE connection, so their commands truly interleave with the
    // writers' (one connection would execute everything strictly in order).
    const readerRedis = await connectTestRedis('reader');
    const readerCache = new HotelCacheService(readerRedis, TTL);
    const observed: Array<HotelOffer[] | undefined> = [];
    let writing = true;
    const readLoop = (async () => {
      while (writing) {
        observed.push((await readerCache.getHotels(city))?.hotels);
        observed.push((await readerCache.filterHotelsByPrice(city, { maxPrice: 100_000 }))?.hotels);
      }
    })();

    // Keep refreshing (12 concurrent writers per round) until the reader has made 200 reads.
    let refreshes = 0;
    while (observed.length < 200) {
      await Promise.all(datasets.map((dataset) => cache.saveHotels(city, dataset, OK)));
      refreshes += datasets.length;
    }
    writing = false;
    await readLoop;
    await closeRedisClient(readerRedis);
    expect(refreshes).toBeGreaterThan(0);

    const matchesADataset = (hotels: HotelOffer[]) =>
      datasets.some((dataset) => JSON.stringify(dataset) === JSON.stringify(hotels));
    for (const hotels of observed) {
      expect(hotels).toBeDefined(); // never a miss mid-refresh
      expect(matchesADataset(hotels!)).toBe(true); // never a mix of two datasets
    }

    // Final state = exactly one complete dataset; sizes of all keys agree.
    const final = (await cache.getHotels(city))!;
    expect(matchesADataset(final.hotels)).toBe(true);
    const keys = hotelCacheKeys(city);
    expect(await redis.zcard(keys.zset)).toBe(final.metadata.count);
    expect(await redis.hlen(keys.hash)).toBe(final.metadata.count);
  });
});

describe('metadata, TTL and expiration', () => {
  it('stores metadata and reads it without fetching hotels', async () => {
    const city = testCity('meta');
    const saved = await cache.saveHotels(city, DELHI, OK);

    const meta = await cache.getCacheMetadata(city);
    expect(meta).toEqual({ ...saved, ttlRemainingSeconds: expect.any(Number) });
    expect(meta).toMatchObject({
      count: 11,
      degraded: false,
      ttlSeconds: 300,
      suppliers: OK.suppliers,
    });
    expect(new Date(meta!.refreshedAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(await cache.getCacheMetadata(testCity('none'))).toBeNull();
  });

  it('applies the normal TTL (300s) to all three keys', async () => {
    const city = testCity('ttl');
    await cache.saveHotels(city, DELHI, OK);
    const keys = hotelCacheKeys(city);
    const ttls = await Promise.all([
      redis.ttl(keys.zset),
      redis.ttl(keys.hash),
      redis.ttl(keys.meta),
    ]);
    for (const ttl of ttls) expect(ttl).toBeGreaterThan(295);
    expect(ttls.every((t) => t <= 300)).toBe(true);
  });

  it('applies the degraded TTL (30s) and records degraded: true', async () => {
    const city = testCity('degraded');
    await cache.saveHotels(city, DELHI.slice(0, 3), DEGRADED);
    const keys = hotelCacheKeys(city);

    for (const key of [keys.zset, keys.hash, keys.meta]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(25);
      expect(ttl).toBeLessThanOrEqual(30);
    }
    expect(await cache.getCacheMetadata(city)).toMatchObject({ degraded: true, ttlSeconds: 30 });
  });

  it('gives all keys of a city the exact same expiry instant', async () => {
    const city = testCity('expiretime');
    await cache.saveHotels(city, DELHI, OK);
    const keys = hotelCacheKeys(city);
    const at = await Promise.all(
      [keys.zset, keys.hash, keys.meta].map((key) => redis.call('PEXPIRETIME', key)),
    );
    expect(new Set(at).size).toBe(1);
  });

  it('expires: fresh → stale → cache miss', async () => {
    const shortCache = new HotelCacheService(redis, { ttlSeconds: 2, degradedTtlSeconds: 1 });
    const city = testCity('expiry');
    await shortCache.saveHotels(city, DELHI, DEGRADED); // degraded → 1s

    expect(await shortCache.isCacheFresh(city)).toBe(true);
    await sleep(1_200);
    expect(await shortCache.isCacheFresh(city)).toBe(false);
    expect(await shortCache.getHotels(city)).toBeNull();
    const keys = hotelCacheKeys(city);
    expect(await redis.exists(keys.zset, keys.hash, keys.meta)).toBe(0);
  });

  it('deleteCityCache removes every key', async () => {
    const city = testCity('delete');
    await cache.saveHotels(city, DELHI, OK);
    expect(await cache.deleteCityCache(city)).toBe(3);
    expect(await cache.getHotels(city)).toBeNull();
  });
});

describe('corruption and Lua error handling', () => {
  it('treats unreadable metadata as a miss (self-heals on next refresh)', async () => {
    const city = testCity('bad-meta');
    await cache.saveHotels(city, DELHI, OK);
    await redis.set(hotelCacheKeys(city).meta, '{not json', 'EX', 60);
    expect(await cache.getHotels(city)).toBeNull();
  });

  it('treats out-of-sync keys as a miss (member count ≠ meta.count)', async () => {
    const city = testCity('out-of-sync');
    await cache.saveHotels(city, DELHI, OK);
    await redis.zrem(hotelCacheKeys(city).zset, 'holtin');
    expect(await cache.getHotels(city)).toBeNull();
  });

  it('treats a missing hash entry as a miss', async () => {
    const city = testCity('missing-field');
    await cache.saveHotels(city, DELHI, OK);
    await redis.hdel(hotelCacheKeys(city).hash, 'zostel');
    expect(await cache.getHotels(city)).toBeNull();
  });

  it('treats unparseable offer JSON as a miss', async () => {
    const city = testCity('bad-offer');
    await cache.saveHotels(city, DELHI, OK);
    await redis.hset(hotelCacheKeys(city).hash, 'zostel', '<<<garbage');
    expect(await cache.getHotels(city)).toBeNull();
  });

  it('surfaces a Redis-side script error (WRONGTYPE) as CacheOperationError (500)', async () => {
    const city = testCity('wrongtype');
    const keys = hotelCacheKeys(city);
    await redis.set(keys.meta, JSON.stringify({ count: 1 }), 'EX', 60);
    await redis.set(keys.zset, 'not a sorted set', 'EX', 60);

    const err = await cache.getHotels(city).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CacheOperationError);
    expect((err as CacheOperationError).statusCode).toBe(500);
  });

  it.each(['', '   ', 'delhi:data', 'city{tag}', 'a'.repeat(65)])(
    'rejects unsafe city %j (prevents key collisions)',
    async (city) => {
      await expect(cache.getHotels(city)).rejects.toBeInstanceOf(ValidationError);
    },
  );
});

describe('cacheHotelOffers Temporal activity (real Redis)', () => {
  const runActivity = (
    fn: (input: CacheHotelOffersInput) => Promise<unknown>,
    input: CacheHotelOffersInput,
  ) => new MockActivityEnvironment({}, { logger: new DefaultLogger('ERROR') }).run(fn, input);

  it('writes to Redis and reports cached: true', async () => {
    const city = testCity('activity');
    const { cacheHotelOffers } = createCacheActivities(cache);

    const result = await runActivity(cacheHotelOffers, { city, hotels: DELHI, ...DEGRADED });

    expect(result).toMatchObject({ cached: true, count: 11, ttlSeconds: 30 });
    expect((await cache.getHotels(city))?.hotels).toEqual(DELHI);
  });

  it('throws a NON-retryable failure for an invalid payload', async () => {
    const { cacheHotelOffers } = createCacheActivities(cache);
    const err = await runActivity(cacheHotelOffers, {
      city: testCity('activity-bad'),
      hotels: [{ name: 'X', price: -1, supplier: 'Supplier A', commissionPct: 1 }],
      ...OK,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err).toMatchObject({ type: CACHE_ERROR_TYPES.invalidPayload, nonRetryable: true });
  });

  it('throws a RETRYABLE failure when Redis is unreachable', async () => {
    const dead = createRedisClient(
      { host: '127.0.0.1', port: 1, db: 0, password: undefined },
      'dead',
    );
    const { cacheHotelOffers } = createCacheActivities(new HotelCacheService(dead, TTL));

    const err = await runActivity(cacheHotelOffers, { city: 'delhi', hotels: DELHI, ...OK }).catch(
      (e: unknown) => e,
    );
    await closeRedisClient(dead);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err).toMatchObject({ type: CACHE_ERROR_TYPES.writeFailed, nonRetryable: false });
  });
});
