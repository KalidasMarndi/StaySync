#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING StaySync stack (e.g. docker compose up).
 *
 *   npm run smoke                                   # http://localhost:4000
 *   BASE_URL=http://host:4000 npm run smoke
 *
 * Checks health, the cache-first hotel API, Redis price filtering and validation.
 * Read-only apart from the cache entries the API itself creates. Exit code 1 on failure.
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS ?? 90_000);

const EXPECTED_DELHI = [
  ['Zostel', 1800, 'Supplier B', 7],
  ['Bloomrooms', 3500, 'Supplier A', 9],
  ['Lemon Tree', 4200, 'Supplier A', 8],
  ['Ibis New Delhi', 4800, 'Supplier B', 12],
  ['Holtin', 5340, 'Supplier B', 20],
  ['Radison', 5900, 'Supplier A', 13],
  ['Hyatt Regency', 9000, 'Supplier B', 15],
  ['ITC Maurya', 11000, 'Supplier A', 16],
  ['Taj Palace', 11800, 'Supplier B', 17],
  ['The Oberoi', 15000, 'Supplier A', 12],
  ['The Leela Palace', 18000, 'Supplier A', 14],
].map(([name, price, supplier, commissionPct]) => ({ name, price, supplier, commissionPct }));

const results = [];

async function get(path) {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, body, ms: Date.now() - started };
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail });
  } catch (err) {
    results.push({ ok: false, name, detail: err instanceof Error ? err.message : String(err) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const names = (hotels) => hotels.map((h) => h.name);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function waitUntilReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/health/ready`);
      if (res.ok) return;
    } catch {
      // not reachable yet
    }
    if (Date.now() > deadline) throw new Error(`not ready after ${READY_TIMEOUT_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

console.log(`StaySync smoke test → ${BASE_URL}\n`);

await check('API becomes ready (/health/ready)', async () => {
  await waitUntilReady();
  return '200';
});

await check('liveness /health/live → 200', async () => {
  const r = await get('/health/live');
  assert(r.status === 200 && r.body?.status === 'alive', `got ${r.status}`);
  return 'alive';
});

await check('/health reports every dependency healthy', async () => {
  // Right after startup the worker container may still be connecting, so poll briefly.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const started = Date.now();
  for (;;) {
    const r = await get('/health');
    if (r.status === 200 && r.body?.status === 'healthy') {
      return `all healthy after ${Date.now() - started}ms`;
    }
    if (Date.now() > deadline) {
      const unhealthy = Object.entries(r.body?.services ?? {})
        .filter(([, v]) => v.status !== 'healthy')
        .map(([k, v]) => `${k}=${v.status}${v.error ? ` (${v.error})` : ''}`);
      throw new Error(`status ${r.body?.status}: ${unhealthy.join(', ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
});

let first;
await check('GET /api/hotels?city=delhi → 11 deduplicated, cheapest, sorted offers', async () => {
  first = await get('/api/hotels?city=delhi');
  assert(first.status === 200, `status ${first.status}`);
  assert(
    same(first.body, EXPECTED_DELHI),
    `unexpected body: ${JSON.stringify(first.body).slice(0, 200)}`,
  );
  return `source=${first.headers.get('x-data-source')} in ${first.ms}ms`;
});

await check('second request is a Redis cache hit with an identical body', async () => {
  const r = await get('/api/hotels?city=delhi');
  assert(
    r.headers.get('x-data-source') === 'cache',
    `x-data-source=${r.headers.get('x-data-source')}`,
  );
  assert(same(r.body, first?.body), 'body differs from the first response');
  return `cache hit in ${r.ms}ms`;
});

for (const [query, expected] of [
  ['minPrice=4000&maxPrice=7000', ['Lemon Tree', 'Ibis New Delhi', 'Holtin', 'Radison']],
  ['minPrice=11000', ['ITC Maurya', 'Taj Palace', 'The Oberoi', 'The Leela Palace']],
  ['maxPrice=4200', ['Zostel', 'Bloomrooms', 'Lemon Tree']],
  ['minPrice=5340&maxPrice=5900', ['Holtin', 'Radison']],
]) {
  await check(`Redis price filter: ${query}`, async () => {
    const r = await get(`/api/hotels?city=delhi&${query}`);
    assert(r.status === 200, `status ${r.status}`);
    assert(same(names(r.body), expected), `got ${JSON.stringify(names(r.body))}`);
    assert(r.headers.get('x-data-source') === 'cache', 'not served from cache');
    return names(r.body).join(', ');
  });
}

await check('unknown city → [] (cached empty result)', async () => {
  const r = await get('/api/hotels?city=smoke-test-nowhere');
  assert(r.status === 200 && same(r.body, []), `got ${r.status} ${JSON.stringify(r.body)}`);
  const again = await get('/api/hotels?city=smoke-test-nowhere');
  assert(again.headers.get('x-data-source') === 'cache', 'empty result was not cached');
  return 'empty, then cache hit';
});

for (const [label, query] of [
  ['missing city', ''],
  ['negative price', '?city=delhi&minPrice=-1'],
  ['minPrice > maxPrice', '?city=delhi&minPrice=8000&maxPrice=3000'],
]) {
  await check(`validation: ${label} → 400`, async () => {
    const r = await get(`/api/hotels${query}`);
    assert(r.status === 400 && r.body?.error?.code === 'VALIDATION_ERROR', `got ${r.status}`);
    return r.body.error.details?.[0]?.message ?? 'VALIDATION_ERROR';
  });
}

const failed = results.filter((r) => !r.ok);
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
