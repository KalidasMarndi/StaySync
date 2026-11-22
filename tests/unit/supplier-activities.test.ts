import { ApplicationFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { DefaultLogger } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupplierActivities } from '../../src/activities/supplier.activities';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { SUPPLIER_ERROR_TYPES } from '../../src/temporal/constants';
import type { SupplierFetchInput } from '../../src/types/workflow.types';
import { startServer, type RunningServer } from '../helpers/http';

/**
 * Supplier activities run inside MockActivityEnvironment (a real activity
 * context, no Temporal server) and make REAL HTTP requests to either the
 * real Express supplier endpoints or a stub server that misbehaves on demand.
 */

let suppliers: RunningServer; // real mock-supplier API, Supplier B switched off
let stub: RunningServer; // misbehaving supplier

beforeAll(async () => {
  suppliers = await startServer(
    createApp(loadConfig({ NODE_ENV: 'test', SUPPLIER_B_ENABLED: 'false' })),
  );

  stub = await startServer((req, res) => {
    const behaviour = new URL(req.url ?? '/', 'http://stub').pathname.split('/')[1];
    switch (behaviour) {
      case 'server-error':
        res.writeHead(500).end('boom');
        return;
      case 'not-found':
        res.writeHead(404).end();
        return;
      case 'not-json':
        res.writeHead(200, { 'content-type': 'application/json' }).end('<html>oops</html>');
        return;
      case 'bad-schema':
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify([{ hotelId: 'x1', name: 'No Price', city: 'delhi' }]));
        return;
      case 'extra-fields':
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify([
            {
              hotelId: 'x1',
              name: 'Extra',
              price: 100,
              city: 'delhi',
              commissionPct: 5,
              internal: 'secret',
            },
          ]),
        );
        return;
      case 'payload': {
        // Echoes the hotel list encoded in the query string, to test business-rule validation.
        const body = new URL(req.url ?? '/', 'http://stub').searchParams.get('body') ?? '[]';
        res.writeHead(200, { 'content-type': 'application/json' }).end(body);
        return;
      }
      case 'slow':
        setTimeout(() => res.writeHead(200).end('[]'), 1_000);
        return;
      default:
        res.writeHead(418).end();
    }
  });
});

afterAll(async () => {
  await Promise.all([suppliers?.close(), stub?.close()]);
});

/** Runs an activity in a fresh mock activity context; keeps the activity's return type. */
function runActivity<T>(fn: (input: SupplierFetchInput) => Promise<T>, input: SupplierFetchInput) {
  const env = new MockActivityEnvironment({}, { logger: new DefaultLogger('ERROR') });
  return env.run(fn, input) as Promise<T>;
}

function activitiesFor(baseA: string, baseB = baseA, requestTimeoutMs = 2_000) {
  return createSupplierActivities({
    baseUrls: { supplierA: baseA, supplierB: baseB },
    requestTimeoutMs,
  });
}

