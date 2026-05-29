/**
 * Structured-log bridge for @allstak/next.
 *
 * Forwards application logs to `/ingest/v1/logs` through the active client.
 * Three sources feed the same pipeline, all individually toggleable and
 * fully fail-open:
 *
 *   1. `logToAllStak(level, message, meta)` — the low-level primitive.
 *   2. `pinoAllStakTransport()` / `createPinoTransport()` — a pino transport
 *      (a `write(line)` stream) you add to pino's destinations.
 *   3. `allstakWinstonTransport()` — a winston `Transport` subclass instance.
 *   4. `installConsoleLogBridge()` — wraps `console.{debug,info,warn,error}`
 *      so existing `console.*` calls become structured logs. Default ON via
 *      `registerAllStak` (server) and `installGlobalErrorHandlers` (browser).
 *
 * Promotion rule: an `error`/`fatal` log whose payload carries an `Error` (a
 * thrown object) is ALSO promoted to `captureException` so it shows up as an
 * error event, not just a log line. A bare `error` string log stays a log only.
 */

import { getClient, type LogLevel } from './client';
import { scopeManager } from './scope';

export interface LogToAllStakOptions {
  /** Extra structured metadata merged into the log's `metadata` bag. */
  meta?: Record<string, unknown>;
  /** A thrown object to promote to captureException at error/fatal level. */
  error?: unknown;
}

const LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
const PROMOTE_LEVELS: ReadonlySet<string> = new Set(['error', 'fatal']);
const BREADCRUMB_LEVELS: ReadonlySet<string> = new Set(['warn', 'error', 'fatal']);

/**
 * Forward one structured log line to `/ingest/v1/logs` through the active
 * client. Adds a `log` breadcrumb on warn/error/fatal so the next captured
 * event carries recent log context. Promotes error/fatal logs that carry an
 * `Error` to `captureException`. Safe no-op when no client is registered.
 * Fully fail-open — never throws into the caller.
 */
export function logToAllStak(level: LogLevel, message: string, options: LogToAllStakOptions = {}): void {
  try {
    const client = getClient();
    if (!client || client.isDestroyed()) return;
    const normalizedLevel = normalizeLevel(level);
    const meta = options.meta;

    // Auto-breadcrumb on warn/error/fatal so subsequent events have log context.
    if (BREADCRUMB_LEVELS.has(normalizedLevel)) {
      try {
        scopeManager.getCurrentScope().addBreadcrumb({
          type: 'console',
          category: 'console',
          level: normalizedLevel,
          message,
          data: meta,
        });
      } catch {
        // fail-open
      }
    }

    void client
      .captureLog({
        level: normalizedLevel,
        message,
        service: typeof meta?.service === 'string' ? meta.service : 'nextjs',
        traceId: typeof meta?.traceId === 'string' ? meta.traceId : undefined,
        spanId: typeof meta?.spanId === 'string' ? meta.spanId : undefined,
        requestId: typeof meta?.requestId === 'string' ? meta.requestId : undefined,
        userId: resolveUserId(meta),
        errorId: typeof meta?.errorId === 'string' ? meta.errorId : undefined,
        metadata: meta,
      })
      .catch(() => undefined);

    // Promote error/fatal logs that carry a real Error object to an event.
    if (PROMOTE_LEVELS.has(normalizedLevel)) {
      const err = extractError(options.error, meta);
      if (err) {
        void client
          .captureException(err, { mechanism: 'log', logLevel: normalizedLevel })
          .catch(() => undefined);
      }
    }
  } catch {
    // Logging must never crash the host app.
  }
}

function normalizeLevel(level: string): LogLevel {
  const lower = String(level || '').toLowerCase();
  if (lower === 'warning') return 'warn';
  if (lower === 'trace') return 'debug';
  if (lower === 'critical') return 'fatal';
  return (LEVELS.has(lower) ? lower : 'info') as LogLevel;
}

