import { Router } from 'express';
import { z } from 'zod';
import type { HotelWorkflowExecutor } from '../temporal/client';
import { parseOrThrow } from '../utils/validation';
import { citySchema } from '../validation/query.schemas';

const querySchema = z.object({ city: citySchema });

/**
 * Development-only: GET /dev/workflows/hotel-offers?city=delhi
 *
 * Always runs hotelOfferWorkflow (no cache read) and returns the full internal
 * result (supplier statuses, degraded flag, duplicates, cached) — used for
 * debugging and the supplier-failure demo. Mounted only with
 * NODE_ENV=development AND ENABLE_FAILURE_SIMULATION=true (see app.ts).
 */
export function createDevWorkflowRouter(workflows: HotelWorkflowExecutor): Router {
  const router = Router();

  router.get('/workflows/hotel-offers', async (req, res) => {
    const { city } = parseOrThrow(querySchema, req.query, 'Invalid query');
    res.json(await workflows.execute(city));
  });

  return router;
}
