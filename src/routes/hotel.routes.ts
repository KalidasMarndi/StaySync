import { Router } from 'express';
import { createHotelSearchHandler } from '../controllers/hotel.controller';
import type { HotelService } from '../services/hotel.service';

export function createHotelRouter(hotelService: HotelService): Router {
  const router = Router();
  router.get('/hotels', createHotelSearchHandler(hotelService));
  return router;
}
