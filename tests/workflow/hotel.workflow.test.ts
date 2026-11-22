import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { activityInfo, ApplicationFailure } from '@temporalio/activity';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CacheActivities } from '../../src/activities/cache.activities';
import type { SupplierActivities } from '../../src/activities/supplier.activities';
import { SUPPLIER_A_HOTELS } from '../../src/mock-suppliers/data/supplier-a.data';
import { SUPPLIER_B_HOTELS } from '../../src/mock-suppliers/data/supplier-b.data';
import { HotelWorkflowClient } from '../../src/temporal/client';
import {
  CACHE_ERROR_TYPES,
  HOTEL_OFFER_WORKFLOW_TYPE,
  SUPPLIER_ERROR_TYPES,
} from '../../src/temporal/constants';
import type { CacheHotelOffersInput } from '../../src/types/cache.types';
import type { SupplierHotel } from '../../src/types/supplier.types';
import type { HotelOfferWorkflowResult } from '../../src/types/workflow.types';
import { DependencyUnavailableError, SupplierUnavailableError } from '../../src/utils/errors';
import type { hotelOfferWorkflow } from '../../src/workflows/hotel.workflow';
import { installQuietTemporalRuntime, WORKFLOWS_PATH } from '../helpers/temporal';

/**
 * Workflow tests: a REAL local Temporal dev server (downloaded and started by
 * @temporalio/testing) and a real Worker running the real bundled workflow,
 * but with MOCKED activities so each supplier's behaviour is fully controlled.
 */

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  installQuietTemporalRuntime();
  env = await TestWorkflowEnvironment.createLocal();
  workflowBundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const delhiA = SUPPLIER_A_HOTELS.filter((h) => h.city === 'delhi') as SupplierHotel[];
const delhiB = SUPPLIER_B_HOTELS.filter((h) => h.city === 'delhi') as SupplierHotel[];

const unavailable = (supplier: string) =>
  ApplicationFailure.retryable(
    `${supplier} is unavailable (HTTP 503)`,
    SUPPLIER_ERROR_TYPES.unavailable,
  );

/** Mock cache activity that "succeeds" without Redis (Redis is covered by integration tests). */
const cacheOk: CacheActivities['cacheHotelOffers'] = async (input) => ({
  cached: true,
  count: input.hotels.length,
  ttlSeconds: input.degraded ? 30 : 300,
  refreshedAt: new Date().toISOString(),
});

