import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import {
  HealthService,
  ProbeError,
  type DependencyName,
  type HealthProbe,
  type HealthProbes,
} from '../../src/services/health.service';

/**
 * Health aggregation rules with FAKE probes (real probes against real
 * infrastructure are in tests/integration/health.integration.test.ts).
 */

const ok: HealthProbe = async () => undefined;
const down =
  (reason = 'HTTP 503'): HealthProbe =>
  async () => {
    throw new ProbeError(reason);
  };
const hang: HealthProbe = (signal) =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));

function probes(overrides: Partial<HealthProbes> = {}): HealthProbes {
  return { redis: ok, temporal: ok, worker: ok, supplierA: ok, supplierB: ok, ...overrides };
}

function service(overrides: Partial<HealthProbes> = {}, timeoutMs = 200) {
  return new HealthService(probes(overrides), { timeoutMs, cacheTtlMs: 0 });
}

const statuses = (services: Record<string, { status: string }>) =>
  Object.fromEntries(Object.entries(services).map(([k, v]) => [k, v.status]));

describe('HealthService — status rules', () => {
  it('all dependencies healthy → healthy and ready', async () => {
    const report = await service().getReport();

    expect(report.status).toBe('healthy');
    expect(report.ready).toBe(true);
    expect(statuses(report.services)).toEqual({
      api: 'healthy',
      redis: 'healthy',
      temporal: 'healthy',
      worker: 'healthy',
      supplierA: 'healthy',
      supplierB: 'healthy',
    });
    expect(new Date(report.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('Redis down → degraded but still ready (cache misses go through Temporal)', async () => {
    const report = await service({ redis: down('not connected (reconnecting)') }).getReport();

    expect(report.status).toBe('degraded');
    expect(report.ready).toBe(true);
    expect(report.services.redis).toMatchObject({
      status: 'unhealthy',
      error: 'not connected (reconnecting)',
    });
  });

  it('Temporal down → worker reported as UNKNOWN (never assumed healthy), still ready via Redis', async () => {
    const report = await service({ temporal: down('not serving'), worker: ok }).getReport();

    expect(report.services.temporal.status).toBe('unhealthy');
    expect(report.services.worker).toEqual({
      status: 'unknown',
      error: 'cannot verify: Temporal is unreachable',
    });
    expect(report.status).toBe('degraded');
    expect(report.ready).toBe(true);
  });

  it('worker not polling → unhealthy worker even though Temporal is up', async () => {
    const report = await service({
      worker: down('no worker polling task queue "hotel-offers"'),
    }).getReport();
    expect(report.services.temporal.status).toBe('healthy');
    expect(report.services.worker.status).toBe('unhealthy');
    expect(report.status).toBe('degraded');
  });

  it.each([
    ['Redis + Temporal down', { redis: down(), temporal: down() }],
    ['Redis + worker down', { redis: down(), worker: down() }],
  ])('%s → unhealthy and NOT ready (no way to serve requests)', async (_label, failing) => {
    const report = await service(failing).getReport();
    expect(report.ready).toBe(false);
    expect(report.status).toBe('unhealthy');
  });

  it.each<[string, DependencyName, DependencyName]>([
    ['Supplier A down', 'supplierA', 'supplierB'],
    ['Supplier B down', 'supplierB', 'supplierA'],
  ])(
    '%s → degraded; the other supplier is reported independently',
    async (_label, failing, other) => {
      const report = await service({ [failing]: down('HTTP 503') }).getReport();

      expect(report.status).toBe('degraded');
      expect(report.services[failing]).toMatchObject({ status: 'unhealthy', error: 'HTTP 503' });
      expect(report.services[other].status).toBe('healthy');
    },
  );

  it('both suppliers down → unhealthy (no fresh data possible) but still ready for cache hits', async () => {
    const report = await service({ supplierA: down(), supplierB: down() }).getReport();
    expect(report.status).toBe('unhealthy');
    expect(report.ready).toBe(true);
  });
});

describe('HealthService — timeouts, safety and caching', () => {
  it('a hanging probe times out without delaying or hiding the other checks', async () => {
    const started = Date.now();
    const report = await service({ supplierA: hang }, 150).getReport();

    expect(Date.now() - started).toBeLessThan(600);
    expect(report.services.supplierA).toMatchObject({
      status: 'unhealthy',
      error: 'timed out after 150ms',
    });
    expect(report.services.supplierB.status).toBe('healthy');
  });

  it('aborts the timed-out probe (so e.g. its HTTP request is cancelled)', async () => {
    let aborted = false;
    await service(
      {
        redis: (signal) =>
          new Promise(() => signal.addEventListener('abort', () => (aborted = true))),
      },
      50,
    ).getReport();
    expect(aborted).toBe(true);
  });

  it('never exposes raw error messages (hosts, passwords) — only safe reasons', async () => {
    const leaky: HealthProbe = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:6379 password=hunter2');
    };
    const report = await service({ redis: leaky }).getReport();

    expect(report.services.redis.error).toBe('unreachable');
    expect(JSON.stringify(report)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2/);
  });

  it('includes probe details and latency', async () => {
    const report = await service({
      worker: async () => ({ activePollers: 2, lastPollSecondsAgo: 3 }),
    }).getReport();
    expect(report.services.worker).toMatchObject({
      status: 'healthy',
      details: { activePollers: 2, lastPollSecondsAgo: 3 },
      latencyMs: expect.any(Number),
    });
  });

  it('reuses a recent report and shares one in-flight check between concurrent callers', async () => {
    let calls = 0;
    const counting: HealthProbe = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    const health = new HealthService(probes({ supplierA: counting }), { cacheTtlMs: 1_000 });

    await Promise.all([health.getReport(), health.getReport(), health.getReport()]);
    await health.getReport();
    expect(calls).toBe(1);
  });

  it('runs the checks again once the cached report is older than the TTL', async () => {
    let calls = 0;
    const health = new HealthService(probes({ supplierA: async () => void (calls += 1) }), {
      cacheTtlMs: 20,
    });
    await health.getReport();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await health.getReport();
    expect(calls).toBe(2);
  });
});

describe('health HTTP endpoints', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  const appWith = (overrides: Partial<HealthProbes>) =>
    createApp(config, { healthService: service(overrides) });

  it('GET /health → 200 with the full report when healthy', async () => {
    const res = await request(appWith({})).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ status: 'healthy', ready: true });
    expect(Object.keys(res.body.services).sort()).toEqual(
      ['api', 'redis', 'supplierA', 'supplierB', 'temporal', 'worker'].sort(),
    );
  });

  it('GET /health → 200 when degraded, 503 when unhealthy', async () => {
    expect((await request(appWith({ supplierA: down() })).get('/health')).status).toBe(200);
    const unhealthy = await request(appWith({ redis: down(), temporal: down() })).get('/health');
    expect(unhealthy.status).toBe(503);
    expect(unhealthy.body.status).toBe('unhealthy');
  });

  it('GET /health/ready → 200 when a serving path exists, 503 when none', async () => {
    const ready = await request(appWith({ redis: down() })).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');

    const notReady = await request(appWith({ redis: down(), temporal: down() })).get(
      '/health/ready',
    );
    expect(notReady.status).toBe(503);
    expect(notReady.body).toMatchObject({
      status: 'not_ready',
      services: {
        redis: { status: 'unhealthy' },
        temporal: { status: 'unhealthy' },
        worker: { status: 'unknown' },
      },
    });
  });

  it('GET /health/live → 200 even when every dependency is down', async () => {
    const allDown = appWith({
      redis: down(),
      temporal: down(),
      worker: down(),
      supplierA: down(),
      supplierB: down(),
    });
    const res = await request(allDown).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'alive',
      timestamp: expect.any(String),
      uptimeSeconds: expect.any(Number),
    });
  });

  it('/health/live works without the health service; /health is absent then', async () => {
    const bare = createApp(config);
    expect((await request(bare).get('/health/live')).status).toBe(200);
    expect((await request(bare).get('/health')).status).toBe(404);
  });
});
