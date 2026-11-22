import type { z } from 'zod';
import { ValidationError } from './errors';

/**
 * Parses untrusted input (query string, body, params) against a zod schema.
 * Returns typed data, or throws a ValidationError (HTTP 400) that lists each
 * invalid field.
 */
export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  input: unknown,
  message = 'Invalid request',
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      message,
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || undefined,
        message: issue.message,
      })),
    );
  }
  return result.data;
}
