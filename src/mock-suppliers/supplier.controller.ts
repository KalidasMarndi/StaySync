import type { RequestHandler } from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  SUPPLIER_DISPLAY_NAMES,
  type SupplierHotel,
  type SupplierId,
} from '../types/supplier.types';
import { AppError } from '../utils/errors';
import { parseOrThrow } from '../utils/validation';
import { citySchema } from '../validation/query.schemas';
import type { SupplierAvailability } from './supplier-availability';

/** Used when `city` is omitted, so the plain `GET /supplierX/hotels` from the brief works. */
export const DEFAULT_SUPPLIER_CITY = 'delhi';

// Same city rules as /api/hotels (normalized, safe characters). Omitted → Delhi;
// supplied but invalid (empty, repeated, ":" …) → 400.
const hotelsQuerySchema = z.object({
  city: citySchema.optional().transform((city) => city ?? DEFAULT_SUPPLIER_CITY),
});

export interface SupplierHotelsHandlerOptions {
  supplierId: SupplierId;
  hotels: ReadonlyArray<Readonly<SupplierHotel>>;
  availability: SupplierAvailability;
  /** Artificial response delay. Lets you observe that the suppliers are called in parallel. */
  latencyMs: number;
}

/**
 * GET /<supplierId>/hotels[?city=<city>]   (city defaults to Delhi)
 *
 * Behaves like a third-party supplier API: returns its raw inventory for the
 * city (no deduplication), [] for unknown cities, and 503 when switched off.
 */
export function createSupplierHotelsHandler(options: SupplierHotelsHandlerOptions): RequestHandler {
  const { supplierId, hotels, availability, latencyMs } = options;
  const displayName = SUPPLIER_DISPLAY_NAMES[supplierId];

  return async (req, res) => {
    const { city } = parseOrThrow(hotelsQuerySchema, req.query, 'Invalid supplier query');

    if (latencyMs > 0) await delay(latencyMs);

    if (!availability.isEnabled(supplierId)) {
      res.setHeader('Retry-After', '30');
      throw new AppError(503, 'SUPPLIER_UNAVAILABLE', `${displayName} is temporarily unavailable`, {
        supplier: supplierId,
      });
    }

    const results = hotels.filter((hotel) => hotel.city === city); // city already normalized

    req.log.debug(
      { supplier: supplierId, city, count: results.length },
      'Supplier inventory served',
    );
    res.json(results);
  };
}
