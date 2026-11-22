import { activityInfo, ApplicationFailure, cancellationSignal, log } from '@temporalio/activity';
import { z } from 'zod';
import { validateHotelOffer } from '../domain/hotel-aggregation';
import { SUPPLIER_ERROR_TYPES } from '../temporal/constants';
import {
  SUPPLIER_DISPLAY_NAMES,
  type SupplierHotel,
  type SupplierId,
} from '../types/supplier.types';
import type { SupplierFetchInput } from '../types/workflow.types';

/**
 * Validates what a supplier sends back:
 *  - zod checks the shape and types; unknown extra fields are stripped (tolerant reader).
 *  - validateHotelOffer applies the business rules (price > 0, commission 0–100, …),
 *    the same rules selectBestOffers enforces.
 * Raw values (e.g. untrimmed names) are passed through unchanged; normalization
 * is the domain layer's job.
 */
const supplierHotelsSchema = z.array(
  z
    .object({
      hotelId: z.string(),
      name: z.string(),
      price: z.number(),
      city: z.string().min(1),
      commissionPct: z.number(),
    })
    .superRefine((offer, ctx) => {
      const reason = validateHotelOffer(offer);
      if (reason) ctx.addIssue({ code: 'custom', message: reason });
    }),
);

export interface SupplierActivityOptions {
  baseUrls: Record<SupplierId, string>;
  /** Per-request HTTP timeout. Kept below the activity startToCloseTimeout. */
  requestTimeoutMs: number;
}

export interface SupplierActivities {
  fetchSupplierAHotels(input: SupplierFetchInput): Promise<SupplierHotel[]>;
  fetchSupplierBHotels(input: SupplierFetchInput): Promise<SupplierHotel[]>;
}

/**
 * Builds the supplier activities. Dependencies (URLs, timeout) are injected so
 * the same code runs in the worker, in tests and against any environment.
 */
export function createSupplierActivities(options: SupplierActivityOptions): SupplierActivities {
  return {
    fetchSupplierAHotels: (input) => fetchSupplierHotels('supplierA', input, options),
    fetchSupplierBHotels: (input) => fetchSupplierHotels('supplierB', input, options),
  };
}

/**
 * Calls one supplier over HTTP and returns its validated hotel list.
 *
 * Error classification (Temporal retries only the retryable ones):
 *   400 / other 4xx       → non-retryable (the request itself is wrong)
 *   503 / other 5xx       → retryable     (supplier may recover)
 *   timeout / network     → retryable
 *   invalid JSON / schema → non-retryable (retrying returns the same bad data)
 * A failure is never turned into an empty list: the workflow must know it failed.
 */
async function fetchSupplierHotels(
  supplierId: SupplierId,
  { city }: SupplierFetchInput,
  { baseUrls, requestTimeoutMs }: SupplierActivityOptions,
): Promise<SupplierHotel[]> {
  const supplier = SUPPLIER_DISPLAY_NAMES[supplierId];
  const { attempt } = activityInfo();
  const url = new URL(`${baseUrls[supplierId].replace(/\/+$/, '')}/hotels`);
  url.searchParams.set('city', city);

  const startedAt = Date.now();
  const meta = { supplier: supplierId, city, attempt };
  log.info('Supplier request started', { ...meta, url: url.toString() });

  // Abort on our own timeout OR when Temporal cancels the activity.
  const signal = AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), cancellationSignal()]);

  try {
    const response = await fetch(url, { signal, headers: { accept: 'application/json' } });

    if (!response.ok) {
      await response.body?.cancel();
      throw classifyHttpError(supplier, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      if (isTimeoutError(err)) throw err;
      throw ApplicationFailure.nonRetryable(
        `${supplier} returned a body that is not valid JSON`,
        SUPPLIER_ERROR_TYPES.invalidResponse,
      );
    }

    const parsed = supplierHotelsSchema.safeParse(payload);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw ApplicationFailure.nonRetryable(
        `${supplier} returned an invalid hotel list (${firstIssue?.path.join('.') || 'root'}: ${firstIssue?.message})`,
        SUPPLIER_ERROR_TYPES.invalidResponse,
      );
    }

    log.info('Supplier request completed', {
      ...meta,
      count: parsed.data.length,
      durationMs: Date.now() - startedAt,
    });
    return parsed.data;
  } catch (err) {
    const failure = toApplicationFailure(supplier, err, requestTimeoutMs);
    log.warn('Supplier request failed', {
      ...meta,
      durationMs: Date.now() - startedAt,
      errorType: failure.type,
      retryable: !failure.nonRetryable,
      message: failure.message,
    });
    throw failure;
  }
}

function classifyHttpError(supplier: string, status: number): ApplicationFailure {
  if (status === 400) {
    return ApplicationFailure.nonRetryable(
      `${supplier} rejected the request (HTTP 400)`,
      SUPPLIER_ERROR_TYPES.badRequest,
    );
  }
  if (status === 503) {
    return ApplicationFailure.retryable(
      `${supplier} is unavailable (HTTP 503)`,
      SUPPLIER_ERROR_TYPES.unavailable,
    );
  }
  if (status >= 500) {
    return ApplicationFailure.retryable(
      `${supplier} server error (HTTP ${status})`,
      SUPPLIER_ERROR_TYPES.serverError,
    );
  }
  return ApplicationFailure.nonRetryable(
    `${supplier} rejected the request (HTTP ${status})`,
    SUPPLIER_ERROR_TYPES.clientError,
  );
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/** Leaves ApplicationFailures alone; classifies timeouts and network errors as retryable. */
function toApplicationFailure(
  supplier: string,
  err: unknown,
  timeoutMs: number,
): ApplicationFailure {
  if (err instanceof ApplicationFailure) return err;
  if (isTimeoutError(err)) {
    return ApplicationFailure.retryable(
      `${supplier} did not respond within ${timeoutMs}ms`,
      SUPPLIER_ERROR_TYPES.timeout,
    );
  }
  const reason =
    err instanceof Error
      ? err.cause instanceof Error
        ? err.cause.message
        : err.message
      : String(err);
  return ApplicationFailure.retryable(
    `${supplier} request failed: ${reason}`,
    SUPPLIER_ERROR_TYPES.network,
  );
}
