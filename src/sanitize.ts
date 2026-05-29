// AllStak Next.js SDK sanitizer.
//
// Two layers of redaction, applied in one recursive pass:
//
//  1. KEY-NAME redaction (always on). Recursively scrubs sensitive keys across
//     the full event surface (user, extras, metadata, breadcrumbs.data,
//     contexts, request, response). Conforms to the canonical AllStak SDK
//     denylist defined in docs/standards/sdk-platform-standards.md.
//
//  2. VALUE-PATTERN redaction (opt-in via `scrubValues`). Scrubs PII that leaks
//     into free-text string VALUES:
//       A) ALWAYS scrubbed — credit-card numbers that pass the Luhn checksum,
//          and US SSNs written with hyphens. (Financial/identity data is never
//          legitimately wanted in telemetry, regardless of sendDefaultPii.)
//       B) Scrubbed UNLESS sendDefaultPii === true — email addresses and IPv4
//          addresses. When the host opts into PII these pass through.
//     Value-scrubbing is KEY-AWARE: it skips structural/identifying string
//     fields (stack frame paths, release/version/sdk fields, URLs/paths, span
//     operation names, the SDK sessionId) and the explicit `user` subtree, so
//     legitimate data and intentionally-set identification are never corrupted.
//
// Semantics:
// - Case-insensitive substring match on object keys for layer (1).
// - Value replacement with the sentinel string `[REDACTED]` (key preserved).
// - Recursion into plain objects and arrays; primitive values pass through
//   layer (1) untouched but string values flow through layer (2).
// - Cycle protection via a WeakSet of visited containers.
// - Pure: returns a sanitized copy; never mutates caller-owned structures.
// - Fail-open at the call site: a scrubber error must never drop an event.

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

// ── Value-pattern scrubbing ──────────────────────────────────────────────────

/**
 * String VALUES under these key names are NOT pattern-scrubbed: they are
 * structural / identifying fields where redacting an embedded number-run or
 * email-looking token would corrupt legitimate data (paths, versions, ids) or
 * strip data the host intentionally set. Matched case-insensitively as exact
 * keys. The `user` key additionally short-circuits the whole subtree
 * (explicit setUser data — id/email/ip — ships as-is).
 */
const VALUE_SCRUB_KEY_ALLOWLIST = new Set([
  // Stack frame / source identification — must stay byte-exact for symbolication.
  'filename',
  'function',
  'abspath',
  'module',
  'stacktrace',
  'frames',
  // Release / SDK / platform identity.
  'release',
  'version',
  'dist',
  'environment',
  'sdkname',
  'sdkversion',
  'platform',
  // Routing identity — URLs/paths have their own redactor; operation/span names.
  'url',
  'host',
  'path',
  'operation',
  'description',
  'service',
  // SDK correlation ids (also restored downstream, but skip them here too).
  'sessionid',
  'session_id',
  'traceid',
  'spanid',
  'parentspanid',
  'requestid',
  'fingerprint',
  'debugid',
]);

/** Keys whose ENTIRE subtree is exempt from value-scrubbing (explicit identity). */
const VALUE_SCRUB_SUBTREE_ALLOWLIST = new Set(['user']);

/**
 * Skip pattern-scanning very large strings. Value-scrubbing runs on the wire
 * path; an enormous blob (e.g. a serialized HTML body) would make the regex
 * scan a hot spot. Strings longer than this pass through layer (2) unchanged
 * (they are still key-redacted by layer (1) if their key is sensitive).
 */
const MAX_SCAN_LENGTH = 16_384;

// Compiled ONCE at module load — never recompiled per event.

/**
 * Credit-card candidate: a 13-19 digit run allowing single space/hyphen
 * separators between digits. We then strip separators and Luhn-validate before
 * redacting, so digit runs that are NOT valid card numbers (order ids,
 * timestamps, tracking numbers) are preserved. `\d(?:[ -]?\d){12,18}` matches
 * 13..19 digits total. Word-ish boundaries keep us off the middle of longer
 * runs.
 */
const CC_CANDIDATE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;

/** US SSN — hyphens REQUIRED (never matches a bare 9-digit number). */
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Standard email address. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * IPv4 with each octet validated to 0-255, so version-like or arbitrary
 * dotted-number runs that are not real addresses are left alone.
 */
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/**
 * Best-effort IPv6 (full and `::`-compressed forms). Conservative: requires at
 * least one group separator so single hex tokens are not redacted.
 */
const IPV6 =
  /\b(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:))\b/g;

/**
 * Luhn checksum validator. Operates on a pure digit string (separators already
 * stripped). Returns false for the wrong length so non-card digit runs are
 * preserved.
 */
