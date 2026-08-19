import pino from 'pino';

// Pretty-print only in local development. In test / production we emit plain
// JSON so we don't spin up the pino-pretty worker thread (keeps test runs and
// batch runs clean, and keeps stdout parseable when the CLI pipes JSON).
const usePretty = (process.env.NODE_ENV ?? 'development') === 'development';

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(usePretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname'},
          },
        }
      : {}),
  },
  // Always log to stderr: stdout is reserved for the triage JSON payload that
  // `core.py` reads back over the subprocess bridge.
  pino.destination(2)
);

export type Logger = typeof logger;
