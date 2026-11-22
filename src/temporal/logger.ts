import type { LogLevel, LogMetadata, Logger } from '@temporalio/worker';
import type { Logger as PinoLogger } from '../utils/logger';

const LEVEL_MAP = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const satisfies Record<LogLevel, string>;

/**
 * Sends Temporal SDK logs (worker internals, workflow `log`, activity `log`)
 * to our Pino logger, so the worker writes one consistent JSON log stream.
 * Temporal attaches context such as workflowId, runId, activityType and attempt.
 */
export class PinoTemporalLogger implements Logger {
  constructor(private readonly pino: PinoLogger) {}

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    // Pino serializes errors under `err`; Temporal puts them under `error`.
    const { error, ...rest } = meta ?? {};
    const fields = error === undefined ? rest : { ...rest, err: error };
    this.pino[LEVEL_MAP[level]](fields, message);
  }

  trace(message: string, meta?: LogMetadata): void {
    this.log('TRACE', message, meta);
  }
  debug(message: string, meta?: LogMetadata): void {
    this.log('DEBUG', message, meta);
  }
  info(message: string, meta?: LogMetadata): void {
    this.log('INFO', message, meta);
  }
  warn(message: string, meta?: LogMetadata): void {
    this.log('WARN', message, meta);
  }
  error(message: string, meta?: LogMetadata): void {
    this.log('ERROR', message, meta);
  }
}
