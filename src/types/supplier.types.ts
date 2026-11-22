/**
 * Shared supplier types. This file has no runtime dependencies so it can be
 * imported anywhere — the API, Temporal activities, and workflow code.
 */

export const SUPPLIER_IDS = ['supplierA', 'supplierB'] as const;

/** Machine identifier, also used as the URL path segment (/supplierA/hotels). */
export type SupplierId = (typeof SUPPLIER_IDS)[number];

/** Display name returned to API clients in the `supplier` field. */
export const SUPPLIER_DISPLAY_NAMES: Readonly<Record<SupplierId, string>> = {
  supplierA: 'Supplier A',
  supplierB: 'Supplier B',
};

/** A hotel offer exactly as a supplier returns it (raw, not deduplicated). */
export interface SupplierHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}
