/**
 * Pino-backed structured logger. Pretty-prints in development, emits JSON in
 * production (so log aggregators can parse it).
 */

import pino, { type Logger } from 'pino';
import { config } from './config/env.js';

const isDev = config.NODE_ENV !== 'production';

export const logger: Logger = pino({
  level: config.LOG_LEVEL,
  base: { app: 'market-pulse-ai' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname,app',
          },
        },
      }
    : {}),
});

/** Create a child logger with extra static context (component, symbol, etc.). */
export function child(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
