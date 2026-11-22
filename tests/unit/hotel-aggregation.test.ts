import { describe, expect, it } from 'vitest';
import {
  InvalidHotelOfferError,
  normalizeHotelName,
  selectBestOffers,
  validateHotelOffer,
} from '../../src/domain/hotel-aggregation';
import { SUPPLIER_A_HOTELS } from '../../src/mock-suppliers/data/supplier-a.data';
import { SUPPLIER_B_HOTELS } from '../../src/mock-suppliers/data/supplier-b.data';
import type { SupplierHotel } from '../../src/types/supplier.types';

const hotel = (name: string, price: number, commissionPct = 10, hotelId = name): SupplierHotel => ({
  hotelId,
  name,
  price,
  city: 'delhi',
  commissionPct,
});

const aggregate = (a: SupplierHotel[], b: SupplierHotel[]) =>
  selectBestOffers([
    { supplierId: 'supplierA', hotels: a },
    { supplierId: 'supplierB', hotels: b },
  ]);

describe('normalizeHotelName', () => {
  it.each([
    ['Holtin', 'holtin'],
    ['  HOLTIN ', 'holtin'],
    ['  the oberoi ', 'the oberoi'],
    ['The   Leela\tPalace', 'the leela palace'],
    ['LEMON TREE', 'lemon tree'],
    ['Hotel\n  Name', 'hotel name'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeHotelName(input)).toBe(expected);
  });

  it('does NOT merge names whose letters differ ("Hol tin" vs "Holtin")', () => {
    expect(normalizeHotelName('Hol tin')).not.toBe(normalizeHotelName('Holtin'));
    const { hotels, duplicatesResolved } = aggregate(
      [hotel('Holtin', 6000)],
      [hotel('Hol tin', 5000)],
    );
    expect(hotels.map((h) => h.name)).toEqual(['Hol tin', 'Holtin']);
    expect(duplicatesResolved).toBe(0);
  });
});

describe('selectBestOffers', () => {
  it('picks Supplier B when it is cheaper (Holtin)', () => {
    const { hotels } = aggregate([hotel('Holtin', 6000, 10)], [hotel('Holtin', 5340, 20)]);
    expect(hotels).toEqual([
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
    ]);
  });

  it('picks Supplier A when it is cheaper (Radison)', () => {
    const { hotels } = aggregate([hotel('Radison', 5900, 13)], [hotel('Radison', 6500, 18)]);
    expect(hotels).toEqual([
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
    ]);
  });

  it('keeps price, supplier and commission from the SAME selected offer', () => {
    const { hotels } = aggregate([hotel('X', 100, 5)], [hotel('X', 90, 30)]);
    expect(hotels[0]).toMatchObject({ price: 90, supplier: 'Supplier B', commissionPct: 30 });
  });

  it('lets Supplier A win an equal-price tie', () => {
    const { hotels } = aggregate([hotel('Lemon Tree', 4200, 8)], [hotel('LEMON TREE', 4200, 11)]);
    expect(hotels).toEqual([
      { name: 'Lemon Tree', price: 4200, supplier: 'Supplier A', commissionPct: 8 },
    ]);
  });

  it('tie-break follows source order, not supplier name', () => {
    const { hotels } = selectBestOffers([
      { supplierId: 'supplierB', hotels: [hotel('Tie', 100, 1)] },
      { supplierId: 'supplierA', hotels: [hotel('Tie', 100, 2)] },
    ]);
    expect(hotels[0]?.supplier).toBe('Supplier B');
  });

  it('keeps hotels unique to either supplier', () => {
    const { hotels, duplicatesResolved } = aggregate(
      [hotel('Only A', 3000)],
      [hotel('Only B', 2000)],
    );
    expect(hotels.map((h) => [h.name, h.supplier])).toEqual([
      ['Only B', 'Supplier B'],
      ['Only A', 'Supplier A'],
    ]);
    expect(duplicatesResolved).toBe(0);
  });

  it('matches names case-insensitively and ignoring whitespace, and cleans the display name', () => {
    const { hotels, duplicatesResolved } = aggregate(
      [hotel('The Oberoi', 15500)],
      [hotel('  the   OBEROI ', 15000)],
    );
    expect(hotels).toHaveLength(1);
    expect(hotels[0]).toMatchObject({ name: 'the OBEROI', supplier: 'Supplier B', price: 15000 });
    expect(duplicatesResolved).toBe(1);
  });

  it('handles one supplier returning an empty list', () => {
    expect(aggregate([], [hotel('Zostel', 1800)]).hotels).toEqual([
      { name: 'Zostel', price: 1800, supplier: 'Supplier B', commissionPct: 10 },
    ]);
    expect(aggregate([hotel('Bloomrooms', 3500)], []).hotels).toHaveLength(1);
  });

  it('returns an empty result when both suppliers return nothing', () => {
    expect(aggregate([], [])).toEqual({ hotels: [], duplicatesResolved: 0 });
  });

  it('sorts by price ascending, then by normalized name for equal prices', () => {
    const { hotels } = aggregate(
      [hotel('Charlie', 300), hotel('bravo', 100)],
      [hotel('Alpha', 100), hotel('Delta', 200)],
    );
    expect(hotels.map((h) => h.name)).toEqual(['Alpha', 'bravo', 'Delta', 'Charlie']);
  });

  it('does not mutate its input', () => {
    const a = [hotel('  Spaced  Name ', 100)];
    const snapshot = structuredClone(a);
    aggregate(a, []);
    expect(a).toEqual(snapshot);
  });
});

