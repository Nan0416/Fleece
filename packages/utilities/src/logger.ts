import { getenv } from './env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) {
    return '';
  }
  if (meta instanceof Error) {
    return ` ${meta.stack ?? `${meta.name}: ${meta.message}`}`;
  }
  if (typeof meta === 'string') {
    return ` ${meta}`;
  }
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' [unserializable meta]';
  }
}

class ConsoleLogger implements Logger {
  constructor(private readonly name: string) {}

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[LoggerFactory.level]) {
      return;
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.name}] ${message}${formatMeta(meta)}`;
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(message: string, meta?: unknown): void {
    this.write('debug', message, meta);
  }
  info(message: string, meta?: unknown): void {
    this.write('info', message, meta);
  }
  warn(message: string, meta?: unknown): void {
    this.write('warn', message, meta);
  }
  error(message: string, meta?: unknown): void {
    this.write('error', message, meta);
  }
}

function resolveInitialLevel(): LogLevel {
  // Resolved through `getenv` rather than `process.env` directly, because this runs
  // in a static initialiser: the browser bundle would throw `process is not defined`
  // at import time, before any UI code gets a chance to run.
  const raw = getenv('FLEECE_LOG_LEVEL', 'info');
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

/**
 * Loggers are named after the class or module that owns them, which is what makes
 * the output greppable when the API, injector and corporate-action job are all writing at once.
 */
export class LoggerFactory {
  static level: LogLevel = resolveInitialLevel();
  private static readonly loggers = new Map<string, Logger>();

  static getLogger(name: string): Logger {
    const existing = LoggerFactory.loggers.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const logger = new ConsoleLogger(name);
    LoggerFactory.loggers.set(name, logger);
    return logger;
  }

  static setLevel(level: LogLevel): void {
    LoggerFactory.level = level;
  }
}
