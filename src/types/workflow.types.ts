import type { HotelOffer } from './hotel.types';
import type { SupplierId } from './supplier.types';

/** Input to hotelOfferWorkflow. `city` is already normalized by the caller. */
export interface HotelOfferWorkflowInput {
  city: string;
}

/** Input to each supplier activity. An object (not a bare string) so fields can be added later without breaking running workflows. */
export interface SupplierFetchInput {
  city: string;
}

export type SupplierFetchStatus =
  { status: 'success'; count: number } | { status: 'failed'; count: 0; error: string };

/**
 * Internal workflow result. It carries diagnostics (per-supplier status,
 * degraded flag) and is mapped to the public HotelOffer[] response by the API
 * layer.
 */
export interface HotelOfferWorkflowResult {
  city: string;
  hotels: HotelOffer[];
  suppliers: Record<SupplierId, SupplierFetchStatus>;
  /** True when at least one supplier failed and results come from the remaining one(s). */
  degraded: boolean;
  /** Number of offers dropped because a cheaper (or tie-winning) offer for the same hotel existed. */
  duplicatesResolved: number;
  /** True only if the result was confirmed written to Redis by the cache activity. */
  cached: boolean;
}
