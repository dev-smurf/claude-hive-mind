/**
 * Minimal structured logger.
 *
 * Writes JSON-formatted log lines to stderr (not stdout) so that
 * tooling, log aggregators, and stdio-based MCP transports never
 * confuse log output with protocol messages.
 *
 * Levels: debug | info | warn | error.
 * Configurable via CHM_LOG_LEVEL.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: Level = 'info';

export function setLogLevel(level: string): void {
  const lower = level.toLowerCase();
  if (lower === 'debug' || lower === 'info' || lower === 'warn' || lower === 'error') {
    currentLevel = lower;
  }
}

function shouldLog(level: Level): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[currentLevel];
}

function emit(level: Level, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
  };
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      if (k === 'ts' || k === 'level' || k === 'scope' || k === 'msg') continue;
      line[k] = v;
    }
  }
  // Always stderr — never pollute stdout (used by stdio MCP transport).
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug(scope: string, message: string, meta?: Record<string, unknown>): void {
    emit('debug', scope, message, meta);
  },
  info(scope: string, message: string, meta?: Record<string, unknown>): void {
    emit('info', scope, message, meta);
  },
  warn(scope: string, message: string, meta?: Record<string, unknown>): void {
    emit('warn', scope, message, meta);
  },
  error(scope: string, message: string, meta?: Record<string, unknown>): void {
    emit('error', scope, message, meta);
  },
};
