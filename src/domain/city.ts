/**
 * City normalization shared by the API, the workflow ID, and the Redis keys,
 * so " New  Delhi " and "new delhi" always refer to the same cache entry.
 * Pure function (safe to import from workflow code).
 */
export function normalizeCity(city: string): string {
  return city.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Characters allowed in a normalized city: letters (any language), digits,
 * space, dot, apostrophe, hyphen. Excluding ":" matters — a city such as
 * "delhi:data" would otherwise collide with the Redis key of another city.
 */
const CITY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,63}$/u;

export function isValidCity(normalizedCity: string): boolean {
  return CITY_PATTERN.test(normalizedCity);
}
