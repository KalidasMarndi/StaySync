import { ReplyError, type Redis, type Result } from 'ioredis';
import { isValidCity, normalizeCity } from '../domain/city';
import { normalizeHotelName } from '../domain/hotel-aggregation';
import type {
  CachedHotels,
  CacheMetadata,
  CacheWriteContext,
  PriceRange,
} from '../types/cache.types';
import type { HotelOffer } from '../types/hotel.types';
import {
  AppError,
  CacheOperationError,
  DependencyUnavailableError,
  ValidationError,
} from '../utils/errors';
import { logger } from '../utils/logger';
import { FILTER_HOTELS_BY_PRICE_LUA } from './redis-scripts';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    staysyncFilterHotelsByPrice(
      zsetKey: string,
      hashKey: string,
      metaKey: string,
      min: string,
      max: string,
    ): Result<string[] | null, Context>;
  }
}

/**
 * Redis key design — three keys per (normalized) city, always written together
 * in one MULTI/EXEC with the same TTL:
 *
 *   staysync:hotels:{city}        SORTED SET  member = normalized hotel name, score = price
 *                                 → price-range queries with ZRANGE … BYSCORE
 *   staysync:hotels:{city}:data   HASH        field = normalized hotel name, value = offer JSON
 *                                 → the full offer for each member, fetched with HMGET
 *   staysync:hotels:{city}:meta   STRING      metadata JSON (refreshedAt, count, degraded, …)
 *                                 → "is this city cached?" Needed because Redis deletes empty
 *                                   sorted sets/hashes, so an empty result has no other trace.
 */
export function hotelCacheKeys(normalizedCity: string) {
  const base = `staysync:hotels:${normalizedCity}`;
  return { zset: base, hash: `${base}:data`, meta: `${base}:meta` };
}

export interface CacheTtlConfig {
  ttlSeconds: number;
  degradedTtlSeconds: number;
}

/** The write side, as needed by the Temporal cache activity. */
export interface HotelCacheWriter {
  saveHotels(
    city: string,
    hotels: HotelOffer[],
    context: CacheWriteContext,
  ): Promise<CacheMetadata>;
}

/** The read side, as needed by the hotel search service. */
export interface HotelCacheReader {
  filterHotelsByPrice(city: string, range: PriceRange): Promise<CachedHotels | null>;
}

const log = logger.child({ component: 'hotel-cache' });

/**
 * Stores deduplicated hotel offers per city and answers price-range queries.
 * No comparison or deduplication happens here — it receives the final list.
 */
export class HotelCacheService implements HotelCacheWriter, HotelCacheReader {
  constructor(
    private readonly redis: Redis,
    private readonly ttl: CacheTtlConfig,
  ) {
    // Sent once, then executed by SHA (EVALSHA); ioredis reloads it if Redis restarts.
    redis.defineCommand('staysyncFilterHotelsByPrice', {
      numberOfKeys: 3,
      lua: FILTER_HOTELS_BY_PRICE_LUA,
      readOnly: true,
    });
  }