/** Runs one workflow on a fresh task queue with the given (mock) activities. */
async function runWorkflow(
  supplierActivities: SupplierActivities & Partial<CacheActivities>,
  city = 'delhi',
): Promise<HotelOfferWorkflowResult> {
  const taskQueue = `test-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle,
    activities: { cacheHotelOffers: cacheOk, ...supplierActivities },
  });
  return worker.runUntil(
    env.client.workflow.execute<typeof hotelOfferWorkflow>(HOTEL_OFFER_WORKFLOW_TYPE, {
      args: [{ city }],
      taskQueue,
      workflowId: `test-${randomUUID()}`,
    }),
  );
}

describe('hotelOfferWorkflow (mocked activities, real Temporal server)', () => {
  it('Scenario A — both suppliers succeed: combined, deduplicated result', async () => {
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => delhiA,
      fetchSupplierBHotels: async () => delhiB,
    });

    expect(result.degraded).toBe(false);
    expect(result.hotels).toHaveLength(11);
    expect(result.duplicatesResolved).toBe(5);
    expect(result.hotels.find((h) => h.name === 'Holtin')).toEqual({
      name: 'Holtin',
      price: 5340,
      supplier: 'Supplier B',
      commissionPct: 20,
    });
    expect(result.hotels.find((h) => h.name === 'Lemon Tree')?.supplier).toBe('Supplier A');
  });

  it('returns the exact metadata shape', async () => {
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => delhiA,
      fetchSupplierBHotels: async () => delhiB,
    });

    expect(result).toEqual({
      city: 'delhi',
      hotels: expect.any(Array),
      suppliers: {
        supplierA: { status: 'success', count: 8 },
        supplierB: { status: 'success', count: 8 },
      },
      degraded: false,
      duplicatesResolved: 5,
      cached: true,
    });
  });

  it('Scenario B — Supplier A fails, B succeeds: B results, degraded', async () => {
    let attemptsA = 0;
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => {
        attemptsA += 1;
        throw unavailable('Supplier A');
      },
      fetchSupplierBHotels: async () => delhiB,
    });

    expect(attemptsA).toBe(3); // retried up to maximumAttempts
    expect(result.degraded).toBe(true);
    expect(result.suppliers).toEqual({
      supplierA: {
        status: 'failed',
        count: 0,
        error: 'SupplierUnavailable: Supplier A is unavailable (HTTP 503)',
      },
      supplierB: { status: 'success', count: 8 },
    });
    expect(result.hotels).toHaveLength(8);
    expect(result.hotels.every((h) => h.supplier === 'Supplier B')).toBe(true);
    expect(result.duplicatesResolved).toBe(0);
  });

  it('Scenario C — Supplier B fails, A succeeds: A results, degraded', async () => {
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => delhiA,
      fetchSupplierBHotels: async () => {
        throw unavailable('Supplier B');
      },
    });

    expect(result.degraded).toBe(true);
    expect(result.suppliers.supplierA).toEqual({ status: 'success', count: 8 });
    expect(result.suppliers.supplierB.status).toBe('failed');
    expect(result.hotels).toHaveLength(8);
    expect(result.hotels.every((h) => h.supplier === 'Supplier A')).toBe(true);
  });

  it('Scenario D — both fail: non-retryable AllSuppliersUnavailable failure', async () => {
    const err = await runWorkflow({
      fetchSupplierAHotels: async () => {
        throw unavailable('Supplier A');
      },
      fetchSupplierBHotels: async () => {
        throw ApplicationFailure.nonRetryable('bad payload', SUPPLIER_ERROR_TYPES.invalidResponse);
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkflowFailedError);
    const cause = (err as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe('AllSuppliersUnavailable');
    expect((cause as ApplicationFailure).nonRetryable).toBe(true);
    expect((cause as ApplicationFailure).details?.[0]).toEqual({
      supplierA: {
        status: 'failed',
        count: 0,
        error: 'SupplierUnavailable: Supplier A is unavailable (HTTP 503)',
      },
      supplierB: { status: 'failed', count: 0, error: 'InvalidSupplierResponse: bad payload' },
    });
  });

  it('runs both supplier activities concurrently', async () => {
    const spans: Record<string, { start: number; end: number }> = {};
    const timed = (name: string, hotels: SupplierHotel[]) => async (): Promise<SupplierHotel[]> => {
      const start = Date.now();
      await sleep(600);
      spans[name] = { start, end: Date.now() };
      return hotels;
    };

    const started = Date.now();
    await runWorkflow({
      fetchSupplierAHotels: timed('A', delhiA),
      fetchSupplierBHotels: timed('B', delhiB),
    });
    const elapsed = Date.now() - started;

    // Each activity started before the other finished → they overlapped.
    expect(spans.A!.start).toBeLessThan(spans.B!.end);
    expect(spans.B!.start).toBeLessThan(spans.A!.end);
    // Sequential would take ≥ 1200ms.
    expect(elapsed).toBeLessThan(1_200);
  });

  it('retries a transient failure with backoff and then succeeds', async () => {
    const attempts: Array<{ attempt: number; at: number }> = [];
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => {
        const { attempt } = activityInfo();
        attempts.push({ attempt, at: Date.now() });
        if (attempt < 3) throw unavailable('Supplier A');
        return delhiA;
      },
      fetchSupplierBHotels: async () => delhiB,
    });

    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    const firstGap = attempts[1]!.at - attempts[0]!.at;
    const secondGap = attempts[2]!.at - attempts[1]!.at;
    expect(firstGap).toBeGreaterThanOrEqual(450); // initialInterval 500ms
    expect(secondGap).toBeGreaterThanOrEqual(900); // ×2 backoff → 1s
    expect(result.degraded).toBe(false);
    expect(result.suppliers.supplierA).toEqual({ status: 'success', count: 8 });
  });

  it('does not retry permanent (non-retryable) errors', async () => {
    let calls = 0;
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => {
        calls += 1;
        throw ApplicationFailure.nonRetryable(
          'Supplier A rejected the request (HTTP 400)',
          SUPPLIER_ERROR_TYPES.badRequest,
        );
      },
      fetchSupplierBHotels: async () => delhiB,
    });

    expect(calls).toBe(1);
    expect(result.degraded).toBe(true);
    expect(result.suppliers.supplierA).toMatchObject({
      status: 'failed',
      error: 'SupplierBadRequest: Supplier A rejected the request (HTTP 400)',
    });
  });

  it('treats invalid supplier data as a failed supplier — never mixed into results', async () => {
    const corrupt = [{ ...delhiB[0]!, price: -1 }, ...delhiB.slice(1)];
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => delhiA,
      fetchSupplierBHotels: async () => corrupt, // bypasses activity validation on purpose
    });

    expect(result.degraded).toBe(true);
    expect(result.suppliers.supplierB).toEqual({
      status: 'failed',
      count: 0,
      error:
        'InvalidSupplierData: hotelId b1: price must be a finite number greater than 0 (got -1)',
    });
    expect(result.hotels).toHaveLength(8);
    expect(result.hotels.every((h) => h.supplier === 'Supplier A')).toBe(true);
  });

  it('treats two empty lists as a successful, non-degraded empty result', async () => {
    const result = await runWorkflow(
      { fetchSupplierAHotels: async () => [], fetchSupplierBHotels: async () => [] },
      'atlantis',
    );
    expect(result).toEqual({
      city: 'atlantis',
      hotels: [],
      suppliers: {
        supplierA: { status: 'success', count: 0 },
        supplierB: { status: 'success', count: 0 },
      },
      degraded: false,
      duplicatesResolved: 0,
      cached: true,
    });
  });

  it('runs from the PRE-BUILT bundle file produced by the real bundle script (as in Docker)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'staysync-bundle-'));
    const bundlePath = path.join(dir, 'workflow-bundle.js');
    try {
      const root = path.resolve(__dirname, '../..');
      await promisify(execFile)(
        path.join(root, 'node_modules/.bin/tsx'),
        ['src/temporal/bundle-workflows.ts', bundlePath],
        { cwd: root },
      );

      const taskQueue = `test-${randomUUID()}`;
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowBundle: { codePath: bundlePath }, // what TEMPORAL_WORKFLOW_BUNDLE_PATH selects
        activities: {
          fetchSupplierAHotels: async () => delhiA,
          fetchSupplierBHotels: async () => delhiB,
          cacheHotelOffers: cacheOk,
        } satisfies SupplierActivities & CacheActivities,
      });
      const result = await worker.runUntil(
        env.client.workflow.execute<typeof hotelOfferWorkflow>(HOTEL_OFFER_WORKFLOW_TYPE, {
          args: [{ city: 'delhi' }],
          taskQueue,
          workflowId: `test-${randomUUID()}`,
        }),
      );
      expect(result.hotels).toHaveLength(11);
      expect(result.duplicatesResolved).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('replays deterministically from its recorded event history', async () => {
    const taskQueue = `test-${randomUUID()}`;
    const workflowId = `test-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: {
        fetchSupplierAHotels: async () => {
          throw unavailable('Supplier A');
        },
        fetchSupplierBHotels: async () => delhiB,
        cacheHotelOffers: cacheOk,
      } satisfies SupplierActivities & CacheActivities,
    });
    await worker.runUntil(
      env.client.workflow.execute<typeof hotelOfferWorkflow>(HOTEL_OFFER_WORKFLOW_TYPE, {
        args: [{ city: 'delhi' }],
        taskQueue,
        workflowId,
      }),
    );

    const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
    // Throws DeterminismViolationError if the workflow code made different decisions on replay.
    await expect(Worker.runReplayHistory({ workflowBundle }, history)).resolves.toBeUndefined();
  });
});

