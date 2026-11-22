import type { RequestHandler } from 'express';
import type { HotelService } from '../services/hotel.service';
import { parseOrThrow } from '../utils/validation';
import { hotelSearchQuerySchema } from '../validation/query.schemas';

/**
 * GET /api/hotels?city=<city>[&minPrice=<n>][&maxPrice=<n>]
 *
 * Body: exactly the assignment's format — an array of
 *   { name, price, supplier, commissionPct }, ascending by price.
 * Metadata travels in headers so the body contract is unchanged:
 *   X-City (percent-encoded), X-Data-Source (cache | workflow), X-Cached, X-Degraded,
 *   X-Failed-Suppliers (when degraded), X-Result-Count.
 */
export function createHotelSearchHandler(hotelService: HotelService): RequestHandler {
  return async (req, res) => {
    const query = parseOrThrow(hotelSearchQuerySchema, req.query, 'Invalid query parameters');

    const result = await hotelService.searchHotels(query);

    res.set({
      // Percent-encoded: HTTP headers cannot carry non-Latin-1 text (e.g. 'москва').
      'X-City': encodeURIComponent(result.city),
      'X-Data-Source': result.source,
      'X-Cached': String(result.cached),
      'X-Degraded': String(result.degraded),
      'X-Result-Count': String(result.hotels.length),
    });
    if (result.failedSuppliers.length > 0) {
      res.set('X-Failed-Suppliers', result.failedSuppliers.join(','));
    }
    res.json(result.hotels);
  };
}
