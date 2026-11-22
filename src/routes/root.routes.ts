import { Router, type RequestHandler } from 'express';

export interface RootServiceInfo {
  name: string;
  description: string;
  status: string;
  deployment: string;
  documentation: string;
  endpoints: string[];
}

export function createRootHandler(): RequestHandler {
  return (_req, res) => {
    const info: RootServiceInfo = {
      name: 'StaySync',
      description: 'Hotel Offer Orchestrator API',
      status: 'operational',
      deployment: 'Render',
      documentation: 'https://github.com/KalidasMarndi/StaySync#readme',
      endpoints: ['/health', '/health/live', '/health/ready', '/api/hotels?city=delhi'],
    };
    res.json(info);
  };
}

export function createRootRouter(): Router {
  const router = Router();
  router.get('/', createRootHandler());
  return router;
}
