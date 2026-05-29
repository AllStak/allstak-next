/**
 * Shared, side-effect-free helpers for the database auto-instrumentation under
 * `src/db-instrumentation.ts`. Kept tiny so they can be imported from any Next
 * runtime (node-server / edge / browser bundle) without pulling a native
 * dependency: the actual `pg`/Prisma/Drizzle objects are resolved lazily at
 * call time, never at import time.
 *
 * The normalization/hash/type helpers mirror the canonical AllStak SDK
 * behaviour so a query captured here aggregates identically to one captured by
 * a sibling SDK on the same backend.
 */

/**
 * Normalize a SQL statement for dedup AND safe storage. The masking strips
 * every bound/literal VALUE so nothing user-supplied ever reaches the wire —
 * only the parameterized query shape does:
 *   - strip block / line comments
 *   - mask single-quoted string literals (incl. the `''` escape) → `?`
 *   - mask dollar-quoted string literals (`$tag$...$tag$`, Postgres) → `?`
 *   - mask numeric literals → `?`
 *   - collapse whitespace
 *
 * Double-quoted content is intentionally preserved: in PostgreSQL / ANSI MySQL
 * it is a quoted IDENTIFIER (`"public"."Task"`), not a string literal — masking
 * it would reduce every ORM query to a useless shape.
 */
export function normalizeQuery(sql: string): string {
  if (!sql) return '';
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // /* block comments */
    .replace(/--[^\n]*/g, ' ') // -- line comments
    .replace(/'(?:''|[^'])*'/g, '?') // single-quoted literals (incl. '' escape)
    .replace(/\$[a-zA-Z0-9_]*\$[\s\S]*?\$[a-zA-Z0-9_]*\$/g, '?') // dollar-quoted
    .replace(/\b\d+(?:\.\d+)?\b/g, '?') // numeric literals
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable, dependency-free 32-bit string hash (base-36) of a normalized query. */
export function hashQuery(normalized: string): string {
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + c;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** First keyword → coarse query type (SELECT/INSERT/UPDATE/DELETE/BEGIN/…/OTHER). */
export function detectQueryType(sql: string): string {
  const first = sql.trim().split(/\s+/)[0]?.toUpperCase();
  if (!first) return 'OTHER';
  if (['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'BEGIN', 'COMMIT', 'ROLLBACK'].includes(first)) {
    return first;
  }
  return 'OTHER';
}

/**
 * ORM dedup marker. When an ORM integration (Prisma) instruments a client we
 * tag the underlying driver connection/engine so a `pg` driver-level wrapper
 * skips anything already owned by the ORM (avoiding double-capture).
 */
export const DEDUPE_SYMBOL = Symbol.for('allstak.next.db.ownedByOrm');

export function markOwnedByOrm(target: unknown): void {
  try {
    if (target && typeof target === 'object') {
      (target as Record<symbol, boolean>)[DEDUPE_SYMBOL] = true;
    }
  } catch {
    /* fail-open */
  }
}

export function isOwnedByOrm(target: unknown): boolean {
  try {
    if (target && typeof target === 'object') {
      return (target as Record<symbol, boolean>)[DEDUPE_SYMBOL] === true;
    }
  } catch {
    /* fail-open */
  }
  return false;
}

/** True only on the Node server runtime (not edge, not the browser bundle). */
export function isNodeServerRuntime(): boolean {
  const proc = (globalThis as {
    process?: { versions?: { node?: string }; env?: Record<string, string | undefined> };
  }).process;
  return !!proc?.versions?.node && proc.env?.NEXT_RUNTIME !== 'edge';
}

/**
 * Resolve an OPTIONAL peer dependency (e.g. `pg`) from the HOST app's
 * node_modules, not the SDK's. The SDK lives under
 * `<host>/node_modules/@allstak/next/dist`; a plain `require('pg')` resolves
 * relative to the SDK dir and fails because `pg` is the host's dep. We try
 * `process.cwd()` and the main module's resolution paths first, then fall
 * back. Returns null when the dep isn't installed — expected, and the
 * corresponding integration simply stays off. Never throws.
 */
export function tryRequire<T = unknown>(name: string): T | null {
  // Indirect lookup so bundlers don't try to statically resolve the optional
  // peer dep and so this is a no-op when `require` is unavailable (edge/browser).
  const req = (globalThis as {
    require?: NodeRequire;
    process?: { mainModule?: { paths?: string[] }; cwd?: () => string };
  }).require
    ?? (typeof require !== 'undefined' ? (require as unknown as NodeRequire) : undefined);
  if (!req || typeof req !== 'function') return null;

  const bases: string[] = [];
  try {
    const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.();
    if (cwd) bases.push(cwd);
  } catch {
    /* ignore */
  }
  try {
    const mainPaths = (req as unknown as { main?: { paths?: string[] } }).main?.paths;
    if (Array.isArray(mainPaths)) bases.push(...mainPaths);
  } catch {
    /* ignore */
  }

  for (const base of bases) {
    try {
      const resolved = (req as unknown as { resolve: (id: string, opts?: { paths?: string[] }) => string })
        .resolve(name, { paths: [base] });
      return req(resolved) as T;
    } catch {
      /* try next base */
    }
  }
  try {
    return req(name) as T;
  } catch {
    return null;
  }
}

/** Minimal NodeRequire shape (no `@types/node` require typing assumed). */
interface NodeRequire {
  (id: string): unknown;
  resolve(id: string, options?: { paths?: string[] }): string;
}
