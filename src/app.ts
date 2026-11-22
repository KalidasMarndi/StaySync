import express, { type Express } from 'express';
import type { AppConfig } from './config/env';
import { errorHandler } from './middleware/error.middleware';
import { notFoundHandler } from './middleware/not-found.middleware';
import { requestLogger } from './middleware/request-logger.middleware';
import { SupplierAvailability } from './mock-suppliers/supplier-availability';
import {
  createFailureSimulationRouter,
  createSupplierRouter,
  isFailureSimulationAllowed,
} from './mock-suppliers/supplier.routes';
import { createDevWorkflowRouter } from './routes/dev-workflow.routes';
import { createHealthRouter } from './routes/health.routes';
import { createHotelRouter } from './routes/hotel.routes';
import type { HealthService } from './services/health.service';
import type { HotelService } from './services/hotel.service';
import type { HotelWorkflowExecutor } from './temporal/client';
import { logger } from './utils/logger';

export interface AppDependencies {
  /** Backs GET /api/hotels. Optional so supplier-only tests can build the app without Redis/Temporal. */
  hotelService?: HotelService;
  /** Backs the development-only workflow debug endpoint. */
  hotelWorkflows?: HotelWorkflowExecutor;
  /** Backs GET /health and /health/ready (/health/live needs nothing). */
  healthService?: HealthService;
}

/**
 * Builds the Express application without starting a server, so tests can
 * exercise it in-process with supertest. Every call creates fresh state.
 */
export function createApp(config: AppConfig, deps: AppDependencies = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(express.json({ limit: '10kb' }));

  app.use(createHealthRouter(deps.healthService));

  // Mock third-party suppliers. In a real deployment these would be external services.
  const availability = new SupplierAvailability({
    supplierA: config.suppliers.supplierA.enabled,
    supplierB: config.suppliers.supplierB.enabled,
  });
  app.use(createSupplierRouter(availability, config.suppliers.latencyMs));

  if (deps.hotelService) {
    app.use('/api', createHotelRouter(deps.hotelService));
  }

  if (isFailureSimulationAllowed(config)) {
    app.use('/dev', createFailureSimulationRouter(availability));
    logger.warn('Failure simulation endpoints enabled at /dev — development use only');
  }

  // Same explicit opt-in as the supplier switch: NODE_ENV=development alone is not enough
  // (it is the default), and it can never be enabled in production.
  if (isFailureSimulationAllowed(config) && deps.hotelWorkflows) {
    app.use('/dev', createDevWorkflowRouter(deps.hotelWorkflows));
    logger.warn('Workflow debug endpoint enabled at /dev/workflows — development use only');
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
