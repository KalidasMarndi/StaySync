import type { AppConfig } from '../config/env';
import type { HotelCacheWriter } from '../services/redis.service';
import { createCacheActivities } from './cache.activities';
import { createSupplierActivities } from './supplier.activities';

export type { CacheActivities } from './cache.activities';
export type { SupplierActivities } from './supplier.activities';

export interface ActivityDependencies {
  hotelCache: HotelCacheWriter;
}

/** Every activity the worker registers, wired from configuration and dependencies. */
export function createActivities(config: AppConfig, deps: ActivityDependencies) {
  return {
    ...createSupplierActivities({
      baseUrls: {
        supplierA: config.suppliers.supplierA.baseUrl,
        supplierB: config.suppliers.supplierB.baseUrl,
      },
      requestTimeoutMs: config.suppliers.requestTimeoutMs,
    }),
    ...createCacheActivities(deps.hotelCache),
  };
}
