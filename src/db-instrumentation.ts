/**
 * Database query auto-instrumentation for the Next.js server runtime.
 *
 * Opt-in-by-default driver wrappers, auto-wired from `registerAllStak` when the
 * corresponding module RESOLVES in the host app:
 *   - `pg`     — monkey-patch `Client.prototype.query` (covers Pool + Client +
 *                prepared/named queries + transactions, since Pool delegates to
 *                Client.prototype.query).
 *   - Prisma   — `prisma.$on('query', …)` (Prisma's stable observability hook).
 *   - Drizzle  — a `logger` hook the host passes to `drizzle({ logger })`.
 *
 * Each query is NORMALIZED (literals masked to `?`) before it leaves the SDK,
 * so bound values never reach the wire — only the parameterized shape, its
 * hash, timing and status. Emitted (batched) to `/ingest/v1/db` through the
 * client's `captureDbQuery`, which runs the standard scrub chokepoint as a
 * second line of defence.
 *
 * Everything is fully fail-open: a missing driver, a patch failure, or a
 * capture error never throws into the host query chain. Node-server only —
 * a no-op on the edge/browser bundle.
 */

import { getClient } from './client';
import {
  detectQueryType,
  hashQuery,
  isNodeServerRuntime,
  isOwnedByOrm,
  markOwnedByOrm,
  normalizeQuery,
  tryRequire,
} from './db-shared';

export interface DbInstrumentationOptions {
  /** Auto-wire the `pg` driver wrapper when `pg` resolves. Default true. */
  pg?: boolean;
  /** Auto-wire the Prisma `$on('query')` hook on the passed client. Default true. */
  prisma?: boolean;
  /** Provide the Drizzle `logger` hook. Default true (the hook is exported regardless). */
  drizzle?: boolean;
}

/** Tracks which integrations have already patched, so installs are idempotent. */
let pgPatched = false;

/**
 * Auto-wire every database integration that can be wired WITHOUT a live client
 * instance — currently the `pg` driver, which is patched on its prototype.
 * Prisma and Drizzle need a host-held instance, so they are wired by the
 * explicit `instrumentPrisma()` / `allstakDrizzleLogger()` exports.
 *
 * Called from `registerAllStak` by default. Individually toggleable and fully
 * fail-open. No-op outside the Node server runtime.
 */
export function installDbInstrumentation(options: DbInstrumentationOptions = {}): void {
  if (!isNodeServerRuntime()) return;
  if (options.pg !== false) {
    try {
      instrumentPgDriver();
    } catch {
      // fail-open
    }
  }
}

interface PgModule {
  Client?: { prototype?: { query?: (...args: unknown[]) => unknown } };
}

/**
 * Monkey-patch `pg.Client.prototype.query`. Idempotent (a second call is a
 * no-op). Returns true when the patch was applied (or already in place), false
 * when `pg` is not installed. Fail-open.
 */
export function instrumentPgDriver(): boolean {
  if (pgPatched) return true;
  const pg = tryRequire<PgModule>('pg');
  const proto = pg?.Client?.prototype;
  if (!proto || typeof proto.query !== 'function') return false;

  const originalQuery = proto.query;

  proto.query = function patchedPgQuery(this: unknown, ...args: unknown[]): unknown {
    // Skip connections already owned by an ORM (Prisma) to avoid double-capture.
    if (isOwnedByOrm(this)) {
      return originalQuery.apply(this, args);
    }

    const startTime = Date.now();
    const firstArg = args[0];
    const queryText =
      typeof firstArg === 'string'
        ? firstArg
        : (firstArg as { text?: string } | undefined)?.text ?? '';
    const normalized = normalizeQuery(queryText);
    const databaseName = (this as { database?: string }).database ?? '';

    const record = (status: 'success' | 'error', err?: { message?: string }, rowsAffected = -1): void => {
      emitDbQuery({
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: detectQueryType(queryText),
        durationMs: Math.max(0, Date.now() - startTime),
        timestampMillis: startTime,
        status,
        errorMessage: err?.message?.slice(0, 500),
        databaseName,
        databaseType: 'postgresql',
        rowsAffected,
      });
    };

    // Callback signature: pg's Client.query returns undefined, so we wrap the cb.
    let cbIndex = -1;
    for (let i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === 'function') {
        cbIndex = i;
        break;
      }
    }
    if (cbIndex >= 0) {
      const originalCb = args[cbIndex] as (err: Error | null, res?: { rowCount?: number }) => void;
      args[cbIndex] = function wrappedCb(this: unknown, err: Error | null, res?: { rowCount?: number }) {
        record(err ? 'error' : 'success', err ?? undefined, res?.rowCount ?? -1);
        return originalCb.call(this, err, res as never);
      };
      try {
        return originalQuery.apply(this, args);
      } catch (err) {
        record('error', err as Error);
        throw err;
      }
    }

    // Promise signature: no callback → returns a Promise.
    try {
      const result = originalQuery.apply(this, args);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<{ rowCount?: number }>).then(
          (res) => {
            record('success', undefined, res?.rowCount ?? -1);
            return res;
          },
          (err: Error) => {
            record('error', err);
            throw err;
          },
        );
      }
      return result;
    } catch (err) {
      record('error', err as Error);
      throw err;
    }
  };

  pgPatched = true;
  return true;
}

