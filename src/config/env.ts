import { z } from 'zod';
import { SUPPLIER_ACTIVITY_START_TO_CLOSE_MS } from '../temporal/constants';

/**
 * Environment variables arrive as strings. `z.coerce.boolean()` would turn the
 * string "false" into `true`, so booleans are parsed explicitly.
 */
const booleanFromString = z
  .enum(['true', 'false'], { error: 'must be "true" or "false"' })
  .transform((value) => value === 'true');

const port = z.coerce.number().int().min(1).max(65_535);
const nonNegativeInt = z.coerce.number().int().min(0);
const positiveInt = z.coerce.number().int().min(1);
// z.url() alone accepts values containing spaces (e.g. two variables pasted into one);
// reject them at startup instead of failing later with confusing 404s.
const httpUrl = z.url().refine((value) => !/\s/.test(value), 'must not contain whitespace');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(4000),
    // Read by the logger directly (so config errors can be logged); validated here too.
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),

    REDIS_HOST: z.string().min(1).default('localhost'),
    REDIS_PORT: port.default(6379),
    REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
    REDIS_PASSWORD: z.string().min(1).optional(),
    REDIS_TLS: booleanFromString.default(false),

    TEMPORAL_ADDRESS: z.string().min(1).default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
    TEMPORAL_TASK_QUEUE: z.string().min(1).default('hotel-offers'),
    // Optional pre-built workflow bundle (set in the Docker image); unset → bundle at startup.
    TEMPORAL_WORKFLOW_BUNDLE_PATH: z.string().min(1).optional(),

    SUPPLIER_A_BASE_URL: httpUrl.default('http://localhost:4000/supplierA'),
    SUPPLIER_B_BASE_URL: httpUrl.default('http://localhost:4000/supplierB'),
    SUPPLIER_A_ENABLED: booleanFromString.default(true),
    SUPPLIER_B_ENABLED: booleanFromString.default(true),
    SUPPLIER_LATENCY_MS: nonNegativeInt.max(10_000).default(0),
    // HTTP timeout per supplier request; must end before Temporal's per-attempt timeout.
    SUPPLIER_REQUEST_TIMEOUT_MS: positiveInt
      .max(SUPPLIER_ACTIVITY_START_TO_CLOSE_MS - 500, {
        error: `must be at most ${SUPPLIER_ACTIVITY_START_TO_CLOSE_MS - 500}ms (below the activity startToCloseTimeout)`,
      })
      .default(3_000),
    ENABLE_FAILURE_SIMULATION: booleanFromString.default(false),

    CACHE_TTL_SECONDS: positiveInt.default(300),
    DEGRADED_CACHE_TTL_SECONDS: positiveInt.default(30),
  })
  .superRefine((env, ctx) => {
    // Fail fast: the failure-simulation endpoint must never be reachable in production.
    if (env.NODE_ENV === 'production' && env.ENABLE_FAILURE_SIMULATION) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENABLE_FAILURE_SIMULATION'],
        message: 'must not be enabled when NODE_ENV=production',
      });
    }
    if (env.DEGRADED_CACHE_TTL_SECONDS > env.CACHE_TTL_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEGRADED_CACHE_TTL_SECONDS'],
        message: 'must not exceed CACHE_TTL_SECONDS',
      });
    }
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  redis: { host: string; port: number; db: number; password: string | undefined; tls: boolean };

  temporal: {
    address: string;
    namespace: string;
    taskQueue: string;
    workflowBundlePath: string | undefined;
    tls: boolean;
  };
  suppliers: {
    supplierA: { baseUrl: string; enabled: boolean };
    supplierB: { baseUrl: string; enabled: boolean };
    latencyMs: number;
    requestTimeoutMs: number;
    failureSimulationEnabled: boolean;
  };
  cache: { ttlSeconds: number; degradedTtlSeconds: number };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Validates the environment once at startup and maps it to a typed config object. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  const env = result.data;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    redis: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      db: env.REDIS_DB,
      password: env.REDIS_PASSWORD,
      tls: env.REDIS_TLS,
    },
    temporal: {
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowBundlePath: env.TEMPORAL_WORKFLOW_BUNDLE_PATH,
      tls: false,
    },
    suppliers: {
      supplierA: { baseUrl: env.SUPPLIER_A_BASE_URL, enabled: env.SUPPLIER_A_ENABLED },
      supplierB: { baseUrl: env.SUPPLIER_B_BASE_URL, enabled: env.SUPPLIER_B_ENABLED },
      latencyMs: env.SUPPLIER_LATENCY_MS,
      requestTimeoutMs: env.SUPPLIER_REQUEST_TIMEOUT_MS,
      failureSimulationEnabled: env.ENABLE_FAILURE_SIMULATION,
    },
    cache: {
      ttlSeconds: env.CACHE_TTL_SECONDS,
      degradedTtlSeconds: env.DEGRADED_CACHE_TTL_SECONDS,
    },
  };
}
