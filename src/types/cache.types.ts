import type { HotelOffer } from './hotel.types';
import type { SupplierId } from './supplier.types';
import type { SupplierFetchStatus } from './workflow.types';

/** Stored in staysync:hotels:{city}:meta. Its presence means "this city is cached". */
export interface CacheMetadata {
  city: string;
  /** Number of hotels stored. 0 is a valid, cached empty result. */
  count: number;
  degraded: boolean;
  /** ISO-8601 time of the refresh. */
  refreshedAt: string;
  /** TTL applied to every key of this city (normal or degraded). */
  ttlSeconds: number;
  suppliers: Record<SupplierId, SupplierFetchStatus>;
}

/** Context saved together with the hotels. */
export interface CacheWriteContext {
  degraded: boolean;
  suppliers: Record<SupplierId, SupplierFetchStatus>;
}

export interface CachedHotels {
  hotels: HotelOffer[];
  metadata: CacheMetadata;
}

export interface PriceRange {
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
}

/** Input to the cacheHotelOffers activity. */
export interface CacheHotelOffersInput extends CacheWriteContext {
  city: string;
  hotels: HotelOffer[];
}

/** Output of the cacheHotelOffers activity. */
export interface CacheWriteResult {
  cached: true;
  count: number;
  ttlSeconds: number;
  refreshedAt: string;
}
