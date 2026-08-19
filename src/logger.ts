/**
 * Minimal structured logger — one JSON object per line on stdout/stderr.
 *
 * Hand-rolled rather than a dependency: this repo ships publicly and every
 * dependency is a supply-chain surface a self-hoster inherits. A logger is
 * forty lines; pino is not worth the audit.
 *
 * THE DISCIPLINE MATTERS MORE THAN THE IMPLEMENTATION. Plate photographs pass
 * THROUGH this service on their way to somebody else's model, so for the whole
 * lifetime of a request the bytes are sitting in our process. "No request body
 * is ever logged" is the product, not a nicety. So:
 *
 *  - `LogFields` accepts primitives only. There is no `unknown`/`object` branch,
 *    which means you cannot pass a request, a body, a Buffer or a parsed
 *    content part without the compiler stopping you.
 *  - Never log a field derived from a proxied body (no base64, no data URI, no
 *    decoded buffer, not even a prefix of one). Byte COUNTS, member ids, model
 *    ids and status codes are fine and are what the call sites use.
 *  - Never log the upstream provider key, or any prefix of it. It is one shared
 *    secret for the whole household; a log line that leaks it is a bill.
 *  - Free-text messages are fixed strings. Anything that could carry a payload
 *    (an error message from a dependency, an upstream error body) goes through
 *    `scrub.ts#scrubPayloads` first.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 } satisfies Record<LogLevel, number>;

/** Primitives only — see the module header. Widening this type weakens the privacy guarantee. */
export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Narrows an already-decoded string. Takes `string` rather than `unknown` on
 * purpose: the callers are config-shaped, where a schema has already
 * established that the value is a string, and the remaining question is
 * whether it names a level.
 */
export function isLogLevel(value: string): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

export function createLogger(options: { component: string; level: LogLevel }): Logger {
  const threshold = LEVEL_ORDER[options.level];

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: options.component,
      message,
      ...fields,
    });
    if (level === 'error' || level === 'warn') {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

/** Discards everything — for optional-logger call sites. */
export function createSilentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

export interface CapturedLogLine {
  level: LogLevel;
  message: string;
  fields: LogFields;
}

/** What `createCapturingLogger` hands back: the logger, plus the lines it has recorded. */
export interface CapturingLogger {
  logger: Logger;
  lines: CapturedLogLine[];
}

/**
 * A logger that records instead of writing. Exported from `src/` rather than
 * hidden in `tests/` because it is what the privacy test asserts against: the
 * test drives a real request through the real app and then proves no request
 * body reached ANY log line. A capture helper that only existed in the test
 * tree would be one more thing that could drift from the real logger's shape.
 */
export function createCapturingLogger(): CapturingLogger {
  const lines: CapturedLogLine[] = [];
  const record =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields: fields ?? {} });
    };
  return {
    lines,
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  };
}