describe('selectBestOffers with the Delhi dataset', () => {
  const delhi = (hotels: ReadonlyArray<SupplierHotel>) => hotels.filter((h) => h.city === 'delhi');
  const result = selectBestOffers([
    { supplierId: 'supplierA', hotels: delhi(SUPPLIER_A_HOTELS) },
    { supplierId: 'supplierB', hotels: delhi(SUPPLIER_B_HOTELS) },
  ]);

  it('produces the exact expected, price-sorted list', () => {
    expect(result.hotels).toEqual([
      { name: 'Zostel', price: 1800, supplier: 'Supplier B', commissionPct: 7 },
      { name: 'Bloomrooms', price: 3500, supplier: 'Supplier A', commissionPct: 9 },
      { name: 'Lemon Tree', price: 4200, supplier: 'Supplier A', commissionPct: 8 },
      { name: 'Ibis New Delhi', price: 4800, supplier: 'Supplier B', commissionPct: 12 },
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
      { name: 'Hyatt Regency', price: 9000, supplier: 'Supplier B', commissionPct: 15 },
      { name: 'ITC Maurya', price: 11000, supplier: 'Supplier A', commissionPct: 16 },
      { name: 'Taj Palace', price: 11800, supplier: 'Supplier B', commissionPct: 17 },
      { name: 'The Oberoi', price: 15000, supplier: 'Supplier A', commissionPct: 12 },
      { name: 'The Leela Palace', price: 18000, supplier: 'Supplier A', commissionPct: 14 },
    ]);
  });

  it('resolves exactly 5 duplicates (16 offers → 11 hotels)', () => {
    expect(result.duplicatesResolved).toBe(5);
  });

  it('contains no duplicate normalized names', () => {
    const keys = result.hotels.map((h) => normalizeHotelName(h.name));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('selectBestOffers — more cross-supplier cases', () => {
  it('keeps everything when only Supplier A returns hotels', () => {
    const { hotels, duplicatesResolved } = aggregate([hotel('B2', 200), hotel('A1', 100)], []);
    expect(hotels).toEqual([
      { name: 'A1', price: 100, supplier: 'Supplier A', commissionPct: 10 },
      { name: 'B2', price: 200, supplier: 'Supplier A', commissionPct: 10 },
    ]);
    expect(duplicatesResolved).toBe(0);
  });

  it('keeps everything when only Supplier B returns hotels', () => {
    const { hotels } = aggregate([], [hotel('Zostel', 1800, 7), hotel('Ibis', 4800, 12)]);
    expect(hotels.map((h) => [h.name, h.supplier])).toEqual([
      ['Zostel', 'Supplier B'],
      ['Ibis', 'Supplier B'],
    ]);
  });

  it("on an equal price keeps Supplier A's commission, not B's higher one", () => {
    const { hotels } = aggregate([hotel('Tie', 4200, 8)], [hotel('Tie', 4200, 25)]);
    expect(hotels).toEqual([
      { name: 'Tie', price: 4200, supplier: 'Supplier A', commissionPct: 8 },
    ]);
  });

  it("uses the winning offer's own display formatting", () => {
    const aWins = aggregate([hotel('The Oberoi', 100)], [hotel('  THE   OBEROI ', 200)]);
    const bWins = aggregate([hotel('The Oberoi', 200)], [hotel('  THE   OBEROI ', 100)]);
    expect(aWins.hotels[0]?.name).toBe('The Oberoi');
    expect(bWins.hotels[0]?.name).toBe('THE OBEROI'); // casing kept; whitespace cleaned
  });

  it('accepts boundary values: price 0.01, commission 0 and 100', () => {
    const { hotels } = aggregate([hotel('Cheap', 0.01, 0)], [hotel('Pricey', 99999, 100)]);
    expect(hotels.map((h) => [h.price, h.commissionPct])).toEqual([
      [0.01, 0],
      [99999, 100],
    ]);
  });
});

describe('selectBestOffers — duplicates within ONE supplier', () => {
  it('keeps the cheapest entry and counts the others as resolved duplicates', () => {
    const { hotels, duplicatesResolved } = aggregate(
      [
        hotel('Holtin', 6000, 10, 'a1'),
        hotel('HOLTIN', 5500, 11, 'a2'),
        hotel('holtin ', 5800, 12, 'a3'),
      ],
      [],
    );
    expect(hotels).toEqual([
      { name: 'HOLTIN', price: 5500, supplier: 'Supplier A', commissionPct: 11 },
    ]);
    expect(duplicatesResolved).toBe(2);
  });

  it('breaks an equal-price tie by hotelId, independent of input order', () => {
    const x = hotel('Twin', 5000, 10, 'a9');
    const y = hotel('twin', 5000, 20, 'a1');
    const forward = aggregate([x, y], []);
    const reverse = aggregate([y, x], []);
    expect(forward).toEqual(reverse);
    expect(forward.hotels[0]).toMatchObject({ name: 'twin', commissionPct: 20 }); // hotelId a1 < a9
  });

  it('is deterministic even for fully repeated entries that differ only in formatting/commission', () => {
    const entries = [
      hotel('Same', 5000, 30, 'a1'),
      hotel('SAME', 5000, 10, 'a1'),
      hotel('same', 5000, 20, 'a1'),
    ];
    const results = [entries, [...entries].reverse(), [entries[1]!, entries[2]!, entries[0]!]].map(
      (order) => aggregate(order, []),
    );
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]?.hotels[0]).toMatchObject({ name: 'SAME', commissionPct: 10 }); // "SAME" < "Same" < "same"
  });

  it("still lets a cheaper Supplier B offer beat Supplier A's duplicates", () => {
    const { hotels, duplicatesResolved } = aggregate(
      [hotel('Radison', 5900, 13, 'a1'), hotel('Radison', 6100, 13, 'a2')],
      [hotel('Radison', 5800, 18, 'b1')],
    );
    expect(hotels).toEqual([
      { name: 'Radison', price: 5800, supplier: 'Supplier B', commissionPct: 18 },
    ]);
    expect(duplicatesResolved).toBe(2);
  });
});

describe('validateHotelOffer / malformed data', () => {
  const valid = hotel('Valid', 100, 10, 'id1');

  it('accepts a valid offer', () => {
    expect(validateHotelOffer(valid)).toBeNull();
  });

  it.each([
    ['zero price', { price: 0 }, /price/],
    ['negative price', { price: -100 }, /price/],
    ['NaN price', { price: Number.NaN }, /price/],
    ['Infinity price', { price: Number.POSITIVE_INFINITY }, /price/],
    ['string price', { price: '100' as unknown as number }, /price/],
    ['negative commission', { commissionPct: -1 }, /commissionPct/],
    ['commission over 100', { commissionPct: 101 }, /commissionPct/],
    ['NaN commission', { commissionPct: Number.NaN }, /commissionPct/],
    ['blank name', { name: '   ' }, /name/],
    ['empty hotelId', { hotelId: '' }, /hotelId/],
  ])('rejects %s', (_label, override, reason) => {
    const offer = { ...valid, ...override };
    expect(validateHotelOffer(offer)).toMatch(reason);
    expect(() => aggregate([offer], [])).toThrow(InvalidHotelOfferError);
  });

  it('reports which supplier and hotel were invalid, instead of silently dropping it', () => {
    let error: unknown;
    try {
      aggregate([valid], [hotel('Bad', -5, 10, 'b7')]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(InvalidHotelOfferError);
    expect(error).toMatchObject({ supplierId: 'supplierB', hotelId: 'b7' });
  });
});

describe('selectBestOffers — large datasets and determinism', () => {
  /** Small seeded PRNG (mulberry32) so the "random" dataset is identical on every run. */
  function seededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generate(seed: number, prefix: string, count: number, namePool: number) {
    const random = seededRandom(seed);
    const pick = (n: number) => Math.floor(random() * n);
    const styles = [
      (n: string) => n,
      (n: string) => n.toUpperCase(),
      (n: string) => `  ${n.toLowerCase()} `,
      (n: string) => n.replace(' ', '   '),
    ];
    return Array.from({ length: count }, (_, i) => {
      const base = `Hotel ${pick(namePool)}`;
      return hotel(
        styles[pick(styles.length)]!(base),
        1000 + pick(50) * 100,
        pick(31),
        `${prefix}${i}`,
      );
    });
  }

  function shuffle<T>(items: T[], seed: number): T[] {
    const random = seededRandom(seed);
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }

  // 20,000 offers; few distinct prices so many equal-price ties occur.
  const supplierA = generate(1, 'a', 10_000, 3_000);
  const supplierB = generate(2, 'b', 10_000, 3_000);

  it('is correct on 20,000 offers (checked against independent invariants)', () => {
    const started = performance.now();
    const { hotels, duplicatesResolved } = aggregate(supplierA, supplierB);
    const elapsedMs = performance.now() - started;

    // Group the input independently to know the true minimum per hotel.
    const groups = new Map<string, { min: number; aHasMin: boolean }>();
    for (const [offers, isA] of [
      [supplierA, true],
      [supplierB, false],
    ] as const) {
      for (const o of offers) {
        const key = normalizeHotelName(o.name);
        const g = groups.get(key) ?? { min: Infinity, aHasMin: false };
        if (o.price < g.min) groups.set(key, { min: o.price, aHasMin: isA });
        else if (o.price === g.min) groups.set(key, { min: g.min, aHasMin: g.aHasMin || isA });
        else groups.set(key, g);
      }
    }

    expect(hotels).toHaveLength(groups.size); // no hotel lost, none duplicated
    expect(duplicatesResolved).toBe(20_000 - groups.size);
    for (const h of hotels) {
      const g = groups.get(normalizeHotelName(h.name))!;
      expect(h.price).toBe(g.min); // cheapest price selected
      if (g.aHasMin) expect(h.supplier).toBe('Supplier A'); // A wins ties
    }
    for (let i = 1; i < hotels.length; i += 1) {
      const [prev, curr] = [hotels[i - 1]!, hotels[i]!];
      const ordered =
        prev.price < curr.price ||
        (prev.price === curr.price &&
          normalizeHotelName(prev.name) < normalizeHotelName(curr.name));
      expect(ordered).toBe(true);
    }
    expect(elapsedMs).toBeLessThan(500);
  });

  it('returns identical output on repeated runs and for any input order', () => {
    const baseline = aggregate(supplierA, supplierB);
    expect(aggregate(supplierA, supplierB)).toEqual(baseline);
    for (const seed of [11, 22, 33]) {
      expect(aggregate(shuffle(supplierA, seed), shuffle(supplierB, seed + 1))).toEqual(baseline);
    }
  });
});
