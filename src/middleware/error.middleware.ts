import type { ErrorRequestHandler } from 'express';
import { AppError } from '../utils/errors';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/** Errors raised by express.json() carry an HTTP status and a `type`. */
function isBodyParserError(err: unknown): err is { status: number; type: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number' &&
    typeof (err as { type?: unknown }).type === 'string'
  );
}

/**
 * Central error handler: maps known errors to their status and code, and turns
 * everything else into a generic 500. Stack traces and internal messages are
 * logged, never sent to the client.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = typeof req.id === 'string' ? req.id : undefined;
  let status: number;
  let body: ErrorBody;

  if (err instanceof AppError) {
    status = err.statusCode;
    body = { error: { code: err.code, message: err.message, details: err.details, requestId } };
  } else if (isBodyParserError(err) && err.status < 500) {
    status = err.status;
    const code = err.type === 'entity.parse.failed' ? 'INVALID_JSON' : 'BAD_REQUEST';
    body = { error: { code, message: 'Request body could not be processed', requestId } };
  } else {
    status = 500;
    body = { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } };
  }

  if (status >= 500) {
    req.log.error({ err, status }, 'Request failed');
  } else {
    req.log.warn(
      { code: body.error.code, status, message: body.error.message },
      'Request rejected',
    );
  }

  res.status(status).json(body);
};
