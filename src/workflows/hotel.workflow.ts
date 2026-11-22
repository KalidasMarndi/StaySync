/**
 * hotelOfferWorkflow — orchestrates supplier fetching and offer selection.
 *
 * Determinism rules (enforced by Temporal's workflow sandbox):
 *  - No I/O here: supplier HTTP calls and Redis writes happen in activities,
 *    reached through proxyActivities.
 *  - No process.env, fs, Math.random or locale-dependent APIs.
 *  - Only pure modules are imported (domain logic, constants, types).
 *  - Logging uses the workflow `log`, which is muted during replay.
 */
import { ActivityFailure, ApplicationFailure, log, proxyActivities } from '@temporalio/workflow';
import type { CacheActivities } from '../activities/cache.activities';
import type { SupplierActivities } from '../activities/supplier.activities';
import { findInvalidOffer, selectBestOffers } from '../domain/hotel-aggregation';
import {
  CACHE_ACTIVITY_OPTIONS,
  SUPPLIER_ACTIVITY_OPTIONS,
  WORKFLOW_ERROR_TYPES,
} from '../temporal/constants';
import type { SupplierHotel, SupplierId } from '../types/supplier.types';
import type {
  HotelOfferWorkflowInput,
  HotelOfferWorkflowResult,
  SupplierFetchStatus,
} from '../types/workflow.types';

const { fetchSupplierAHotels, fetchSupplierBHotels } =
  proxyActivities<SupplierActivities>(SUPPLIER_ACTIVITY_OPTIONS);
const { cacheHotelOffers } = proxyActivities<CacheActivities>(CACHE_ACTIVITY_OPTIONS);

interface SupplierOutcome {
  supplierId: SupplierId;
  hotels: SupplierHotel[];
  status: SupplierFetchStatus;
}

export async function hotelOfferWorkflow({
  city,
}: HotelOfferWorkflowInput): Promise<HotelOfferWorkflowResult> {
  log.info('Hotel offer workflow started', { city });

  // Both activities are scheduled before either is awaited, so they run in parallel.
  // allSettled (not all) means one supplier's failure cannot discard the other's data.
  const [settledA, settledB] = await Promise.allSettled([
    fetchSupplierAHotels({ city }),
    fetchSupplierBHotels({ city }),
  ]);

  const outcomes = [toOutcome('supplierA', settledA), toOutcome('supplierB', settledB)];
  const suppliers = {
    supplierA: outcomes[0]!.status,
    supplierB: outcomes[1]!.status,
  };

  const failed = outcomes.filter((outcome) => outcome.status.status === 'failed');
  for (const outcome of failed) {
    log.warn('Supplier failed after retries', {
      city,
      supplier: outcome.supplierId,
      reason: outcome.status.status === 'failed' ? outcome.status.error : undefined,
    });
  }

  if (failed.length === outcomes.length) {
    log.error('All suppliers failed', { city, suppliers });
    throw ApplicationFailure.create({
      type: WORKFLOW_ERROR_TYPES.allSuppliersUnavailable,
      message: `All suppliers are unavailable for city "${city}"`,
      nonRetryable: true,
      details: [suppliers],
    });
  }

  // Order matters: Supplier A is listed first, so it wins equal-price ties.
  const { hotels, duplicatesResolved } = selectBestOffers(
    outcomes.map(({ supplierId, hotels: offers }) => ({ supplierId, hotels: offers })),
  );
  const degraded = failed.length > 0;

  // Cache the final result (Redis write happens in the activity). Caching is best-effort:
  // if it still fails after retries, the client gets the data anyway with cached: false.
  let cached = false;
  try {
    await cacheHotelOffers({ city, hotels, degraded, suppliers });
    cached = true;
  } catch (err) {
    log.warn('Caching failed after retries; returning uncached result', {
      city,
      reason: describeFailure(err),
    });
  }

  log.info('Hotel offer workflow completed', {
    city,
    supplierACount: suppliers.supplierA.count,
    supplierBCount: suppliers.supplierB.count,
    duplicatesResolved,
    hotelCount: hotels.length,
    degraded,
    cached,
  });

  return { city, hotels, suppliers, degraded, duplicatesResolved, cached };
}

function toOutcome(
  supplierId: SupplierId,
  settled: PromiseSettledResult<SupplierHotel[]>,
): SupplierOutcome {
  if (settled.status === 'fulfilled') {
    // Activities already validate payloads; this guards the invariant so that bad data
    // marks only this supplier as failed. (A plain Error thrown in workflow code would
    // instead fail the workflow *task*, which Temporal retries until the run times out.)
    const invalid = findInvalidOffer(settled.value);
    if (invalid) {
      return {
        supplierId,
        hotels: [],
        status: {
          status: 'failed',
          count: 0,
          error: `${WORKFLOW_ERROR_TYPES.invalidSupplierData}: hotelId ${String(invalid.hotelId)}: ${invalid.reason}`,
        },
      };
    }
    return {
      supplierId,
      hotels: settled.value,
      status: { status: 'success', count: settled.value.length },
    };
  }
  return {
    supplierId,
    hotels: [],
    status: { status: 'failed', count: 0, error: describeFailure(settled.reason) },
  };
}

/** "SupplierUnavailable: Supplier A is unavailable (HTTP 503)" — the root cause of an activity failure. */
function describeFailure(error: unknown): string {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  if (cause instanceof ApplicationFailure) {
    return cause.type ? `${cause.type}: ${cause.message}` : cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
