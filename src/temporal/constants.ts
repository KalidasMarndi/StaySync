/**
 * Temporal settings shared by the workflow, activities, worker and client.
 *
 * Workflow code cannot read environment variables (it must be deterministic),
 * so timeouts and retry policies are defined here as code. This is the single
 * place to tune them.
 */
import type { ActivityOptions } from '@temporalio/workflow';

export const HOTEL_OFFER_WORKFLOW_TYPE = 'hotelOfferWorkflow';

/** One attempt of a supplier activity may take at most this long. */
export const SUPPLIER_ACTIVITY_START_TO_CLOSE_MS = 5_000;

/**
 * Supplier activity policy:
 *  - attempt 1 → fails → wait 500ms → attempt 2 → fails → wait 1s → attempt 3 → give up
 *  - scheduleToClose caps the total time across all attempts, so a supplier
 *    outage can never hold up the workflow for long.
 *  - Errors raised with ApplicationFailure.nonRetryable (bad request, invalid
 *    payload) skip retries entirely.
 */
export const SUPPLIER_ACTIVITY_OPTIONS = {
  startToCloseTimeout: SUPPLIER_ACTIVITY_START_TO_CLOSE_MS,
  scheduleToCloseTimeout: '15 seconds',
  retry: {
    initialInterval: '500 milliseconds',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 3,
  },
} satisfies ActivityOptions;

/**
 * Cache activity policy: Redis blips are retried (300ms, then 600ms); after 3
 * attempts the workflow gives up on caching and still returns its result
 * with cached: false. scheduleToClose keeps the total well inside the
 * workflow execution timeout (15s suppliers + 10s cache < 30s).
 */
export const CACHE_ACTIVITY_OPTIONS = {
  startToCloseTimeout: '5 seconds',
  scheduleToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '300 milliseconds',
    backoffCoefficient: 2,
    maximumInterval: '2 seconds',
    maximumAttempts: 3,
  },
} satisfies ActivityOptions;

/** Upper bound for a whole workflow run (server-enforced). */
export const HOTEL_OFFER_WORKFLOW_EXECUTION_TIMEOUT_MS = 30_000;

/**
 * Client-side gRPC deadlines. Without them the SDK keeps retrying an
 * unreachable server for ~20s; with them the API fails fast with a 503.
 */
export const WORKFLOW_START_DEADLINE_MS = 5_000;
export const WORKFLOW_RESULT_DEADLINE_MS = HOTEL_OFFER_WORKFLOW_EXECUTION_TIMEOUT_MS + 5_000;

/** ApplicationFailure `type` values thrown by supplier activities. */
export const SUPPLIER_ERROR_TYPES = {
  badRequest: 'SupplierBadRequest',
  clientError: 'SupplierClientError',
  unavailable: 'SupplierUnavailable',
  serverError: 'SupplierServerError',
  timeout: 'SupplierTimeout',
  network: 'SupplierNetworkError',
  invalidResponse: 'InvalidSupplierResponse',
} as const;

/** ApplicationFailure `type` values thrown by the cache activity. */
export const CACHE_ERROR_TYPES = {
  invalidPayload: 'InvalidCachePayload',
  writeFailed: 'CacheWriteFailed',
} as const;

/** ApplicationFailure `type` values thrown by the workflow itself. */
export const WORKFLOW_ERROR_TYPES = {
  allSuppliersUnavailable: 'AllSuppliersUnavailable',
  /** A supplier's data broke the business rules; that supplier is treated as failed. */
  invalidSupplierData: 'InvalidSupplierData',
} as const;
