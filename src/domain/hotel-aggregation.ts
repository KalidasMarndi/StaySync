/**
 * Pure, deterministic hotel aggregation logic.
 *
 * This module is imported by the Temporal workflow, so it must stay free of
 * I/O, Node.js APIs, randomness, wall-clock time and locale-dependent
 * behaviour (no localeCompare). Same input ⇒ same output, on every replay.
 */
import type { HotelOffer } from '../types/hotel.types';
import {
  SUPPLIER_DISPLAY_NAMES,
  type SupplierHotel,
  type SupplierId,
} from '../types/supplier.types';

export interface SupplierOffers {
  supplierId: SupplierId;
  hotels: ReadonlyArray<Readonly<SupplierHotel>>;
}

export interface AggregationResult {
  hotels: HotelOffer[];
  /**
   * Number of offers discarded because another offer for the same normalized
   * hotel name won. Equals (total input offers − hotels returned), so it counts
   * cross-supplier duplicates AND repeated entries within a single supplier.
   */
  duplicatesResolved: number;
}

/** Thrown when an offer breaks the business rules in validateHotelOffer. */
export class InvalidHotelOfferError extends Error {
  constructor(
    readonly supplierId: SupplierId,
    readonly hotelId: unknown,
    readonly reason: string,
  ) {
    super(`Invalid offer from ${supplierId} (hotelId ${String(hotelId)}): ${reason}`);
    this.name = 'InvalidHotelOfferError';
  }
}

/** Dedup key: trim, collapse internal whitespace, lowercase. " The  OBEROI " → "the oberoi". */
export function normalizeHotelName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Business rules for one supplier offer — the single source of truth, shared
 * by the supplier activity (boundary validation) and selectBestOffers.
 * Returns a reason when the offer is invalid, or null when it is valid.
 *
 *  - hotelId: non-empty string
 *  - name: contains at least one non-whitespace character
 *  - price: finite number > 0 (0, negative, NaN and Infinity are rejected)
 *  - commissionPct: finite number from 0 to 100
 */
export function validateHotelOffer(offer: Readonly<SupplierHotel>): string | null {
  if (typeof offer.hotelId !== 'string' || offer.hotelId.length === 0) {
    return 'hotelId must be a non-empty string';
  }
  if (typeof offer.name !== 'string' || offer.name.trim().length === 0) {
    return 'name must not be blank';
  }
  if (typeof offer.price !== 'number' || !Number.isFinite(offer.price) || offer.price <= 0) {
    return `price must be a finite number greater than 0 (got ${String(offer.price)})`;
  }
  if (
    typeof offer.commissionPct !== 'number' ||
    !Number.isFinite(offer.commissionPct) ||
    offer.commissionPct < 0 ||
    offer.commissionPct > 100
  ) {
    return `commissionPct must be between 0 and 100 (got ${String(offer.commissionPct)})`;
  }
  return null;
}

/** Returns the first invalid offer in a supplier's list, or null if all are valid. */
export function findInvalidOffer(
  hotels: ReadonlyArray<Readonly<SupplierHotel>>,
): { hotelId: unknown; reason: string } | null {
  for (const offer of hotels) {
    const reason = validateHotelOffer(offer);
    if (reason) return { hotelId: offer.hotelId, reason };
  }
  return null;
}

/** Display name: trimmed and whitespace-collapsed, original casing kept. */
function cleanDisplayName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Code-point comparison — deterministic regardless of locale/ICU data. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface Candidate {
  offer: Readonly<SupplierHotel>;
  supplierId: SupplierId;
  /** Position of the supplier in `sources`; lower = higher tie-break priority. */
  priority: number;
}

/**
 * Total order over competing offers for the same hotel; the smallest wins.
 *   1. lower price
 *   2. supplier priority (Supplier A before Supplier B)
 *   3. hotelId, then raw name, then commissionPct — only matters when ONE
 *      supplier lists the same hotel more than once at the same price
 * Because every field that reaches the output takes part, the winner never
 * depends on the order in which a supplier returned its hotels.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.offer.price - b.offer.price ||
    a.priority - b.priority ||
    compareStrings(a.offer.hotelId, b.offer.hotelId) ||
    compareStrings(a.offer.name, b.offer.name) ||
    a.offer.commissionPct - b.offer.commissionPct
  );
}

/**
 * Deduplicates hotels across suppliers by normalized name and keeps the best offer.
 *
 *  - Hotels match when names differ only in case or whitespace
 *    ("Holtin" = " HOLTIN "), but not when letters differ ("Hol tin" ≠ "Holtin").
 *  - The winner is chosen by compareCandidates: cheapest first, and on equal
 *    prices the supplier listed EARLIER in `sources` wins (callers pass
 *    Supplier A first).
 *  - Hotels offered by only one supplier are always kept.
 *  - name, price, supplier and commissionPct all come from the winning offer;
 *    fields are never mixed across offers.
 *  - Output is sorted by price ascending, then by normalized name (code-point order).
 *  - Every offer is validated first; an invalid one throws InvalidHotelOfferError
 *    rather than being silently accepted or dropped.
 */
export function selectBestOffers(sources: ReadonlyArray<SupplierOffers>): AggregationResult {
  const best = new Map<string, Candidate>();
  let totalOffers = 0;

  sources.forEach(({ supplierId, hotels }, priority) => {
    for (const offer of hotels) {
      const reason = validateHotelOffer(offer);
      if (reason) throw new InvalidHotelOfferError(supplierId, offer.hotelId, reason);

      totalOffers += 1;
      const key = normalizeHotelName(offer.name);
      const candidate: Candidate = { offer, supplierId, priority };
      const current = best.get(key);
      if (!current || compareCandidates(candidate, current) < 0) {
        best.set(key, candidate);
      }
    }
  });

  const hotels = [...best.entries()]
    .sort(([keyA, a], [keyB, b]) => a.offer.price - b.offer.price || compareStrings(keyA, keyB))
    .map(([, { offer, supplierId }]) => ({
      name: cleanDisplayName(offer.name),
      price: offer.price,
      supplier: SUPPLIER_DISPLAY_NAMES[supplierId],
      commissionPct: offer.commissionPct,
    }));

  return { hotels, duplicatesResolved: totalOffers - hotels.length };
}
