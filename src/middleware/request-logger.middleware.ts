import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import { logger } from '../utils/logger';

// Accept a caller-supplied correlation ID only if it is short and safe to log.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

/**
 * Logs one access line per request (ID, method, URL, status, duration).
 * Access lines are always `info`: failures are already logged with full
 * context at warn/error level by the central error handler.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: resolveRequestId,
  customLogLevel: () => 'info',
  // Liveness/readiness are polled every few seconds by orchestrators; don't flood the logs.
  autoLogging: { ignore: (req) => req.url === '/health/live' || req.url === '/health/ready' },
  // Keep request logs lean: no headers, no bodies.
  serializers: {
    req: (req: { id: string; method: string; url: string }) => ({
      id: req.id,
      method: req.method,
      url: req.url,
    }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
  },
});