function resolveUserId(meta: Record<string, unknown> | undefined): string | undefined {
  if (typeof meta?.userId === 'string') return meta.userId;
  try {
    const user = scopeManager.getCurrentScope().user;
    return typeof user?.id === 'string' ? user.id : undefined;
  } catch {
    return undefined;
  }
}

/** Pull an Error out of the explicit option or a metadata `err`/`error` field. */
function extractError(explicit: unknown, meta: Record<string, unknown> | undefined): Error | null {
  if (explicit instanceof Error) return explicit;
  const candidate = meta?.error ?? meta?.err;
  if (candidate instanceof Error) return candidate;
  return null;
}

// ── pino transport ───────────────────────────────────────────────────────────

/**
 * A pino-compatible destination stream: pino writes one NDJSON line per log,
 * which we parse and forward. Use it as a `pino.transport`-style destination
 * or directly: `pino(allstakPinoStream())`.
 *
 * ```ts
 * import pino from 'pino';
 * import { allstakPinoStream } from '@allstak/next';
 * const logger = pino({ level: 'info' }, allstakPinoStream());
 * ```
 */
export interface PinoDestinationStream {
  write(line: string): void;
}

const PINO_LEVELS: Record<number, LogLevel> = {
  10: 'debug', // trace
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export function allstakPinoStream(): PinoDestinationStream {
  return {
    write(line: string): void {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const level = typeof obj.level === 'number'
          ? PINO_LEVELS[obj.level] ?? 'info'
          : normalizeLevel(String(obj.level ?? 'info'));
        const message = typeof obj.msg === 'string' ? obj.msg : typeof obj.message === 'string' ? obj.message : '';
        // Strip pino's structural keys from the forwarded metadata.
        const { level: _l, msg: _m, time: _t, pid: _p, hostname: _h, ...meta } = obj;
        logToAllStak(level, message, { meta, error: meta.err ?? meta.error });
      } catch {
        // Non-JSON line or parse failure — forward as a plain info log.
        try {
          logToAllStak('info', line);
        } catch {
          // fail-open
        }
      }
    },
  };
}

// ── winston transport ─────────────────────────────────────────────────────────

/**
 * Build a winston `Transport` instance that forwards to AllStak. winston is an
 * optional peer; the base `Transport` class is resolved lazily so importing
 * this module never requires winston. Returns null when winston isn't
 * installed.
 *
 * ```ts
 * import winston from 'winston';
 * import { allstakWinstonTransport } from '@allstak/next';
 * const t = allstakWinstonTransport();
 * const logger = winston.createLogger({ transports: t ? [t] : [] });
 * ```
 */
export function allstakWinstonTransport(): unknown | null {
  try {
    const TransportBase = resolveWinstonTransport();
    if (!TransportBase) return null;
    class AllStakWinstonTransport extends (TransportBase as { new (opts?: unknown): { emit: (e: string, ...a: unknown[]) => void } }) {
      log(info: Record<string, unknown>, callback?: () => void): void {
        try {
          const level = normalizeLevel(String(info.level ?? 'info'));
          const message = typeof info.message === 'string' ? info.message : String(info.message ?? '');
          const { level: _l, message: _m, ...meta } = info;
          logToAllStak(level, message, { meta, error: meta.error ?? meta.err });
        } catch {
          // fail-open
        }
        // Winston expects the transport to emit 'logged' and invoke the callback.
        try {
          this.emit('logged', info);
        } catch {
          // fail-open
        }
        if (typeof callback === 'function') callback();
      }
    }
    return new AllStakWinstonTransport();
  } catch {
    return null;
  }
}

interface WinstonTransportModule {
  default?: unknown;
}

