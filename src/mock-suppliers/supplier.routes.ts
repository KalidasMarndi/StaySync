import { Router } from 'express';
import type { AppConfig } from '../config/env';
import { SUPPLIER_A_HOTELS } from './data/supplier-a.data';
import { SUPPLIER_B_HOTELS } from './data/supplier-b.data';
import { createFailureSimulationHandlers } from './failure-simulation.controller';
import type { SupplierAvailability } from './supplier-availability';
import { createSupplierHotelsHandler } from './supplier.controller';

/** GET /supplierA/hotels and GET /supplierB/hotels — the mock third-party APIs. */
export function createSupplierRouter(
  availability: SupplierAvailability,
  latencyMs: number,
): Router {
  const router = Router();

  router.get(
    '/supplierA/hotels',
    createSupplierHotelsHandler({
      supplierId: 'supplierA',
      hotels: SUPPLIER_A_HOTELS,
      availability,
      latencyMs,
    }),
  );
  router.get(
    '/supplierB/hotels',
    createSupplierHotelsHandler({
      supplierId: 'supplierB',
      hotels: SUPPLIER_B_HOTELS,
      availability,
      latencyMs,
    }),
  );

  return router;
}

/**
 * Safety check for the runtime toggle. The config loader already refuses to
 * start with this combination; checking again here means the route can never
 * be mounted in production, even if a config object is built some other way.
 */
export function isFailureSimulationAllowed(config: AppConfig): boolean {
  return config.suppliers.failureSimulationEnabled && config.nodeEnv !== 'production';
}

/**
 * GET /dev/suppliers/availability
 * PUT /dev/suppliers/:supplierId/availability   body: { "enabled": boolean }
 */
export function createFailureSimulationRouter(availability: SupplierAvailability): Router {
  const router = Router();
  const handlers = createFailureSimulationHandlers(availability);

  router.get('/suppliers/availability', handlers.getAvailability);
  router.put('/suppliers/:supplierId/availability', handlers.setAvailability);

  return router;
}