async function expectFailure(
  promise: Promise<unknown>,
  type: string,
  retryable: boolean,
): Promise<ApplicationFailure> {
  const err = await promise.then(
    () => {
      throw new Error('expected the activity to fail');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApplicationFailure);
  const failure = err as ApplicationFailure;
  expect(failure.type).toBe(type);
  expect(failure.nonRetryable).toBe(!retryable);
  return failure;
}

describe('supplier activities — real Express supplier endpoints', () => {
  it('fetchSupplierAHotels returns validated Delhi hotels via HTTP', async () => {
    const { fetchSupplierAHotels } = activitiesFor(
      `${suppliers.baseUrl}/supplierA`,
      `${suppliers.baseUrl}/supplierB`,
    );

    const hotels = await runActivity(fetchSupplierAHotels, { city: 'delhi' });

    expect(hotels).toHaveLength(8);
    expect(hotels[0]).toEqual({
      hotelId: 'a1',
      name: 'Holtin',
      price: 6000,
      city: 'delhi',
      commissionPct: 10,
    });
  });

  it('returns [] (success, not failure) for a city with no inventory', async () => {
    const { fetchSupplierAHotels } = activitiesFor(`${suppliers.baseUrl}/supplierA`);
    expect(await runActivity(fetchSupplierAHotels, { city: 'atlantis' })).toEqual([]);
  });

  it('HTTP 503 (supplier disabled) → retryable SupplierUnavailable', async () => {
    const { fetchSupplierBHotels } = activitiesFor(
      `${suppliers.baseUrl}/supplierA`,
      `${suppliers.baseUrl}/supplierB`,
    );
    const failure = await expectFailure(
      runActivity(fetchSupplierBHotels, { city: 'delhi' }),
      SUPPLIER_ERROR_TYPES.unavailable,
      true,
    );
    expect(failure.message).toBe('Supplier B is unavailable (HTTP 503)');
  });

  it('HTTP 400 (invalid city) → non-retryable SupplierBadRequest', async () => {
    const { fetchSupplierAHotels } = activitiesFor(`${suppliers.baseUrl}/supplierA`);
    await expectFailure(
      runActivity(fetchSupplierAHotels, { city: '' }),
      SUPPLIER_ERROR_TYPES.badRequest,
      false,
    );
  });
});

describe('supplier activities — misbehaving supplier', () => {
  it('HTTP 500 → retryable SupplierServerError', async () => {
    const { fetchSupplierAHotels } = activitiesFor(`${stub.baseUrl}/server-error`);
    await expectFailure(
      runActivity(fetchSupplierAHotels, { city: 'delhi' }),
      SUPPLIER_ERROR_TYPES.serverError,
      true,
    );
  });

  it('other 4xx (404) → non-retryable SupplierClientError', async () => {
    const { fetchSupplierAHotels } = activitiesFor(`${stub.baseUrl}/not-found`);
    await expectFailure(
      runActivity(fetchSupplierAHotels, { city: 'delhi' }),
      SUPPLIER_ERROR_TYPES.clientError,
      false,
    );
  });

  it('body that is not JSON → non-retryable InvalidSupplierResponse', async () => {
    const { fetchSupplierAHotels } = activitiesFor(`${stub.baseUrl}/not-json`);
    await expectFailure(
      runActivity(fetchSupplierAHotels, { city: 'delhi' }),
      SUPPLIER_ERROR_TYPES.invalidResponse,
      false,
    );
  });

  it('JSON with the wrong shape → non-retryable InvalidSupplierResponse', async () => {
    const { fetchSupplierAHotels } = activitiesFor(`${stub.baseUrl}/bad-schema`);
    const failure = await expectFailure(
      runActivity(fetchSupplierAHotels, { city: 'delhi' }),
      SUPPLIER_ERROR_TYPES.invalidResponse,
      false,
    );
    expect(failure.message).toContain('0.price');
  });

  const offer = (override: Record<string, unknown>) =>
    JSON.stringify([
      { hotelId: 'x1', name: 'Hotel', price: 100, city: 'delhi', commissionPct: 5, ...override },
    ]);

  it.each([
    ['zero price', offer({ price: 0 }), 'price must be a finite number greater than 0'],
    ['negative price', offer({ price: -1 }), 'price must be a finite number greater than 0'],
    ['Infinity price (1e999)', offer({ price: 1 }).replace('"price":1', '"price":1e999'), 'price'],
    [
      'commission over 100',
      offer({ commissionPct: 150 }),
      'commissionPct must be between 0 and 100',
    ],
    ['blank name', offer({ name: '   ' }), 'name must not be blank'],
    ['empty hotelId', offer({ hotelId: '' }), 'hotelId must be a non-empty string'],
  ])('rejects %s as non-retryable InvalidSupplierResponse', async (_label, body, reason) => {
    const { fetchSupplierAHotels } = activitiesFor(
      `${stub.baseUrl}/payload?body=${encodeURIComponent(body)}#`,
    );
    const failure = await expectFailure(
      runActivity(fetchSupplierAHotels, { city: 'delhi' }),
      SUPPLIER_ERROR_TYPES.invalidResponse,
      false,
    );
    expect(failure.message).toContain(reason);
  });

  it('passes raw names through unchanged (normalization happens in the domain layer)', async () => {
    const { fetchSupplierAHotels } = activitiesFor(
      `${stub.baseUrl}/payload?body=${encodeURIComponent(offer({ name: '  the oberoi ' }))}#`,
    );
    const hotels = await runActivity(fetchSupplierAHotels, { city: 'delhi' });
    expect(hotels[0]?.name).toBe('  the oberoi ');
  });

  it('strips unknown fields from supplier payloads', async () => {
    const { fetchSupplierAHotels } = activitiesFor(`${stub.baseUrl}/extra-fields`);
    const hotels = await runActivity(fetchSupplierAHotels, { city: 'delhi' });
    expect(hotels).toEqual([
      { hotelId: 'x1', name: 'Extra', price: 100, city: 'delhi', commissionPct: 5 },
    ]);
  });

  it('request slower than the timeout → retryable SupplierTimeout', async () => {
    const { fetchSupplierAHotels } = activitiesFor(`${stub.baseUrl}/slow`, undefined, 150);
    const started = Date.now();
    const failure = await expectFailure(
      runActivity(fetchSupplierAHotels, { city: 'delhi' }),
      SUPPLIER_ERROR_TYPES.timeout,
      true,
    );
    expect(Date.now() - started).toBeLessThan(900);
    expect(failure.message).toBe('Supplier A did not respond within 150ms');
  });

  it('connection refused → retryable SupplierNetworkError', async () => {
    const closed = await startServer(() => undefined);
    await closed.close(); // port is now free, so connections are refused
    const { fetchSupplierAHotels } = activitiesFor(`${closed.baseUrl}/supplierA`);

    await expectFailure(
      runActivity(fetchSupplierAHotels, { city: 'delhi' }),
      SUPPLIER_ERROR_TYPES.network,
      true,
    );
  });
});