function resolveWinstonTransport(): unknown | null {
  const req = (globalThis as { require?: (id: string) => unknown }).require
    ?? (typeof require !== 'undefined' ? (require as unknown as (id: string) => unknown) : undefined);
  if (!req) return null;
  try {
    const mod = req('winston-transport') as WinstonTransportModule | undefined;
    return (mod && (mod.default ?? mod)) ?? null;
  } catch {
    /* try winston.Transport */
  }
  try {
    const winston = req('winston') as { Transport?: unknown } | undefined;
    return winston?.Transport ?? null;
  } catch {
    return null;
  }
}

// ── console bridge ─────────────────────────────────────────────────────────────

const CONSOLE_METHODS = ['debug', 'info', 'warn', 'error'] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];
const CONSOLE_LEVEL: Record<ConsoleMethod, LogLevel> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

interface ConsoleBridgeState {
  console: Record<string, unknown>;
  originals: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>>;
}

let consoleBridge: ConsoleBridgeState | null = null;

export interface ConsoleLogBridgeOptions {
  /** Console methods to bridge. Default: debug, info, warn, error. */
  methods?: ConsoleMethod[];
  /** Minimum level forwarded. Default 'info' (so `console.debug` is dropped). */
  minLevel?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

/**
 * Wrap `console.{debug,info,warn,error}` so each call ALSO ships a structured
 * log to `/ingest/v1/logs`. The original console method is always called first
 * (host output is preserved exactly). `console.error` carrying an `Error`
 * object is promoted to `captureException`. Idempotent and fully fail-open.
 * Returns a teardown that restores the original methods.
 */
export function installConsoleLogBridge(options: ConsoleLogBridgeOptions = {}): () => void {
  const consoleObj = (globalThis as unknown as { console?: Record<string, unknown> }).console;
  if (!consoleObj) return () => {};
  if (consoleBridge) return () => uninstallConsoleLogBridge();

  const methods = options.methods ?? [...CONSOLE_METHODS];
  const minOrder = LEVEL_ORDER[options.minLevel ?? 'info'];
  const originals: ConsoleBridgeState['originals'] = {};

  for (const method of methods) {
    const original = consoleObj[method];
    if (typeof original !== 'function') continue;
    const orig = original as (...args: unknown[]) => void;
    originals[method] = orig;
    const level = CONSOLE_LEVEL[method];

    consoleObj[method] = function patchedConsole(this: unknown, ...args: unknown[]): void {
      // Always preserve the host's console output first.
      try {
        orig.apply(this, args);
      } catch {
        // fail-open
      }
      if (LEVEL_ORDER[level] < minOrder) return;
      try {
        const { message, error } = formatConsoleArgs(args);
        if (message) logToAllStak(level, message, { error });
      } catch {
        // logging must never break console
      }
    } as (...args: unknown[]) => void;
  }

  consoleBridge = { console: consoleObj, originals };
  return () => uninstallConsoleLogBridge();
}

/** Restore the original console methods. Idempotent and fail-open. */
export function uninstallConsoleLogBridge(): void {
  if (!consoleBridge) return;
  try {
    for (const [method, original] of Object.entries(consoleBridge.originals)) {
      if (original) consoleBridge.console[method] = original;
    }
  } catch {
    // fail-open
  } finally {
    consoleBridge = null;
  }
}

/** Whether the console log bridge is currently installed by us. */
export function isConsoleLogBridgeInstalled(): boolean {
  return consoleBridge !== null;
}

/** Build a single message string + first Error from console args. */
function formatConsoleArgs(args: unknown[]): { message: string; error?: Error } {
  let error: Error | undefined;
  const parts: string[] = [];
  for (const arg of args) {
    if (arg instanceof Error) {
      if (!error) error = arg;
      parts.push(arg.message || arg.name);
    } else if (typeof arg === 'string') {
      parts.push(arg);
    } else {
      parts.push(safeStringify(arg));
    }
  }
  return { message: parts.join(' ').trim(), error };
}

function safeStringify(value: unknown): string {
  try {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  } catch {
    return '[object]';
  }
}
