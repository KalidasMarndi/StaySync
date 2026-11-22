import type { RequestHandler } from 'express';
import type { HealthService } from '../services/health.service';

/**
 * GET /health/live — the process is up and its event loop answers.
 * Checks NO dependencies: a Redis or Temporal outage must not get the API restarted.
 */
export function createLivenessHandler(startedAt = Date.now()): RequestHandler {
  return (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  };
}

/** GET /health — full dependency report. 503 only when unhealthy. */
export function createHealthHandler(health: HealthService): RequestHandler {
  return async (_req, res) => {
    const report = await health.getReport();
    res
      .status(report.status === 'unhealthy' ? 503 : 200)
      .set('Cache-Control', 'no-store')
      .json(report);
  };
}

/** GET /health/ready — can this instance serve /api/hotels (from cache or via Temporal)? */
export function createReadinessHandler(health: HealthService): RequestHandler {
  return async (_req, res) => {
    const report = await health.getReport();
    const { redis, temporal, worker } = report.services;
    res
      .status(report.ready ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json({
        status: report.ready ? 'ready' : 'not_ready',
        timestamp: report.timestamp,
        services: { redis, temporal, worker },
      });
  };
}
