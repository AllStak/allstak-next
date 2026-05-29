import { getClient } from './client';

/**
 * Outbound HTTP instrumentation: a global `fetch` wrapper for node-server, edge,
 * and browser runtimes.
 *
 * Inbound requests are already captured by the middleware / route-handler
 * wrappers (`direction:'inbound'`). This wrapper covers the other side: when a
 * wrapped app calls `fetch`, it
 *   1. injects W3C `traceparent` + `baggage` headers on the OUTBOUND request so
 *      a distributed trace survives the first downstream hop, and
 *   2. emits an `HttpRequestPayload` with `direction:'outbound'` to
 *      `/ingest/v1/http-requests`.
 *
 * The SDK's own ingest host is skipped to avoid recursion (instrumenting the
 * telemetry POSTs themselves). Everything is best-effort and fully fail-open:
 * the original `fetch` result/exception is always returned/rethrown unchanged,
 * even if header injection or telemetry capture throws.
 */

interface InstrumentationState {
  original: typeof fetch;
  patched: typeof fetch;
}

const MARKER = '__allstak_instrumented__';

let state: InstrumentationState | null = null;

/**
 * Install the global outbound-`fetch` wrapper. Idempotent: a second call is a
 * no-op while already installed. Returns a teardown that restores the original
 * `fetch`. No-op (returns a no-op teardown) when `fetch` is unavailable.
 */
export function instrumentFetch(): () => void {
  const g = globalThis as typeof globalThis & { fetch?: typeof fetch };
  const current = g.fetch;
  if (typeof current !== 'function') return () => {};
  // Already instrumented (by us) — don't double-wrap.
  if ((current as unknown as Record<string, unknown>)[MARKER]) return () => uninstrumentFetch();
  if (state) return () => uninstrumentFetch();

  const original = current.bind(g) as typeof fetch;

  const patched = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startTimeMillis = Date.now();
    const method = resolveMethod(input, init);
    const url = resolveUrl(input);

    // Skip our own ingest host (and anything we can't parse) to avoid recursion.
    if (!url || isOwnIngestHost(url)) {
      return original(input as RequestInfo, init);
    }

    const trace = newTraceContext();
    let nextInput: RequestInfo | URL = input;
    let nextInit: RequestInit | undefined = init;
    try {
      const injected = injectTraceHeaders(input, init, trace);
      nextInput = injected.input;
      nextInit = injected.init;
    } catch {
      // Header injection failed — proceed with the original request untouched.
      nextInput = input;
      nextInit = init;
    }

    try {
      const response = await original(nextInput as RequestInfo, nextInit);
      void captureOutbound(trace, method, url, response.status, startTimeMillis);
      return response;
    } catch (error) {
      // Network error / abort: still record the attempt (status 0).
      void captureOutbound(trace, method, url, 0, startTimeMillis, 'error');
      throw error;
    }
  }) as typeof fetch;

  (patched as unknown as Record<string, unknown>)[MARKER] = true;
  g.fetch = patched;
  state = { original, patched };

  return () => uninstrumentFetch();
}

/**
 * Restore the original global `fetch`. Idempotent and fail-open. Only restores
 * when the current global `fetch` is still our wrapper (so we don't clobber a
 * different wrapper installed after us).
 */
export function uninstrumentFetch(): void {
  if (!state) return;
  try {
    const g = globalThis as typeof globalThis & { fetch?: typeof fetch };
    if (g.fetch === state.patched) {
      g.fetch = state.original;
    }
  } catch {
    // fail-open
  } finally {
    state = null;
  }
}

/** Whether the outbound-fetch wrapper is currently installed by us. */
export function isFetchInstrumented(): boolean {
  return state !== null;
}

interface TraceContext {
  traceId: string;
  spanId: string;
  requestId: string;
}

function newTraceContext(): TraceContext {
  return { traceId: generateTraceId(), spanId: generateSpanId(), requestId: generateTraceId() };
}

/**
 * Inject W3C `traceparent` + `baggage` (and the AllStak correlation headers)
 * onto the outbound request. Returns a possibly-new input/init pair: when the
 * caller passed a `Request` object we clone-with-headers via a fresh init so we
 * never mutate the original.
 */
function injectTraceHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  trace: TraceContext,
): { input: RequestInfo | URL; init: RequestInit | undefined } {
  const traceparent = `00-${trace.traceId}-${trace.spanId}-01`;
  const baggage = [
    `allstak-trace_id=${trace.traceId}`,
    `allstak-request_id=${trace.requestId}`,
    `allstak-span_id=${trace.spanId}`,
  ].join(',');

  // Case 1: a Request object carries its own headers; build a new init that
  // merges them so we don't mutate the caller's Request.
  const RequestCtor = (globalThis as { Request?: typeof Request }).Request;
  if (RequestCtor && input instanceof RequestCtor) {
    const headers = new Headers(input.headers);
    applyTraceHeaders(headers, traceparent, baggage, trace);
    const merged: RequestInit = { ...(init ?? {}) };
    // Caller-supplied init.headers win for non-trace keys; re-apply ours after.
    if (init?.headers) {
      const initHeaders = new Headers(init.headers as HeadersInit);
      initHeaders.forEach((value, key) => headers.set(key, value));
      applyTraceHeaders(headers, traceparent, baggage, trace);
    }
    merged.headers = headers;
    return { input, init: merged };
  }

  // Case 2: string/URL input — inject through (a copy of) init.headers.
  const headers = new Headers((init?.headers as HeadersInit) ?? undefined);
  applyTraceHeaders(headers, traceparent, baggage, trace);
  return { input, init: { ...(init ?? {}), headers } };
}

function applyTraceHeaders(headers: Headers, traceparent: string, baggage: string, trace: TraceContext): void {
  // Don't clobber an existing upstream traceparent — continue that trace if the
  // caller already set one, otherwise start a fresh one.
  if (!headers.has('traceparent')) headers.set('traceparent', traceparent);
  headers.set('baggage', mergeBaggage(headers.get('baggage'), baggage));
  headers.set('x-allstak-trace-id', trace.traceId);
  headers.set('x-allstak-request-id', trace.requestId);
  headers.set('x-allstak-span-id', trace.spanId);
}

/** Merge our allstak-* baggage entries with any existing baggage value. */
function mergeBaggage(existing: string | null, own: string): string {
  if (!existing || !existing.trim()) return own;
  const retained = existing
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.toLowerCase().startsWith('allstak-'));
  retained.push(own);
  return retained.join(',');
}

async function captureOutbound(
  trace: TraceContext,
  method: string,
  url: string,
  statusCode: number,
  startTimeMillis: number,
  _status?: 'ok' | 'error',
): Promise<void> {
  try {
    const client = getClient();
    if (!client || client.isDestroyed()) return;
    const { host, path } = splitUrl(url);
    await client.captureRequest({
      traceId: trace.traceId,
      requestId: trace.requestId,
      spanId: trace.spanId,
      parentSpanId: '',
      direction: 'outbound',
      method,
      host,
      path,
      statusCode,
      durationMs: Math.max(0, Date.now() - startTimeMillis),
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Telemetry must never affect the caller's fetch.
  }
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  const RequestCtor = (globalThis as { Request?: typeof Request }).Request;
  if (RequestCtor && input instanceof RequestCtor) return (input.method || 'GET').toUpperCase();
  return 'GET';
}

function resolveUrl(input: RequestInfo | URL): string {
  try {
    if (typeof input === 'string') return input;
    const RequestCtor = (globalThis as { Request?: typeof Request }).Request;
    if (RequestCtor && input instanceof RequestCtor) return input.url;
    if (input instanceof URL) return input.toString();
    // Fall back to a `.url` property or stringification.
    const maybe = (input as { url?: unknown }).url;
    if (typeof maybe === 'string') return maybe;
    return String(input);
  } catch {
    return '';
  }
}

function splitUrl(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url, getBaseUrl());
    return { host: parsed.host, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: '', path: url.startsWith('/') ? url : `/${url}` };
  }
}

function getBaseUrl(): string | undefined {
  try {
    return (globalThis as { location?: { href?: string } }).location?.href;
  } catch {
    return undefined;
  }
}

/** True when the URL targets the SDK's own ingest host (skip to avoid recursion). */
function isOwnIngestHost(url: string): boolean {
  try {
    const client = getClient();
    if (!client) {
      // No client yet — still skip obvious ingest paths so a pre-init fetch to
      // the API host doesn't recurse once a client appears.
      return /\/ingest\/v1\//.test(url);
    }
    const host = client.getHost();
    if (!host) return /\/ingest\/v1\//.test(url);
    const target = new URL(url, getBaseUrl());
    const ingest = new URL(host);
    if (target.host === ingest.host) return true;
    return /\/ingest\/v1\//.test(target.pathname);
  } catch {
    return /\/ingest\/v1\//.test(url);
  }
}

function generateTraceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function generateSpanId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
