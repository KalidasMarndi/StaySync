import { Router } from 'express';
import {
  createHealthHandler,
  createLivenessHandler,
  createReadinessHandler,
} from '../controllers/health.controller';
import type { HealthService } from '../services/health.service';

/** /health/live is always available; /health and /health/ready need the health service. */
export function createHealthRouter(health?: HealthService): Router {
  const router = Router();
  router.get('/health/live', createLivenessHandler());
  if (health) {
    router.get('/health', createHealthHandler(health));
    router.get('/health/ready', createReadinessHandler(health));
  }
  return router;
}
