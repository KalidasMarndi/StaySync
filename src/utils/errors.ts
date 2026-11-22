/**
 * Application errors carry the HTTP status and a stable machine-readable code.
 * The error middleware turns them into JSON responses; anything that is not an
 * AppError is treated as an unexpected 500 and its details are never exposed.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}

/** Every supplier failed, so no hotel data could be aggregated. */
export class SupplierUnavailableError extends AppError {
  constructor(message: string, details?: unknown, options?: { cause?: unknown }) {
    super(502, 'SUPPLIERS_UNAVAILABLE', message, details, options);
  }
}

/** A required infrastructure dependency (Redis, Temporal) cannot be reached. */
export class DependencyUnavailableError extends AppError {
  constructor(
    readonly dependency: 'redis' | 'temporal',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(503, 'DEPENDENCY_UNAVAILABLE', message, { dependency }, options);
  }
}

/** The Temporal workflow failed for a reason other than supplier unavailability. */
export class WorkflowExecutionError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(500, 'WORKFLOW_FAILED', message, undefined, options);
  }
}

/** The workflow did not finish within its execution timeout (e.g. no worker is running). */
export class WorkflowTimeoutError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(504, 'WORKFLOW_TIMEOUT', message, undefined, options);
  }
}

/** Redis answered, but the operation failed (e.g. wrong key type, script error). */
export class CacheOperationError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(500, 'CACHE_ERROR', message, undefined, options);
  }
}
