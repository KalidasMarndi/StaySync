/**
 * Public hotel offer — the exact shape returned by GET /api/hotels.
 * Internal supplier fields (hotelId, city) are intentionally absent.
 */
export interface HotelOffer {
  name: string;
  price: number;
  /** Display name of the supplier that offered the selected price, e.g. "Supplier B". */
  supplier: string;
  commissionPct: number;
}
