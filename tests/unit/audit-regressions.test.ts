import { ApplicationFailure, WorkflowFailedError } from '@temporalio/client';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { HotelService } from '../../src/services/hotel.service';
import type { HotelCacheReader } from '../../src/services/redis.service';
import { HotelWorkflowClient, type HotelWorkflowExecutor } from '../../src/temporal/client';
import { SupplierUnavailableError } from '../../src/utils/errors';

/** Regression tests for defects found in the final release audit. */

const emptyHit: HotelCacheReader = {
  filterHotelsByPrice: async (city) => ({
    hotels: [],
    metadata: {
      city,
      count: 0,
      degraded: false,
      refreshedAt: new Date().toISOString(),
      ttlSeconds: 300,
      suppliers: {
        supplierA: { status: 'success', count: 0 },
        supplierB: { status: 'success', count: 0 },
      },
    },
  }),
};
const unusedWorkflows: HotelWorkflowExecutor = {
  execute: async () => {
    throw new Error('workflow must not run');
  },
};

describe('audit: non-Latin city names', () => {
  it.each(['москва', '東京', 'münchen'])(
    'city %s → 200 with a percent-encoded X-City header (not a 500)',
    async (city) => {
      const app = createApp(loadConfig({ NODE_ENV: 'test' }), {
        hotelService: new HotelService({ cache: emptyHit, workflows: unusedWorkflows }),
      });

      const res = await request(app).get('/api/hotels').query({ city });

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(decodeURIComponent(res.headers['x-city'] as string)).toBe(city);
    },
  );
});

describe('audit: dev-only workflow endpoint', () => {
  it('is NOT mounted in development unless ENABLE_FAILURE_SIMULATION=true', async () => {
    const app = createApp(loadConfig({ NODE_ENV: 'development' }), {
      hotelWorkflows: unusedWorkflows,
    });
    expect((await request(app).get('/dev/workflows/hotel-offers?city=delhi')).status).toBe(404);
  });

  it('is NOT mounted with the default configuration (as used by a bare `npm start`)', async () => {
    const app = createApp(loadConfig({}), { hotelWorkflows: unusedWorkflows });
    expect((await request(app).get('/dev/workflows/hotel-offers?city=delhi')).status).toBe(404);
  });

  it('is mounted with the explicit development opt-in', async () => {
    const app = createApp(
      loadConfig({ NODE_ENV: 'development', ENABLE_FAILURE_SIMULATION: 'true' }),
      { hotelWorkflows: unusedWorkflows },
    );
    expect((await request(app).get('/dev/workflows/hotel-offers?city=delhi')).status).toBe(500);
  });
});

describe('audit: 502 response must not leak internal supplier errors', () => {
  it('exposes only per-supplier status and error type', async () => {
    const cause = ApplicationFailure.create({
      type: 'AllSuppliersUnavailable',
      message: 'All suppliers are unavailable',
      nonRetryable: true,
      details: [
        {
          supplierA: {
            status: 'failed',
            count: 0,
            error:
              'SupplierNetworkError: Supplier A request failed: connect ECONNREFUSED 172.18.0.4:4000',
          },
          supplierB: {
            status: 'failed',
            count: 0,
            error: 'SupplierUnavailable: Supplier B is unavailable (HTTP 503)',
          },
        },
      ],
    });
    const fakeClient = {
      withDeadline: <T>(_deadline: number, fn: () => Promise<T>) => fn(),
      workflow: {
        start: async () => ({
          firstExecutionRunId: 'run-1',
          result: async () => {
            throw new WorkflowFailedError(
              'Workflow execution failed',
              cause,
              'NON_RETRYABLE_FAILURE',
            );
          },
        }),
      },
    };
    const client = new HotelWorkflowClient(fakeClient as never, 'queue');

    const err = await client.execute('delhi').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SupplierUnavailableError);
    expect((err as SupplierUnavailableError).details).toEqual({
      supplierA: { status: 'failed', reason: 'SupplierNetworkError' },
      supplierB: { status: 'failed', reason: 'SupplierUnavailable' },
    });
    expect(JSON.stringify((err as SupplierUnavailableError).details)).not.toMatch(
      /ECONNREFUSED|172\.18|4000/,
    );
  });
});
