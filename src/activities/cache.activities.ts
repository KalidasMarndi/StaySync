import { activityInfo, ApplicationFailure, log } from '@temporalio/activity';
import type { HotelCacheWriter } from '../services/redis.service';
import { CACHE_ERROR_TYPES } from '../temporal/constants';
import type { CacheHotelOffersInput, CacheWriteResult } from '../types/cache.types';
import { AppError, ValidationError } from '../utils/errors';

export interface CacheActivities {
  cacheHotelOffers(input: CacheHotelOffersInput): Promise<CacheWriteResult>;
}

/**
 * Activity that writes the workflow's final, deduplicated result to Redis.
 * Redis is touched only here (never from workflow code).
 *
 *   invalid payload        → non-retryable (retrying cannot fix it)
 *   Redis down / erroring  → retryable (Temporal retries with backoff)
 */
export function createCacheActivities(cache: HotelCacheWriter): CacheActivities {
  return {
    async cacheHotelOffers({ city, hotels, degraded, suppliers }) {
      const { attempt } = activityInfo();
      const startedAt = Date.now();

      try {
        const metadata = await cache.saveHotels(city, hotels, { degraded, suppliers });
        log.info('Hotel offers cached', {
          city: metadata.city,
          count: metadata.count,
          degraded,
          ttlSeconds: metadata.ttlSeconds,
          attempt,
          durationMs: Date.now() - startedAt,
        });
        return {
          cached: true,
          count: metadata.count,
          ttlSeconds: metadata.ttlSeconds,
          refreshedAt: metadata.refreshedAt,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ValidationError) {
          log.error('Hotel offers rejected by cache', { city, attempt, message });
          throw ApplicationFailure.nonRetryable(
            message,
            CACHE_ERROR_TYPES.invalidPayload,
            err.details,
          );
        }
        log.warn('Caching hotel offers failed', {
          city,
          attempt,
          code: err instanceof AppError ? err.code : undefined,
          message,
          durationMs: Date.now() - startedAt,
        });
        throw ApplicationFailure.retryable(message, CACHE_ERROR_TYPES.writeFailed);
      }
    },
  };
}
