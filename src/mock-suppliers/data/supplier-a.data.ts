import type { SupplierHotel } from '../../types/supplier.types';

/**
 * Static, deterministic inventory for mock Supplier A.
 *
 * Delhi, compared with Supplier B:
 *   - Both suppliers: Holtin, Radison, Taj Palace, The Oberoi, Lemon Tree
 *       (Lemon Tree has the same price at both suppliers, to test tie-breaking)
 *   - Supplier A only: ITC Maurya, Bloomrooms, The Leela Palace
 * Bangalore: only Supplier A has inventory.
 */
export const SUPPLIER_A_HOTELS: ReadonlyArray<Readonly<SupplierHotel>> = [
  // Delhi
  { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
  { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
  { hotelId: 'a3', name: 'Taj Palace', price: 12500, city: 'delhi', commissionPct: 15 },
  { hotelId: 'a4', name: 'The Oberoi', price: 15000, city: 'delhi', commissionPct: 12 },
  { hotelId: 'a5', name: 'Lemon Tree', price: 4200, city: 'delhi', commissionPct: 8 },
  { hotelId: 'a6', name: 'ITC Maurya', price: 11000, city: 'delhi', commissionPct: 16 },
  { hotelId: 'a7', name: 'Bloomrooms', price: 3500, city: 'delhi', commissionPct: 9 },
  { hotelId: 'a8', name: 'The Leela Palace', price: 18000, city: 'delhi', commissionPct: 14 },

  // Mumbai
  { hotelId: 'a9', name: 'Taj Mahal Palace', price: 22000, city: 'mumbai', commissionPct: 14 },
  {
    hotelId: 'a10',
    name: 'Trident Nariman Point',
    price: 13500,
    city: 'mumbai',
    commissionPct: 12,
  },
  { hotelId: 'a11', name: 'JW Marriott Juhu', price: 16500, city: 'mumbai', commissionPct: 13 },
  { hotelId: 'a12', name: 'Sea Princess', price: 7200, city: 'mumbai', commissionPct: 10 },
  { hotelId: 'a13', name: 'FabHotel Prime', price: 2600, city: 'mumbai', commissionPct: 8 },

  // Bangalore (Supplier A only)
  { hotelId: 'a14', name: 'Taj West End', price: 13200, city: 'bangalore', commissionPct: 14 },
  {
    hotelId: 'a15',
    name: 'The Leela Palace Bengaluru',
    price: 14500,
    city: 'bangalore',
    commissionPct: 12,
  },
  { hotelId: 'a16', name: 'Lemon Tree Premier', price: 4600, city: 'bangalore', commissionPct: 9 },
  { hotelId: 'a17', name: 'Ibis Bengaluru', price: 3900, city: 'bangalore', commissionPct: 11 },
];