  /**
   * Atomically replaces everything cached for a city.
   *
   * Validation happens BEFORE anything is sent: Redis MULTI does not roll back a
   * command that fails at runtime, so bad input must never reach the transaction.
   * Inside MULTI/EXEC: DEL old keys → ZADD + HSET new data → EXPIRE both → SET meta EX.
   * Readers see either the old dataset or the new one — never a mix.
   */
  async saveHotels(
    city: string,
    hotels: HotelOffer[],
    context: CacheWriteContext,
  ): Promise<CacheMetadata> {
    const normalizedCity = this.requireCity(city);
    const entries = this.toEntries(hotels);
    const keys = hotelCacheKeys(normalizedCity);
    const ttlSeconds = context.degraded ? this.ttl.degradedTtlSeconds : this.ttl.ttlSeconds;
    const metadata: CacheMetadata = {
      city: normalizedCity,
      count: entries.length,
      degraded: context.degraded,
      refreshedAt: new Date().toISOString(),
      ttlSeconds,
      suppliers: context.suppliers,
    };

    return this.run('save', normalizedCity, async () => {
      const tx = this.redis.multi().del(keys.zset, keys.hash, keys.meta);
      if (entries.length > 0) {
        tx.zadd(keys.zset, ...entries.flatMap(({ member, offer }) => [offer.price, member]));
        tx.hset(
          keys.hash,
          Object.fromEntries(entries.map(({ member, offer }) => [member, JSON.stringify(offer)])),
        );
        tx.expire(keys.zset, ttlSeconds);
        tx.expire(keys.hash, ttlSeconds);
      }
      tx.set(keys.meta, JSON.stringify(metadata), 'EX', ttlSeconds);

      const replies = await tx.exec();
      const failed = replies?.find(([err]) => err);
      if (!replies || failed) {
        // Defensive: should be impossible after validation, but never leave a mix behind.
        await this.redis.del(keys.zset, keys.hash, keys.meta).catch(() => undefined);
        throw new CacheOperationError(`Cache refresh for "${normalizedCity}" failed`, {
          cause: failed?.[0],
        });
      }

      log.debug({ city: normalizedCity, count: entries.length, ttlSeconds }, 'Hotels cached');
      return metadata;
    });
  }

  /** All cached hotels for a city (ascending price), or null on a cache miss. */
  async getHotels(city: string): Promise<CachedHotels | null> {
    return this.filterHotelsByPrice(city, {});
  }

  /**
   * Price filtering executed inside Redis by a Lua script (ZRANGE BYSCORE + HMGET).
   * Bounds are inclusive; a missing bound means unbounded. Returns null on a cache miss
   * (including an expired, corrupted or inconsistent entry), and an empty list when
   * the city is cached but nothing matches.
   */
  async filterHotelsByPrice(city: string, range: PriceRange): Promise<CachedHotels | null> {
    const normalizedCity = this.requireCity(city);
    const { min, max } = toScoreBounds(range);
    const keys = hotelCacheKeys(normalizedCity);

    return this.run('filter', normalizedCity, async () => {
      const startedAt = Date.now();
      const reply = await this.redis.staysyncFilterHotelsByPrice(
        keys.zset,
        keys.hash,
        keys.meta,
        min,
        max,
      );
      if (!reply) {
        log.debug({ city: normalizedCity, min, max }, 'Cache miss');
        return null;
      }

      const [metaJson, ...offerJsons] = reply;
      const parsed = parseCachedHotels(metaJson, offerJsons);
      if (!parsed) {
        log.warn({ city: normalizedCity }, 'Unreadable cache entry, treating as a miss');
        return null;
      }
      log.debug(
        {
          city: normalizedCity,
          min,
          max,
          count: parsed.hotels.length,
          durationMs: Date.now() - startedAt,
        },
        'Cache filter executed',
      );
      return parsed;
    });
  }

  /** Metadata plus remaining TTL, without reading any hotels. Null if not cached. */
  async getCacheMetadata(
    city: string,
  ): Promise<(CacheMetadata & { ttlRemainingSeconds: number }) | null> {
    const normalizedCity = this.requireCity(city);
    const { meta } = hotelCacheKeys(normalizedCity);

    return this.run('metadata', normalizedCity, async () => {
      // MULTI so the value and its TTL are read at the same instant.
      const replies = await this.redis.multi().get(meta).pttl(meta).exec();
      const metaJson = replies?.[0]?.[1];
      const pttlMs = replies?.[1]?.[1];
      if (typeof metaJson !== 'string' || typeof pttlMs !== 'number') return null;
      const metadata = parseJson<CacheMetadata>(metaJson);
      if (!metadata) return null;
      return { ...metadata, ttlRemainingSeconds: Math.max(0, Math.ceil(pttlMs / 1000)) };
    });
  }

  /** Cheap freshness check: the meta key exists only while the city's TTL has not expired. */
  async isCacheFresh(city: string): Promise<boolean> {
    const normalizedCity = this.requireCity(city);
    return this.run(
      'freshness',
      normalizedCity,
      async () => (await this.redis.exists(hotelCacheKeys(normalizedCity).meta)) === 1,
    );
  }

