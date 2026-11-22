import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { ConfigError, loadConfig, type AppConfig } from '../../src/config/env';
import { SUPPLIER_A_HOTELS } from '../../src/mock-suppliers/data/supplier-a.data';
import { SUPPLIER_B_HOTELS } from '../../src/mock-suppliers/data/supplier-b.data';
import { isFailureSimulationAllowed } from '../../src/mock-suppliers/supplier.routes';
import type { SupplierHotel } from '../../src/types/supplier.types';

/** Each test builds its own app, so supplier availability state is never shared. */
function buildApp(env: Record<string, string> = {}) {
  return createApp(loadConfig({ NODE_ENV: 'test', ...env }));
}

const normalize = (name: string) => name.trim().toLowerCase();
const namesIn = (hotels: ReadonlyArray<SupplierHotel>, city: string) =>
  new Set(hotels.filter((h) => h.city === city).map((h) => normalize(h.name)));

describe('Mock supplier datasets (contract for later dedup tests)', () => {
  const delhiA = namesIn(SUPPLIER_A_HOTELS, 'delhi');
  const delhiB = namesIn(SUPPLIER_B_HOTELS, 'delhi');
  const overlap = [...delhiA].filter((name) => delhiB.has(name));

  it('has at least 8 Delhi hotels per supplier', () => {
    expect(delhiA.size).toBeGreaterThanOrEqual(8);
    expect(delhiB.size).toBeGreaterThanOrEqual(8);
  });

  it('has at least 5 overlapping and 3 unique Delhi hotels per supplier', () => {
    expect(overlap.length).toBeGreaterThanOrEqual(5);
    expect(delhiA.size - overlap.length).toBeGreaterThanOrEqual(3);
    expect(delhiB.size - overlap.length).toBeGreaterThanOrEqual(3);
  });

  it('includes an equal-price overlap (Lemon Tree) for tie-breaking', () => {
    const a = SUPPLIER_A_HOTELS.find((h) => normalize(h.name) === 'lemon tree');
    const b = SUPPLIER_B_HOTELS.find((h) => normalize(h.name) === 'lemon tree');
    expect(a?.price).toBe(4200);
    expect(b?.price).toBe(4200);
  });

  it('includes case/whitespace name variants for normalization', () => {
    const rawBNames = SUPPLIER_B_HOTELS.map((h) => h.name);
    expect(rawBNames).toContain('  the oberoi ');
    expect(rawBNames).toContain('LEMON TREE');
  });

  it('uses unique hotel IDs within each supplier', () => {
    for (const hotels of [SUPPLIER_A_HOTELS, SUPPLIER_B_HOTELS]) {
      const ids = hotels.map((h) => h.hotelId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('GET /supplierA/hotels and /supplierB/hotels', () => {
  const app = buildApp();

  it('returns all 8 raw Supplier A hotels for Delhi', async () => {
    const res = await request(app).get('/supplierA/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(8);
    expect(res.body[0]).toEqual({
      hotelId: 'a1',
      name: 'Holtin',
      price: 6000,
      city: 'delhi',
      commissionPct: 10,
    });
    expect(res.body.map((h: SupplierHotel) => h.name)).toEqual([
      'Holtin',
      'Radison',
      'Taj Palace',
      'The Oberoi',
      'Lemon Tree',
      'ITC Maurya',
      'Bloomrooms',
      'The Leela Palace',
    ]);
  });

  it('returns all 8 raw Supplier B hotels for Delhi, names untouched (no normalization)', async () => {
    const res = await request(app).get('/supplierB/hotels?city=delhi');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(8);
    expect(res.body.find((h: SupplierHotel) => h.hotelId === 'b1')).toMatchObject({
      name: 'Holtin',
      price: 5340,
      commissionPct: 20,
    });
    expect(res.body.find((h: SupplierHotel) => h.hotelId === 'b4').name).toBe('  the oberoi ');
  });

  it('returns overlapping Mumbai inventory from both suppliers', async () => {
    const [a, b] = await Promise.all([
      request(app).get('/supplierA/hotels?city=mumbai'),
      request(app).get('/supplierB/hotels?city=mumbai'),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.length).toBeGreaterThan(0);
    expect(b.body.length).toBeGreaterThan(0);
    expect(a.body.every((h: SupplierHotel) => h.city === 'mumbai')).toBe(true);

    const bNames = new Set(b.body.map((h: SupplierHotel) => normalize(h.name)));
    const overlap = a.body.filter((h: SupplierHotel) => bNames.has(normalize(h.name)));
    expect(overlap.length).toBeGreaterThanOrEqual(2);
  });

  it('returns Bangalore hotels from Supplier A', async () => {
    const res = await request(app).get('/supplierA/hotels?city=bangalore');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(res.body.every((h: SupplierHotel) => h.city === 'bangalore')).toBe(true);
  });

  it('returns an empty array for Bangalore from Supplier B', async () => {
    const res = await request(app).get('/supplierB/hotels?city=bangalore');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each(['supplierA', 'supplierB'])('%s returns [] for an unknown city', async (supplier) => {
    const res = await request(app).get(`/${supplier}/hotels?city=atlantis`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('matches the city case-insensitively and ignores surrounding whitespace', async () => {
    const res = await request(app).get('/supplierA/hotels').query({ city: '  DeLhI ' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(8);
  });

  it.each(['supplierA', 'supplierB'])(
    '%s returns correctly typed objects with exactly the supplier fields',
    async (supplier) => {
      const res = await request(app).get(`/${supplier}/hotels?city=delhi`);

      expect(res.headers['content-type']).toMatch(/application\/json/);
      for (const hotel of res.body) {
        expect(Object.keys(hotel).sort()).toEqual(
          ['city', 'commissionPct', 'hotelId', 'name', 'price'].sort(),
        );
        expect(hotel).toEqual({
          hotelId: expect.any(String),
          name: expect.any(String),
          price: expect.any(Number),
          city: expect.any(String),
          commissionPct: expect.any(Number),
        });
        expect(hotel.price).toBeGreaterThan(0);
        expect(hotel.commissionPct).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it.each([
    ['empty', '/supplierA/hotels?city=%20%20'],
    ['repeated', '/supplierA/hotels?city=delhi&city=mumbai'],
  ])('rejects a %s city with 400', async (_label, url) => {
    const res = await request(app).get(url);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each(['supplierA', 'supplierB'])(
    '%s without a city parameter defaults to Delhi (plain URL from the brief)',
    async (supplier) => {
      const withoutCity = await request(app).get(`/${supplier}/hotels`);
      const delhi = await request(app).get(`/${supplier}/hotels?city=delhi`);

      expect(withoutCity.status).toBe(200);
      expect(withoutCity.body).toHaveLength(8);
      expect(withoutCity.body.every((h: SupplierHotel) => h.city === 'delhi')).toBe(true);
      expect(withoutCity.body).toEqual(delhi.body);
    },
  );

  it.each([
    ['supplierA', 'mumbai', 5],
    ['supplierB', 'mumbai', 5],
    ['supplierA', 'bangalore', 4],
  ])('%s with city=%s returns that city (%i hotels)', async (supplier, city, count) => {
    const res = await request(app).get(`/${supplier}/hotels?city=${city}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(count);
    expect(res.body.every((h: SupplierHotel) => h.city === city)).toBe(true);
  });

  it.each([
    ['supplierA', '?city=delhi:data'],
    ['supplierB', '?city=%3Cscript%3E'],
    ['supplierB', '?city='],
  ])('%s rejects an invalid supplied city (%s) with 400', async (supplier, qs) => {
    const res = await request(app).get(`/${supplier}/hotels${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a disabled supplier still answers 503 when the city is omitted', async () => {
    const res = await request(buildApp({ SUPPLIER_B_ENABLED: 'false' })).get('/supplierB/hotels');
    expect(res.status).toBe(503);
  });

  it('applies the configured artificial latency', async () => {
    const slowApp = buildApp({ SUPPLIER_LATENCY_MS: '120' });
    const started = Date.now();
    await request(slowApp).get('/supplierA/hotels?city=delhi');
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });
});

describe('Supplier availability (environment flags)', () => {
  it('returns 503 from Supplier A when SUPPLIER_A_ENABLED=false', async () => {
    const app = buildApp({ SUPPLIER_A_ENABLED: 'false' });

    const res = await request(app).get('/supplierA/hotels?city=delhi');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.error).toMatchObject({
      code: 'SUPPLIER_UNAVAILABLE',
      message: 'Supplier A is temporarily unavailable',
      details: { supplier: 'supplierA' },
    });

    // The other supplier is unaffected.
    expect((await request(app).get('/supplierB/hotels?city=delhi')).status).toBe(200);
  });

  it('returns 503 from Supplier B when SUPPLIER_B_ENABLED=false', async () => {
    const app = buildApp({ SUPPLIER_B_ENABLED: 'false' });

    const res = await request(app).get('/supplierB/hotels?city=delhi');
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe('Supplier B is temporarily unavailable');

    expect((await request(app).get('/supplierA/hotels?city=delhi')).status).toBe(200);
  });
});

describe('Runtime failure-simulation toggle', () => {
  it('is not mounted when ENABLE_FAILURE_SIMULATION is false (default)', async () => {
    const app = buildApp();

    const toggle = await request(app)
      .put('/dev/suppliers/supplierA/availability')
      .send({ enabled: false });
    expect(toggle.status).toBe(404);
    expect((await request(app).get('/dev/suppliers/availability')).status).toBe(404);

    // Supplier is still serving normally.
    expect((await request(app).get('/supplierA/hotels?city=delhi')).status).toBe(200);
  });

  it('turns a supplier off and on at runtime when enabled in development', async () => {
    const app = buildApp({ NODE_ENV: 'development', ENABLE_FAILURE_SIMULATION: 'true' });

    expect((await request(app).get('/dev/suppliers/availability')).body).toEqual({
      supplierA: { enabled: true },
      supplierB: { enabled: true },
    });

    const off = await request(app)
      .put('/dev/suppliers/supplierA/availability')
      .send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ supplierA: { enabled: false }, supplierB: { enabled: true } });
    expect((await request(app).get('/supplierA/hotels?city=delhi')).status).toBe(503);
    expect((await request(app).get('/supplierB/hotels?city=delhi')).status).toBe(200);

    const on = await request(app)
      .put('/dev/suppliers/supplierA/availability')
      .send({ enabled: true });
    expect(on.body.supplierA.enabled).toBe(true);
    expect((await request(app).get('/supplierA/hotels?city=delhi')).status).toBe(200);
  });

  it('keeps state per app instance (no leakage between tests)', async () => {
    const env = { NODE_ENV: 'development', ENABLE_FAILURE_SIMULATION: 'true' };
    const first = buildApp(env);
    const second = buildApp(env);

    await request(first).put('/dev/suppliers/supplierB/availability').send({ enabled: false });

    expect((await request(first).get('/supplierB/hotels?city=delhi')).status).toBe(503);
    expect((await request(second).get('/supplierB/hotels?city=delhi')).status).toBe(200);
  });

  it.each([
    ['an unknown supplier', '/dev/suppliers/supplierC/availability', { enabled: false }],
    ['a non-boolean flag', '/dev/suppliers/supplierA/availability', { enabled: 'false' }],
    ['a missing flag', '/dev/suppliers/supplierA/availability', {}],
  ])('rejects %s with 400', async (_label, url, body) => {
    const app = buildApp({ NODE_ENV: 'development', ENABLE_FAILURE_SIMULATION: 'true' });

    const res = await request(app).put(url).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Production safety', () => {
  it('refuses to load a production config with failure simulation enabled', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', ENABLE_FAILURE_SIMULATION: 'true' })).toThrow(
      ConfigError,
    );
  });

  it('never mounts the toggle in production, even if the config validation is bypassed', async () => {
    const forced: AppConfig = {
      ...loadConfig({ NODE_ENV: 'production' }),
      suppliers: {
        ...loadConfig({}).suppliers,
        failureSimulationEnabled: true,
      },
    };
    expect(isFailureSimulationAllowed(forced)).toBe(false);

    const app = createApp(forced);
    const res = await request(app)
      .put('/dev/suppliers/supplierA/availability')
      .send({ enabled: false });
    expect(res.status).toBe(404);
  });
});