describe('hotelOfferWorkflow — caching step (mocked cache activity)', () => {
  it('caches the final deduplicated result once and reports cached: true', async () => {
    const calls: CacheHotelOffersInput[] = [];
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => delhiA,
      fetchSupplierBHotels: async () => delhiB,
      cacheHotelOffers: async (input) => {
        calls.push(input);
        return cacheOk(input);
      },
    });

    expect(result.cached).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      city: 'delhi',
      hotels: result.hotels, // exactly what the client receives
      degraded: false,
      suppliers: result.suppliers,
    });
  });

  it('passes degraded: true to the cache when a supplier failed', async () => {
    const calls: CacheHotelOffersInput[] = [];
    await runWorkflow({
      fetchSupplierAHotels: async () => {
        throw ApplicationFailure.nonRetryable('bad', SUPPLIER_ERROR_TYPES.badRequest);
      },
      fetchSupplierBHotels: async () => delhiB,
      cacheHotelOffers: async (input) => {
        calls.push(input);
        return cacheOk(input);
      },
    });
    expect(calls[0]?.degraded).toBe(true);
  });

  it('retries a failing cache write, then returns the data anyway with cached: false', async () => {
    const attempts: number[] = [];
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => delhiA,
      fetchSupplierBHotels: async () => delhiB,
      cacheHotelOffers: async () => {
        attempts.push(activityInfo().attempt);
        throw ApplicationFailure.retryable('Cache is unavailable', CACHE_ERROR_TYPES.writeFailed);
      },
    });

    expect(attempts).toEqual([1, 2, 3]);
    expect(result.cached).toBe(false);
    expect(result.hotels).toHaveLength(11); // aggregated result preserved
    expect(result.degraded).toBe(false); // caching problems do not mark suppliers degraded
  });

  it('recovers when a cache write succeeds on retry', async () => {
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => delhiA,
      fetchSupplierBHotels: async () => delhiB,
      cacheHotelOffers: async (input) => {
        if (activityInfo().attempt === 1) {
          throw ApplicationFailure.retryable('blip', CACHE_ERROR_TYPES.writeFailed);
        }
        return cacheOk(input);
      },
    });
    expect(result.cached).toBe(true);
  });

  it('does not retry a non-retryable cache failure', async () => {
    let calls = 0;
    const result = await runWorkflow({
      fetchSupplierAHotels: async () => delhiA,
      fetchSupplierBHotels: async () => delhiB,
      cacheHotelOffers: async () => {
        calls += 1;
        throw ApplicationFailure.nonRetryable('bad payload', CACHE_ERROR_TYPES.invalidPayload);
      },
    });
    expect(calls).toBe(1);
    expect(result.cached).toBe(false);
  });

  it('does not cache anything when every supplier failed', async () => {
    let cacheCalls = 0;
    const err = await runWorkflow({
      fetchSupplierAHotels: async () => {
        throw ApplicationFailure.nonRetryable('a', SUPPLIER_ERROR_TYPES.badRequest);
      },
      fetchSupplierBHotels: async () => {
        throw ApplicationFailure.nonRetryable('b', SUPPLIER_ERROR_TYPES.badRequest);
      },
      cacheHotelOffers: async (input) => {
        cacheCalls += 1;
        return cacheOk(input);
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkflowFailedError);
    expect(cacheCalls).toBe(0);
  });
});

