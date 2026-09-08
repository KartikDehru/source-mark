import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as Level)] ?? LEVELS.info;

function emit(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] > threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (extra === undefined) console.log(line);
  else console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
}

export const log = {
  error: (m: string, e?: unknown) => emit('error', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  debug: (m: string, e?: unknown) => emit('debug', m, e),
};
