import pino from 'pino';

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
type LogLevel = (typeof LEVELS)[number];

function resolveLevel(): LogLevel {
  const requested = process.env.LOG_LEVEL;
  if (requested && (LEVELS as readonly string[]).includes(requested)) {
    return requested as LogLevel;
  }
  return process.env.NODE_ENV === 'test' ? 'silent' : 'info';
}

/**
 * pino-pretty is a dev dependency, so it is absent from the production Docker image —
 * even when that image runs with NODE_ENV=development (docker-compose.dev.yml).
 * Use it only if it is actually installed; otherwise log JSON instead of crashing.
 */
function prettyLogsAvailable(): boolean {
  if (process.env.NODE_ENV !== 'development') return false;
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Structured JSON logger shared by the API and the Temporal worker.
 * It is configured straight from process.env (not AppConfig) so that
 * configuration errors themselves can be logged.
 * Human-readable output only in local development.
 */
export const logger = pino({
  level: resolveLevel(),
  base: { service: 'staysync' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password'],
    censor: '[REDACTED]',
  },
  ...(prettyLogsAvailable() && {
    transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } },
  }),
});

export type Logger = typeof logger;