describe('HotelWorkflowClient (real Temporal server)', () => {
  it('coalesces concurrent requests for the same city into ONE workflow run', async () => {
    const taskQueue = `test-${randomUUID()}`;
    let callsA = 0;
    let callsB = 0;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: {
        fetchSupplierAHotels: async () => {
          callsA += 1;
          await sleep(500);
          return delhiA;
        },
        fetchSupplierBHotels: async () => {
          callsB += 1;
          await sleep(500);
          return delhiB;
        },
        cacheHotelOffers: cacheOk,
      } satisfies SupplierActivities & CacheActivities,
    });
    const client = new HotelWorkflowClient(env.client, taskQueue);
    const city = `coalesce-${randomUUID()}`; // unique ID per test run

    // A Worker can only be run once, so both phases share one runUntil.
    const { runs, next } = await worker.runUntil(async () => {
      const concurrent = await Promise.all([1, 2, 3].map(() => client.execute(city)));
      const afterwards = await client.execute(city); // previous run is closed now
      return { runs: concurrent, next: afterwards };
    });

    expect(new Set(runs.map((r) => r.runId)).size).toBe(1);
    expect(runs.every((r) => r.workflowId === `hotel-offers:${city}`)).toBe(true);
    // Three requests, one workflow, one call per supplier (the 4th call is the later run).
    expect(callsA).toBe(2);
    expect(callsB).toBe(2);
    // After it completes, the same ID is reused for a fresh run.
    expect(next.runId).not.toBe(runs[0]!.runId);
  });

  it('maps "all suppliers failed" to SupplierUnavailableError (HTTP 502)', async () => {
    const taskQueue = `test-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: {
        fetchSupplierAHotels: async () => {
          throw ApplicationFailure.nonRetryable('x', SUPPLIER_ERROR_TYPES.badRequest);
        },
        fetchSupplierBHotels: async () => {
          throw ApplicationFailure.nonRetryable('y', SUPPLIER_ERROR_TYPES.badRequest);
        },
        cacheHotelOffers: cacheOk,
      } satisfies SupplierActivities & CacheActivities,
    });
    const client = new HotelWorkflowClient(env.client, taskQueue);

    const err = await worker
      .runUntil(client.execute(`fail-${randomUUID()}`))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SupplierUnavailableError);
    expect((err as SupplierUnavailableError).statusCode).toBe(502);
  });

  it('maps an unreachable Temporal server to DependencyUnavailableError (HTTP 503)', async () => {
    const connection = Connection.lazy({ address: '127.0.0.1:1', connectTimeout: '1 second' });
    const client = new HotelWorkflowClient(new Client({ connection }), 'unused-queue', connection);

    const started = Date.now();
    const err = await client.execute('delhi').catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    await client.close();

    expect(err).toBeInstanceOf(DependencyUnavailableError);
    expect(elapsed).toBeLessThan(8_000); // fails fast thanks to the start deadline (5s)
    expect((err as DependencyUnavailableError).statusCode).toBe(503);
  });
});