interface PrismaClientLike {
  $on?: (event: 'query', cb: (e: PrismaQueryEvent) => void) => void;
  _engine?: unknown;
}

interface PrismaQueryEvent {
  timestamp?: Date | string | number;
  query: string;
  params?: string;
  duration?: number; // milliseconds
  target?: string;
}

export interface PrismaInstrumentationOptions {
  databaseType?: 'postgresql' | 'mysql' | 'sqlite' | 'mongodb' | 'mssql';
}

/**
 * Wire Prisma query capture via `prisma.$on('query', …)`. The host MUST have
 * constructed the client with query event logging enabled:
 *
 * ```ts
 * const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
 * instrumentPrisma(prisma);
 * ```
 *
 * Marks the engine as ORM-owned so the `pg` driver wrapper skips Prisma's own
 * connections. Returns true when the hook was attached. Fail-open.
 */
export function instrumentPrisma(prisma: PrismaClientLike, options: PrismaInstrumentationOptions = {}): boolean {
  if (!prisma || typeof prisma.$on !== 'function') return false;
  try {
    prisma.$on('query', (e: PrismaQueryEvent) => {
      const normalized = normalizeQuery(e.query);
      emitDbQuery({
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: detectQueryType(e.query),
        durationMs: Math.max(0, Math.round(e.duration ?? 0)),
        timestampMillis: resolveTimestamp(e.timestamp),
        status: 'success',
        databaseName: '',
        databaseType: options.databaseType ?? 'postgresql',
        rowsAffected: -1,
      });
    });
    if (prisma._engine) markOwnedByOrm(prisma._engine);
    return true;
  } catch {
    return false;
  }
}

export interface DrizzleLoggerOptions {
  databaseType?: 'postgresql' | 'mysql' | 'sqlite' | 'mongodb' | 'mssql';
}

/** Drizzle's `Logger` interface: a single `logQuery(query, params)` method. */
export interface DrizzleLogger {
  logQuery(query: string, params: unknown[]): void;
}

/**
 * Build a Drizzle `logger` you pass to `drizzle(client, { logger })`. Drizzle
 * calls `logQuery(query, params)` for every statement; we normalize and emit
 * it to `/ingest/v1/db`. The bound `params` are never forwarded — only the
 * masked query shape. Fully fail-open.
 *
 * ```ts
 * import { drizzle } from 'drizzle-orm/node-postgres';
 * import { allstakDrizzleLogger } from '@allstak/next';
 * const db = drizzle(pool, { logger: allstakDrizzleLogger() });
 * ```
 */
export function allstakDrizzleLogger(options: DrizzleLoggerOptions = {}): DrizzleLogger {
  return {
    logQuery(query: string, _params: unknown[]): void {
      try {
        const normalized = normalizeQuery(query);
        emitDbQuery({
          normalizedQuery: normalized,
          queryHash: hashQuery(normalized),
          queryType: detectQueryType(query),
          durationMs: -1, // Drizzle's logger fires pre-execution; no duration available.
          timestampMillis: Date.now(),
          status: 'success',
          databaseName: '',
          databaseType: options.databaseType ?? 'postgresql',
          rowsAffected: -1,
        });
      } catch {
        // never break the host query chain
      }
    },
  };
}

/** @internal item shape before client enrichment (env/release/trace). */
interface RawDbQuery {
  normalizedQuery: string;
  queryHash: string;
  queryType: string;
  durationMs: number;
  timestampMillis: number;
  status: string;
  errorMessage?: string;
  databaseName?: string;
  databaseType?: string;
  rowsAffected?: number;
}

/** Route a normalized query through the active client. Fully fail-open. */
function emitDbQuery(item: RawDbQuery): void {
  try {
    const client = getClient();
    if (!client || client.isDestroyed()) return;
    void client.captureDbQuery(item).catch(() => undefined);
  } catch {
    // Telemetry must never affect the host query chain.
  }
}

function resolveTimestamp(value: PrismaQueryEvent['timestamp']): number {
  if (value == null) return Date.now();
  if (typeof value === 'number') return value;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

/** @internal test seam: undo the `pg` prototype patch flag (not the patch itself). */
export function _resetDbInstrumentationForTest(): void {
  pgPatched = false;
}
