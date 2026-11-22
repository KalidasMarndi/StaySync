import type { HotelWorkflowExecutor } from '../temporal/client';
import type { PriceRange } from '../types/cache.types';
import type { HotelOffer } from '../types/hotel.types';
import type { SupplierFetchStatus } from '../types/workflow.types';
import type { SupplierId } from '../types/supplier.types';
import { CacheOperationError, DependencyUnavailableError } from '../utils/errors';
import { logger } from '../utils/logger';
import type { HotelCacheReader } from './redis.service';

export interface HotelSearchQuery extends PriceRange {
  /** Already normalized and validated. */
  city: string;
}

export interface HotelSearchResult {
  city: string;
  hotels: HotelOffer[];
  /** Where the hotels came from on THIS request. */
  source: 'cache' | 'workflow';
  /** True when this result is stored in Redis (always true for a cache hit). */
  cached: boolean;
  /** True when at least one supplier failed for the underlying aggregation. */
  degraded: boolean;
  failedSuppliers: SupplierId[];
}

export interface HotelServiceDependencies {
  cache: HotelCacheReader;
  workflows: HotelWorkflowExecutor;
}

const log = logger.child({ component: 'hotel-search' });

/**
 * Cache-aside hotel search.
 *
 *   1. ONE Redis call: the Lua script checks freshness (meta key) AND applies
 *      the price filter atomically. A hit returns here — no workflow, no
 *      supplier calls. A cached empty list is a hit.
 *   2. Miss (never cached, expired, inconsistent) or Redis read failure →
 *      run hotelOfferWorkflow (concurrent requests for a city share one run).
 *      The workflow aggregates AND writes the cache; nothing is duplicated here.
 *   3. Unfiltered: return the workflow's hotels directly.
 *      Filtered: filter inside Redis over the data the workflow just cached.
 *      If it could not be cached, answer 503 — prices are never filtered in JS.
 */
export class HotelService {
  constructor(private readonly deps: HotelServiceDependencies) {}

  async searchHotels(query: HotelSearchQuery): Promise<HotelSearchResult> {
    const { city } = query;
    const range: PriceRange = { minPrice: query.minPrice, maxPrice: query.maxPrice };
    const filtered = range.minPrice !== undefined || range.maxPrice !== undefined;
    const startedAt = Date.now();

    const hit = await this.readCache(city, range);
    if (hit) {
      log.info(
        { city, ...range, count: hit.hotels.length, durationMs: Date.now() - startedAt },
        'Hotels served from cache',
      );
      return hit;
    }

    log.info({ city, ...range }, 'Cache miss — running hotel offer workflow');
    const { result, workflowId } = await this.deps.workflows.execute(city);
    const failedSuppliers = failedSupplierIds(result.suppliers);

    if (!filtered) {
      return {
        city,
        hotels: result.hotels,
        source: 'workflow',
        cached: result.cached,
        degraded: result.degraded,
        failedSuppliers,
      };
    }

    if (!result.cached) {
      log.warn({ city, workflowId, ...range }, 'Cannot filter: workflow result was not cached');
      throw filteringUnavailable();
    }
    const refreshed = await this.deps.cache
      .filterHotelsByPrice(city, range)
      .catch((err: unknown) => {
        log.warn({ city, workflowId, code: errorCode(err) }, 'Cache read after refresh failed');
        throw filteringUnavailable();
      });
    if (!refreshed) {
      log.error({ city, workflowId }, 'Cache entry missing right after refresh');
      throw filteringUnavailable();
    }
    return {
      city,
      hotels: refreshed.hotels,
      source: 'workflow',
      cached: true,
      degraded: result.degraded,
      failedSuppliers,
    };
  }

  /** Returns a hit, or null for a miss. Redis problems are logged and treated as a miss. */
  private async readCache(city: string, range: PriceRange): Promise<HotelSearchResult | null> {
    try {
      const cached = await this.deps.cache.filterHotelsByPrice(city, range);
      if (!cached) return null;
      return {
        city,
        hotels: cached.hotels,
        source: 'cache',
        cached: true,
        degraded: cached.metadata.degraded,
        failedSuppliers: failedSupplierIds(cached.metadata.suppliers),
      };
    } catch (err) {
      if (err instanceof DependencyUnavailableError || err instanceof CacheOperationError) {
        log.warn(
          { city, ...range, code: err.code },
          'Cache read failed — falling back to workflow',
        );
        return null;
      }
      throw err;
    }
  }
}

function failedSupplierIds(suppliers: Record<SupplierId, SupplierFetchStatus>): SupplierId[] {
  return (Object.keys(suppliers) as SupplierId[]).filter((id) => suppliers[id].status === 'failed');
}

function filteringUnavailable(): DependencyUnavailableError {
  return new DependencyUnavailableError('redis', 'Price filtering is temporarily unavailable');
}

function errorCode(err: unknown): string | undefined {
  return err instanceof DependencyUnavailableError || err instanceof CacheOperationError
    ? err.code
    : undefined;
}
