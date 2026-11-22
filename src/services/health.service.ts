import { logger } from '../utils/logger';

export type DependencyName = 'redis' | 'temporal' | 'worker' | 'supplierA' | 'supplierB';
export type ComponentStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface ComponentHealth {
  status: ComponentStatus;
  latencyMs?: number;
  /** Short, safe reason (never raw error text, hostnames or credentials). */
  error?: string;
  details?: Record<string, unknown>;
}

export interface HealthReport {
  /** healthy: everything up · degraded: still serving, something is down · unhealthy: see `ready` / suppliers. */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Can this API instance serve GET /api/hotels at all (from cache OR through Temporal)? */
  ready: boolean;
  timestamp: string;
  uptimeSeconds: number;
  services: Record<'api' | DependencyName, ComponentHealth>;
}

/** A probe resolves (optionally with details) when healthy and throws when not. */
export type HealthProbe = (signal: AbortSignal) => Promise<Record<string, unknown> | void>;
export type HealthProbes = Record<DependencyName, HealthProbe>;

/** Thrown by probes with a message that is safe to show in the health report. */
export class ProbeError extends Error {
  override name = 'ProbeError';
}

export interface HealthServiceOptions {
  /** Per-probe timeout. */
  timeoutMs?: number;
  /** Reuse a report for this long, so frequent polling does not hammer dependencies. */
  cacheTtlMs?: number;
}

const log = logger.child({ component: 'health' });

/**
 * Runs lightweight, independent dependency probes in parallel, each with its own
 * timeout. It never starts workflows or touches cached hotel data.
 *
 * Readiness: the API can serve /api/hotels if Redis is up (cache hits) OR
 * Temporal + a live worker are up (cache misses). Overall status:
 *   unhealthy — not ready, or both suppliers are down (no fresh data possible)
 *   degraded  — ready, but at least one dependency is down
 *   healthy   — everything is up
 */
export class HealthService {
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly startedAt = Date.now();
  private cached: { report: HealthReport; at: number } | null = null;
  private inFlight: Promise<HealthReport> | null = null;
  private readonly lastStatus = new Map<DependencyName, ComponentStatus>();

  constructor(
    private readonly probes: HealthProbes,
    options: HealthServiceOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000;
  }

  /** Cached for cacheTtlMs; concurrent callers share one in-flight check. */
  async getReport(): Promise<HealthReport> {
    if (this.cached && Date.now() - this.cached.at < this.cacheTtlMs) return this.cached.report;
    this.inFlight ??= this.runChecks().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  private async runChecks(): Promise<HealthReport> {
    const names = Object.keys(this.probes) as DependencyName[];
    const results = await Promise.all(names.map((name) => this.runProbe(this.probes[name])));
    const services = Object.fromEntries(names.map((name, i) => [name, results[i]])) as Record<
      DependencyName,
      ComponentHealth
    >;

    // Worker liveness can only be verified through Temporal.
    if (services.temporal.status !== 'healthy') {
      services.worker = { status: 'unknown', error: 'cannot verify: Temporal is unreachable' };
    }

    const up = (name: DependencyName) => services[name].status === 'healthy';
    const ready = up('redis') || (up('temporal') && up('worker'));
    const allUp = names.every(up);
    const noSuppliers = !up('supplierA') && !up('supplierB');
    const status = !ready || noSuppliers ? 'unhealthy' : allUp ? 'healthy' : 'degraded';

    this.logTransitions(services);
    const report: HealthReport = {
      status,
      ready,
      timestamp: new Date().toISOString(),
      uptimeSeconds: this.uptimeSeconds(),
      services: { api: { status: 'healthy' }, ...services },
    };
    this.cached = { report, at: Date.now() };
    return report;
  }

  private async runProbe(probe: HealthProbe): Promise<ComponentHealth> {
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Reject BEFORE aborting: abort-aware probes (fetch) reject synchronously on abort,
        // and would otherwise win the race and be reported as "unreachable".
        reject(new ProbeError(`timed out after ${this.timeoutMs}ms`));
        controller.abort();
      }, this.timeoutMs);
    });

    try {
      const details = await Promise.race([probe(controller.signal), timeout]);
      return {
        status: 'healthy',
        latencyMs: Date.now() - startedAt,
        ...(details && { details }),
      };
    } catch (err) {
      return {
        status: 'unhealthy',
        latencyMs: Date.now() - startedAt,
        error: err instanceof ProbeError ? err.message : 'unreachable',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Logs only when a dependency changes state, so a long outage is not one log line per poll. */
  private logTransitions(services: Record<DependencyName, ComponentHealth>): void {
    for (const [name, health] of Object.entries(services) as Array<
      [DependencyName, ComponentHealth]
    >) {
      const previous = this.lastStatus.get(name);
      if (previous === health.status) continue;
      this.lastStatus.set(name, health.status);
      if (health.status === 'healthy') {
        if (previous) log.info({ dependency: name }, 'Dependency recovered');
      } else {
        log.warn(
          { dependency: name, status: health.status, error: health.error },
          'Dependency unhealthy',
        );
      }
    }
  }
}
