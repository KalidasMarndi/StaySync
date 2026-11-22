import type { Client, Connection } from '@temporalio/client';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config/env';
import { ProbeError, type HealthProbe, type HealthProbes } from './health.service';

/**
 * A worker re-polls its task queue at least every ~60s (the long-poll length),
 * and Temporal keeps listing a stopped worker as a poller. So "healthy" means a
 * poll was seen within this window — a just-stopped worker can still look
 * healthy for up to this long.
 */
export const WORKER_POLL_FRESHNESS_MS = 90_000;

/** grpc.health.v1.HealthCheckResponse.ServingStatus.SERVING */
const GRPC_SERVING = 1;
/** temporal.api.enums.v1: TaskQueueKind.NORMAL / TaskQueueType.WORKFLOW */
const TASK_QUEUE_KIND_NORMAL = 1;
const TASK_QUEUE_TYPE_WORKFLOW = 1;

/** Supplier probe city: a valid query that returns [] quickly, never a real aggregation. */
export const SUPPLIER_PROBE_CITY = 'health-check';

export interface HealthProbeDependencies {
  config: AppConfig;
  redis: Redis;
  temporalClient: Client;
  temporalConnection: Connection;
  /** Used for gRPC deadlines so a dead server cannot keep retrying in the background. */
  timeoutMs: number;
}

export function createHealthProbes(deps: HealthProbeDependencies): HealthProbes {
  return {
    redis: redisProbe(deps.redis),
    temporal: temporalProbe(deps.temporalConnection, deps.timeoutMs),
    worker: workerProbe(deps.temporalClient, deps.config.temporal, deps.timeoutMs),
    supplierA: supplierProbe(deps.config.suppliers.supplierA.baseUrl),
    supplierB: supplierProbe(deps.config.suppliers.supplierB.baseUrl),
  };
}

/** PING (read-only). With no offline queue, it fails at once while disconnected. */
export function redisProbe(redis: Redis): HealthProbe {
  return async () => {
    if (redis.status !== 'ready') throw new ProbeError(`not connected (${redis.status})`);
    const reply = await redis.ping();
    if (reply !== 'PONG') throw new ProbeError('unexpected PING reply');
  };
}

/** Standard gRPC health check against the Temporal frontend. */
export function temporalProbe(connection: Connection, timeoutMs: number): HealthProbe {
  return async () => {
    const response = await connection.withDeadline(Date.now() + timeoutMs, () =>
      connection.healthService.check({}),
    );
    if (response.status !== GRPC_SERVING) throw new ProbeError('not serving');
  };
}

/**
 * Asks Temporal which workers polled the task queue recently. A reachable
 * Temporal server alone does NOT mean a worker is running.
 */
export function workerProbe(
  client: Client,
  temporal: AppConfig['temporal'],
  timeoutMs: number,
): HealthProbe {
  return async () => {
    const response = await client.withDeadline(Date.now() + timeoutMs, () =>
      client.workflowService.describeTaskQueue({
        namespace: temporal.namespace,
        taskQueue: { name: temporal.taskQueue, kind: TASK_QUEUE_KIND_NORMAL },
        taskQueueType: TASK_QUEUE_TYPE_WORKFLOW,
      }),
    );

    const now = Date.now();
    const ages = response.pollers
      .map((poller) => poller.lastAccessTime?.seconds)
      .filter((seconds) => seconds !== null && seconds !== undefined)
      .map((seconds) => now - Number(seconds.toString()) * 1000);
    const freshest = ages.length > 0 ? Math.min(...ages) : undefined;
    const active = ages.filter((age) => age <= WORKER_POLL_FRESHNESS_MS).length;

    if (freshest === undefined) {
      throw new ProbeError(`no worker polling task queue "${temporal.taskQueue}"`);
    }
    if (active === 0) {
      throw new ProbeError(`no worker poll for ${Math.round(freshest / 1000)}s`);
    }
    return { activePollers: active, lastPollSecondsAgo: Math.max(0, Math.round(freshest / 1000)) };
  };
}

/** GET <supplier>/hotels?city=health-check — the real endpoint, a trivial query. */
export function supplierProbe(baseUrl: string): HealthProbe {
  return async (signal) => {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/hotels`);
    url.searchParams.set('city', SUPPLIER_PROBE_CITY);

    let response: Response;
    try {
      response = await fetch(url, { signal, headers: { accept: 'application/json' } });
    } catch {
      throw new ProbeError('unreachable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProbeError(`HTTP ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) throw new ProbeError('invalid response');
  };
}
