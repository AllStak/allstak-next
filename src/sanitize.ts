// AllStak Next.js SDK sanitizer.
//
// Recursively scrubs sensitive keys across the full event surface
// (user, extras, metadata, breadcrumbs.data, contexts, request, response).
//
// Conforms to the canonical AllStak SDK denylist defined in
// docs/standards/sdk-platform-standards.md.
//
// Semantics:
// - Case-insensitive substring match on object keys.
// - Value replacement with the sentinel string `[REDACTED]` (key preserved).
// - Recursion into plain objects and arrays; primitive values pass through.
// - Cycle protection via a WeakSet of visited containers.
// - Pure: returns a sanitized copy; never mutates caller-owned structures.

export const REDACTED = '[REDACTED]';

// Canonical 25-term denylist (case-insensitive substring match on keys).
export const DEFAULT_DENYLIST = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'pwd',
  'api_key',
  'apikey',
  'x-api-key',
  'x-allstak-key',
  'x-auth-token',
  'x-access-token',
  'token',
  'bearer',
  'jwt',
  'session',
  'sessionid',
  'session_id',
  'secret',
  'credit_card',
  'card_number',
  'cvv',
  'ssn',
  'csrf',
] as const;

function isSensitive(key: string, denylist: readonly string[]): boolean {
  const k = key.toLowerCase();
  return denylist.some((term) => k.includes(term));
}

/**
 * Returns a sanitized deep copy of `payload`. The original is never mutated.
 * Extra denylist terms widen the canonical list; they never narrow it.
 */
export function scrub<T>(payload: T, extraDenylist?: readonly string[]): T {
  const denylist = extraDenylist
    ? [...DEFAULT_DENYLIST.map((t) => t.toLowerCase()), ...extraDenylist.map((t) => t.toLowerCase())]
    : (DEFAULT_DENYLIST as readonly string[]);
  const seen = new WeakSet<object>();
  return walk(payload, denylist, seen) as T;
}

function walk(value: unknown, denylist: readonly string[], seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return REDACTED; // cycle guard
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, denylist, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitive(k, denylist) ? REDACTED : walk(v, denylist, seen);
  }
  return out;
}
