import { config } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: Level, message: string, meta?: unknown): void {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta !== undefined ? { meta } : {}),
  };
  (level === 'error' ? console.error : console.log)(JSON.stringify(entry));
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
  info:  (msg: string, meta?: unknown) => log('info',  msg, meta),
  warn:  (msg: string, meta?: unknown) => log('warn',  msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
};
