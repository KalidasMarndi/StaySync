import { z } from 'zod';
import { isValidCity, normalizeCity } from '../domain/city';

/** `city` query parameter: required, normalized ("  New  Delhi " → "new delhi"), safe for Redis keys. */
export const citySchema = z
  .string({ error: 'city is required' })
  .trim()
  .min(1, 'city must not be empty')
  .transform(normalizeCity)
  .refine(isValidCity, 'city contains invalid characters');

/**
 * Optional price bound. Plain decimal notation only, so "abc", "-5", "NaN",
 * "Infinity", "1e3", "" and repeated parameters are all rejected.
 */
function priceSchema(field: 'minPrice' | 'maxPrice') {
  return z
    .string({ error: `${field} must be a single number` })
    .trim()
    .regex(/^\d+(\.\d+)?$/, `${field} must be a non-negative number`)
    .transform(Number)
    .refine(Number.isFinite, `${field} is too large`);
}

export const hotelSearchQuerySchema = z
  .object({
    city: citySchema,
    minPrice: priceSchema('minPrice').optional(),
    maxPrice: priceSchema('maxPrice').optional(),
  })
  .refine(
    ({ minPrice, maxPrice }) =>
      minPrice === undefined || maxPrice === undefined || minPrice <= maxPrice,
    { message: 'minPrice must not exceed maxPrice', path: ['minPrice'] },
  );
