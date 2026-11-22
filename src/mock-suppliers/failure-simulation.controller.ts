import type { RequestHandler } from 'express';
import { z } from 'zod';
import { SUPPLIER_IDS } from '../types/supplier.types';
import { parseOrThrow } from '../utils/validation';
import type { SupplierAvailability } from './supplier-availability';

const paramsSchema = z.object({
  supplierId: z.enum(SUPPLIER_IDS, { error: 'supplierId must be "supplierA" or "supplierB"' }),
});

const bodySchema = z.object({
  enabled: z.boolean({ error: 'enabled must be a boolean' }),
});

/**
 * Development-only handlers that switch a mock supplier on or off at runtime,
 * so an outage can be demonstrated without restarting containers.
 * They are only mounted when the failure-simulation check passes (see app.ts).
 */
export function createFailureSimulationHandlers(availability: SupplierAvailability): {
  getAvailability: RequestHandler;
  setAvailability: RequestHandler;
} {
  return {
    getAvailability: (_req, res) => {
      res.json(availability.snapshot());
    },

    setAvailability: (req, res) => {
      const { supplierId } = parseOrThrow(paramsSchema, req.params, 'Invalid supplier');
      const { enabled } = parseOrThrow(bodySchema, req.body ?? {}, 'Invalid availability payload');

      availability.setEnabled(supplierId, enabled);
      req.log.warn(
        { supplier: supplierId, enabled },
        'Supplier availability changed (failure simulation)',
      );

      res.json(availability.snapshot());
    },
  };
}
