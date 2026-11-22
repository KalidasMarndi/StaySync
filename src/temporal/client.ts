import {
  ApplicationFailure,
  Client,
  Connection,
  isGrpcServiceError,
  ServiceError,
  TimeoutFailure,
  WorkflowFailedError,
} from '@temporalio/client';
import type { AppConfig } from '../config/env';
import type { HotelOfferWorkflowInput, HotelOfferWorkflowResult } from '../types/workflow.types';
import {
  AppError,
  DependencyUnavailableError,
  SupplierUnavailableError,
  WorkflowExecutionError,
  WorkflowTimeoutError,
} from '../utils/errors';
import { logger } from '../utils/logger';
import type { hotelOfferWorkflow } from '../workflows/hotel.workflow';
import {
  HOTEL_OFFER_WORKFLOW_EXECUTION_TIMEOUT_MS,
  HOTEL_OFFER_WORKFLOW_TYPE,
  WORKFLOW_ERROR_TYPES,
  WORKFLOW_RESULT_DEADLINE_MS,
  WORKFLOW_START_DEADLINE_MS,
} from './constants';

export interface HotelWorkflowRun {
  workflowId: string;
  runId: string;
  durationMs: number;
  result: HotelOfferWorkflowResult;
}

/** What the API layer needs from Temporal. An interface, so tests can substitute it. */
export interface HotelWorkflowExecutor {
  execute(city: string): Promise<HotelWorkflowRun>;
}

/**
 * One workflow ID per city. Combined with the USE_EXISTING conflict policy,
 * concurrent requests for the same city attach to a single running workflow
 * instead of each starting their own.
 */
export function hotelOfferWorkflowId(city: string): string {
  return `hotel-offers:${city}`;
}

/**
 * Lazy connection: the API can boot while Temporal is still starting (or down).
 * The connection is made on first use; failures surface as 503s / unhealthy checks.
 * Shared by the workflow client and the health probes.
 */
export function createTemporalClient(config: AppConfig): {
  client: Client;
  connection: Connection;
} {
  const connection = Connection.lazy({
    address: config.temporal.address,
    connectTimeout: '5 seconds',
  });
  return { client: new Client({ connection, namespace: config.temporal.namespace }), connection };
}

/** Starts hotelOfferWorkflow runs and maps Temporal errors to HTTP-aware AppErrors. */
export class HotelWorkflowClient implements HotelWorkflowExecutor {
  constructor(
    private readonly client: Client,
    private readonly taskQueue: string,
    private readonly connection?: Connection,
  ) {}

  async execute(city: string): Promise<HotelWorkflowRun> {
    const workflowId = hotelOfferWorkflowId(city);
    const startedAt = Date.now();

    try {
      // The workflow is referenced by type name (no runtime import of workflow code in the API).
      const handle = await this.client.withDeadline(Date.now() + WORKFLOW_START_DEADLINE_MS, () =>
        this.client.workflow.start<typeof hotelOfferWorkflow>(HOTEL_OFFER_WORKFLOW_TYPE, {
          args: [{ city } satisfies HotelOfferWorkflowInput],
          taskQueue: this.taskQueue,
          workflowId,
          // Running workflow with this ID? Attach to it rather than start a duplicate.
          workflowIdConflictPolicy: 'USE_EXISTING',
          // Previous run finished? Allow a fresh run with the same ID.
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          workflowExecutionTimeout: HOTEL_OFFER_WORKFLOW_EXECUTION_TIMEOUT_MS,
        }),
      );
      const runId = handle.firstExecutionRunId;
      logger.info({ workflowId, runId, city }, 'Workflow started');

      const result = await this.client.withDeadline(Date.now() + WORKFLOW_RESULT_DEADLINE_MS, () =>
        handle.result(),
      );
      const durationMs = Date.now() - startedAt;
      logger.info(
        {
          workflowId,
          runId,
          city,
          durationMs,
          hotelCount: result.hotels.length,
          duplicatesResolved: result.duplicatesResolved,
          degraded: result.degraded,
        },
        'Workflow completed',
      );
      return { workflowId, runId, durationMs, result };
    } catch (err) {
      const mapped = toAppError(err, city);
      logger.error(
        { workflowId, city, durationMs: Date.now() - startedAt, code: mapped.code, err },
        'Workflow failed',
      );
      throw mapped;
    }
  }

  /** Closes the connection if this instance owns it. */
  async close(): Promise<void> {
    await this.connection?.close();
  }
}

function toAppError(err: unknown, city: string): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof WorkflowFailedError) {
    const cause = err.cause;
    if (
      cause instanceof ApplicationFailure &&
      cause.type === WORKFLOW_ERROR_TYPES.allSuppliersUnavailable
    ) {
      return new SupplierUnavailableError(
        `All suppliers are unavailable for city "${city}"`,
        publicSupplierStatus(cause.details?.[0]),
        { cause: err },
      );
    }
    if (cause instanceof TimeoutFailure) {
      return new WorkflowTimeoutError('Hotel aggregation timed out', { cause: err });
    }
    return new WorkflowExecutionError('Hotel aggregation failed', { cause: err });
  }

  // gRPC-level failures: server unreachable, deadline exceeded, etc.
  if (err instanceof ServiceError || isGrpcServiceError(err)) {
    return new DependencyUnavailableError('temporal', 'Workflow service is unavailable', {
      cause: err,
    });
  }

  return new WorkflowExecutionError('Hotel aggregation failed', { cause: err });
}

/**
 * Per-supplier failure info that is safe for API clients: status and error TYPE only.
 * The full messages (which can contain internal hosts/IPs, e.g. "connect ECONNREFUSED
 * 172.18.0.4:4000") stay in the logs and in Temporal's history.
 */
function publicSupplierStatus(
  details: unknown,
): Record<string, { status: string; reason?: string }> | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  return Object.fromEntries(
    Object.entries(details as Record<string, { status?: unknown; error?: unknown }>).map(
      ([supplier, value]) => {
        const status = typeof value?.status === 'string' ? value.status : 'unknown';
        const reason =
          typeof value?.error === 'string' ? value.error.split(':')[0]?.trim() : undefined;
        return [supplier, reason ? { status, reason } : { status }];
      },
    ),
  );
}