  /** Removes every key of a city. Returns the number of keys deleted. */
  async deleteCityCache(city: string): Promise<number> {
    const normalizedCity = this.requireCity(city);
    const keys = hotelCacheKeys(normalizedCity);
    return this.run('delete', normalizedCity, () =>
      this.redis.del(keys.zset, keys.hash, keys.meta),
    );
  }

  async ping(): Promise<boolean> {
    return this.run('ping', '-', async () => (await this.redis.ping()) === 'PONG');
  }

  private requireCity(city: string): string {
    const normalized = normalizeCity(city);
    if (!isValidCity(normalized)) {
      throw new ValidationError('Invalid city', [{ field: 'city', message: 'invalid city name' }]);
    }
    return normalized;
  }

  /** Validates the (already deduplicated) list and builds sorted-set members. */
  private toEntries(hotels: HotelOffer[]): Array<{ member: string; offer: HotelOffer }> {
    const seen = new Set<string>();
    return hotels.map((offer, index) => {
      const problem = describeInvalidOffer(offer);
      if (problem) {
        throw new ValidationError('Invalid hotel offer for cache', [
          { field: `hotels.${index}`, message: problem },
        ]);
      }
      const member = normalizeHotelName(offer.name);
      if (seen.has(member)) {
        throw new ValidationError('Hotels must be deduplicated before caching', [
          { field: `hotels.${index}`, message: `duplicate hotel "${member}"` },
        ]);
      }
      seen.add(member);
      return { member, offer };
    });
  }

  /** Maps Redis failures: no connection → 503, Redis-side error → 500. */
  private async run<T>(operation: string, city: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Log name + message only: ioredis connection errors carry long, circular cause chains.
      const error = err instanceof Error ? { name: err.name, message: err.message } : String(err);
      if (err instanceof ReplyError) {
        log.error({ operation, city, error }, 'Redis command failed');
        throw new CacheOperationError(`Cache ${operation} failed`, { cause: err });
      }
      log.warn({ operation, city, error }, 'Redis unavailable');
      throw new DependencyUnavailableError('redis', 'Cache is unavailable', { cause: err });
    }
  }
}

function describeInvalidOffer(offer: HotelOffer): string | null {
  if (typeof offer.name !== 'string' || offer.name.trim().length === 0)
    return 'name must not be blank';
  if (typeof offer.price !== 'number' || !Number.isFinite(offer.price) || offer.price <= 0) {
    return 'price must be a finite number greater than 0';
  }
  if (
    typeof offer.commissionPct !== 'number' ||
    !Number.isFinite(offer.commissionPct) ||
    offer.commissionPct < 0 ||
    offer.commissionPct > 100
  ) {
    return 'commissionPct must be between 0 and 100';
  }
  if (typeof offer.supplier !== 'string' || offer.supplier.length === 0) {
    return 'supplier must not be empty';
  }
  return null;
}

/** Converts optional bounds to Redis score syntax; rejects nonsense ranges. */
function toScoreBounds({ minPrice, maxPrice }: PriceRange): { min: string; max: string } {
  for (const [field, value] of [
    ['minPrice', minPrice],
    ['maxPrice', maxPrice],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new ValidationError('Invalid price range', [
        { field, message: `${field} must be a non-negative number` },
      ]);
    }
  }
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new ValidationError('Invalid price range', [
      { field: 'minPrice', message: 'minPrice must not exceed maxPrice' },
    ]);
  }
  return {
    min: minPrice === undefined ? '-inf' : String(minPrice),
    max: maxPrice === undefined ? '+inf' : String(maxPrice),
  };
}

function parseJson<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function parseCachedHotels(
  metaJson: string | undefined,
  offerJsons: string[],
): CachedHotels | null {
  const metadata = metaJson === undefined ? null : parseJson<CacheMetadata>(metaJson);
  if (!metadata) return null;
  const hotels: HotelOffer[] = [];
  for (const json of offerJsons) {
    const offer = parseJson<HotelOffer>(json);
    if (!offer || typeof offer.price !== 'number' || typeof offer.name !== 'string') return null;
    hotels.push(offer);
  }
  return { hotels, metadata };
}
