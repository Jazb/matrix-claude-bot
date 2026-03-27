/**
 * Minimal structured logger with level filtering.
 *
 * Logs are written to stderr so stdout stays clean for piping.
 * Format: [LEVEL] [component] message
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: string): void {
  if (level in LEVELS) {
    currentLevel = level as LogLevel;
  }
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

export function createLogger(component: string) {
  return {
    debug(msg: string, ...args: unknown[]) {
      if (shouldLog("debug")) console.error(`${timestamp()} [DEBUG] [${component}]`, msg, ...args);
    },
    info(msg: string, ...args: unknown[]) {
      if (shouldLog("info")) console.error(`${timestamp()} [INFO] [${component}]`, msg, ...args);
    },
    warn(msg: string, ...args: unknown[]) {
      if (shouldLog("warn")) console.error(`${timestamp()} [WARN] [${component}]`, msg, ...args);
    },
    error(msg: string, ...args: unknown[]) {
      if (shouldLog("error")) console.error(`${timestamp()} [ERROR] [${component}]`, msg, ...args);
    },
  };
}
