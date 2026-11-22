import type { SupplierHotel } from '../../types/supplier.types';

/**
 * Static, deterministic inventory for mock Supplier B.
 *
 * Some names deliberately differ from Supplier A in case or surrounding
 * whitespace ("  the oberoi ", "LEMON TREE") so that name normalization during
 * deduplication can be tested.
 *
 * Delhi, compared with Supplier A:
 *   - Both suppliers: Holtin, Radison, Taj Palace, The Oberoi, Lemon Tree
 *   - Supplier B only: Hyatt Regency, Zostel, Ibis New Delhi
 * Bangalore: no inventory (Supplier B returns an empty list).
 */
export const SUPPLIER_B_HOTELS: ReadonlyArray<Readonly<SupplierHotel>> = [
  // Delhi
  { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
  { hotelId: 'b2', name: 'Radison', price: 6500, city: 'delhi', commissionPct: 18 },
  { hotelId: 'b3', name: 'Taj Palace', price: 11800, city: 'delhi', commissionPct: 17 },
  { hotelId: 'b4', name: '  the oberoi ', price: 15500, city: 'delhi', commissionPct: 19 },
  { hotelId: 'b5', name: 'LEMON TREE', price: 4200, city: 'delhi', commissionPct: 11 },
  { hotelId: 'b6', name: 'Hyatt Regency', price: 9000, city: 'delhi', commissionPct: 15 },
  { hotelId: 'b7', name: 'Zostel', price: 1800, city: 'delhi', commissionPct: 7 },
  { hotelId: 'b8', name: 'Ibis New Delhi', price: 4800, city: 'delhi', commissionPct: 12 },

  // Mumbai
  { hotelId: 'b9', name: 'Taj Mahal Palace', price: 21000, city: 'mumbai', commissionPct: 18 },
  {
    hotelId: 'b10',
    name: 'Trident Nariman Point',
    price: 14200,
    city: 'mumbai',
    commissionPct: 11,
  },
  { hotelId: 'b11', name: 'JW Marriott Juhu', price: 15800, city: 'mumbai', commissionPct: 16 },
  { hotelId: 'b12', name: 'Treebo Trend', price: 3100, city: 'mumbai', commissionPct: 9 },
  { hotelId: 'b13', name: 'ITC Maratha', price: 12800, city: 'mumbai', commissionPct: 15 },
];