export function luhnValid(digits: string): boolean {
  const len = digits.length;
  if (len < 13 || len > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = len - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i);
    if (code < 48 || code > 57) return false; // non-digit → not a card
    let d = code - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Apply value-pattern scrubbing to a single string. Always-on layer (A) runs
 * unconditionally; layer (B) runs only when `sendDefaultPii !== true`. Compiled
 * regexes are reused; large strings are skipped. Pure and fail-open (never
 * throws — any unexpected error returns the original string).
 */
export function scrubStringValue(input: string, sendDefaultPii: boolean): string {
  if (input.length === 0 || input.length > MAX_SCAN_LENGTH) return input;
  try {
    let out = input;

    // (A) Always — credit cards (Luhn-validated) and hyphenated SSNs.
    if (out.includes('-') || /\d{13}/.test(out) || /\d[ -]?\d/.test(out)) {
      // CC: redact only runs that pass Luhn (preserve order ids/timestamps).
      out = out.replace(CC_CANDIDATE, (match) => {
        const digits = match.replace(/[ -]/g, '');
        return luhnValid(digits) ? REDACTED : match;
      });
      out = out.replace(SSN, REDACTED);
    }

    // (B) Unless the host explicitly opted into PII.
    if (!sendDefaultPii) {
      if (out.includes('@')) out = out.replace(EMAIL, REDACTED);
      if (out.includes('.')) out = out.replace(IPV4, REDACTED);
      if (out.includes(':')) out = out.replace(IPV6, REDACTED);
    }

    return out;
  } catch {
    return input; // fail-open: never let a scrubber error corrupt/drop a value
  }
}

export interface ScrubOptions {
  /** Extra denylist terms; widen the canonical key list, never narrow it. */
  extraDenylist?: readonly string[];
  /** Enable value-pattern scrubbing of free-text string values. Default false. */
  scrubValues?: boolean;
  /**
   * When true, layer (B) value scrubbers (email/IP) are disabled — the host has
   * opted into PII. Layer (A) (CC/SSN) is ALWAYS applied. Default false.
   */
  sendDefaultPii?: boolean;
}

function isSensitive(key: string, denylist: readonly string[]): boolean {
  const k = key.toLowerCase();
  return denylist.some((term) => k.includes(term));
}

/**
 * Returns a sanitized deep copy of `payload`. The original is never mutated.
 *
 * Layer (1) key-name redaction always runs. Layer (2) value-pattern scrubbing
 * runs only when `options.scrubValues` is true; it is key-aware so structural
 * fields and the explicit `user` subtree are never touched.
 *
 * Back-compat: an array second argument is treated as `extraDenylist` so the
 * original `scrub(payload, ['term'])` signature still works.
 */
export function scrub<T>(payload: T, options?: ScrubOptions | readonly string[]): T {
  const opts: ScrubOptions = Array.isArray(options)
    ? { extraDenylist: options as readonly string[] }
    : (options as ScrubOptions) ?? {};
  const denylist = opts.extraDenylist
    ? [...DEFAULT_DENYLIST.map((t) => t.toLowerCase()), ...opts.extraDenylist.map((t) => t.toLowerCase())]
    : (DEFAULT_DENYLIST as readonly string[]);
  const seen = new WeakSet<object>();
  const ctx: WalkContext = {
    denylist,
    scrubValues: opts.scrubValues === true,
    sendDefaultPii: opts.sendDefaultPii === true,
    seen,
  };
  // Top-level string scrubbing only applies inside the keyed object tree; a
  // bare top-level string has no key context, so leave it to layer (2) with no
  // allowlist (it is rarely a wire payload, but stay consistent + fail-open).
  return walk(payload, ctx, false) as T;
}

interface WalkContext {
  denylist: readonly string[];
  scrubValues: boolean;
  sendDefaultPii: boolean;
  seen: WeakSet<object>;
}

/**
 * Recursive copy. `valueScrubExempt` is propagated true once we descend into an
 * allowlisted subtree (e.g. `user`) so the whole branch is preserved verbatim.
 */
function walk(value: unknown, ctx: WalkContext, valueScrubExempt: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (!ctx.scrubValues || valueScrubExempt) return value;
    return scrubStringValue(value, ctx.sendDefaultPii);
  }
  if (typeof value !== 'object') return value;
  if (ctx.seen.has(value as object)) return REDACTED; // cycle guard
  ctx.seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, ctx, valueScrubExempt));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitive(k, ctx.denylist)) {
      out[k] = REDACTED;
      continue;
    }
    const lower = k.toLowerCase();
    // Subtree exemption (explicit user identity) sticks for all descendants.
    const childExempt =
      valueScrubExempt || VALUE_SCRUB_SUBTREE_ALLOWLIST.has(lower);
    // Per-key value-scrub exemption only suppresses scrubbing for THIS field's
    // own string value(s); it does not propagate to unrelated descendants.
    const skipDirectValueScrub = childExempt || VALUE_SCRUB_KEY_ALLOWLIST.has(lower);
    if (typeof v === 'string') {
      out[k] = ctx.scrubValues && !skipDirectValueScrub
        ? scrubStringValue(v, ctx.sendDefaultPii)
        : v;
    } else {
      out[k] = walk(v, ctx, childExempt);
    }
  }
  return out;
}
