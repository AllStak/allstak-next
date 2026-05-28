import { resolveDebugId } from './utils/debug-id';
import { scrub } from './sanitize';
import { getActiveMergedScope, type MergedScopeData } from './scope';
import { resolveRelease, type GitRunner } from './release';
import {
  OfflineQueue,
  isPersistablePath,
  type OfflineQueueLimits,
  type PersistedEnvelope,
} from './persistence';

const DEFAULT_HOST = 'https://api.allstak.sa';
export const SDK_NAME = '@allstak/next';
export const SDK_VERSION = '0.1.3';
const TRANSPORT_TIMEOUT_MS = 3000;
/** Shorter timeout for the session/end POST so graceful shutdown is never blocked. */
const SESSION_END_TIMEOUT_MS = 1500;
const MAX_BREADCRUMBS = 30;
/** Upper bound for any honored Retry-After delay. */
const MAX_RETRY_AFTER_MS = 300_000;
const runtimeReleaseRegistrations = new Set<string>();

/**
 * Parse an HTTP `Retry-After` header into a delay in milliseconds.
 *
 * Supports the two RFC 7231 forms:
 *   - delta-seconds: a non-negative integer (e.g. "120" → 120000ms)
 *   - HTTP-date: an absolute date; the delta from `now` is returned (clamped ≥ 0)
 *
 * Returns 0 when the header is absent, empty, or unparseable so callers can
 * fall back to their computed backoff. The result is clamped to
 * MAX_RETRY_AFTER_MS (300000). Pure and side-effect free.
 */
export function parseRetryAfter(headerValue: string | null, now: number): number {
  if (headerValue == null) return 0;
  const raw = headerValue.trim();
  if (raw === '') return 0;

  let ms: number;
  if (/^\d+$/.test(raw)) {
    // delta-seconds: a bare non-negative integer.
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    ms = seconds * 1000;
  } else {
    // HTTP-date form.
    const when = Date.parse(raw);
    if (Number.isNaN(when)) return 0;
    const delta = when - now;
    ms = delta > 0 ? delta : 0;
  }

  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

export type BreadcrumbType = 'navigation' | 'ui' | 'http' | 'console' | 'custom';
/** @deprecated Use BreadcrumbType instead */
export type BreadcrumbCategory = BreadcrumbType;
export type SeverityLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

/**
 * Release-health session status. Mirrors the Java SDK's `SessionStatus` and the
 * backend `/ingest/v1/sessions/end` contract:
 *   - `ok`       — session running / ended normally.
 *   - `errored`  — at least one HANDLED error captured, process kept running.
 *   - `crashed`  — an UNHANDLED / fatal error ended the session.
 *   - `abnormal` — ended without a normal flush (reserved).
 */
export type SessionStatus = 'ok' | 'errored' | 'crashed' | 'abnormal';

export interface Breadcrumb {
  timestamp: string;
  type: BreadcrumbType;
  message: string;
  level?: string;
  data?: Record<string, unknown>;
}

export interface StackFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  debugId?: string;
}

export interface DebugImage {
  type: 'sourcemap';
  debugId: string;
}

export interface ErrorPayload {
  exceptionClass: string;
  message: string;
  stackTrace: string[];
  frames: StackFrame[];
  level: SeverityLevel;
  environment: string;
  release: string;
  breadcrumbs: Breadcrumb[];
  metadata: Record<string, unknown>;
  timestamp: string;
  sdkName: string;
  sdkVersion: string;
  platform: string;
  /** Release-health session id; lets the backend attribute the error to the active session. */
  sessionId?: string;
  debugMeta?: { images: DebugImage[] };
}

export interface SpanPayload {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  operation: string;
  description: string;
  status: 'ok' | 'error' | 'timeout';
  durationMs: number;
  startTimeMillis: number;
  endTimeMillis: number;
  service: string;
  environment: string;
  tags: Record<string, string>;
  data: string;
}

export interface HttpRequestPayload {
  traceId: string;
  requestId: string;
  spanId?: string;
  parentSpanId?: string;
  direction: 'inbound' | 'outbound';
  method: string;
  host: string;
  path: string;
  statusCode: number;
  durationMs: number;
  environment?: string;
  release?: string;
  timestamp: string;
}

/**
 * Outbound error/message event passed to `beforeSend`. This is the
 * fully-built wire payload (before redaction). Returning `null` drops it.
 */
export type AllStakNextEvent = ErrorPayload;

export interface AllStakNextClientOptions {
  apiKey?: string;
  dsn?: string;
  host?: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  /**
   * Fraction 0..1 of error/message events captured. Default 1 (keep all).
   * Applied at capture time, BEFORE `beforeSend`: dropped events never reach
   * `beforeSend`. Out-of-range or non-finite values clamp to [0, 1].
   */
  sampleRate?: number;
  /**
   * Called once just before an error/message event is sent. Return the event
   * (optionally mutated) to send it, or `null` to drop it. Fail-open: if the
   * callback throws, the original event is sent. Not called for events already
   * dropped by `sampleRate`.
   */
  beforeSend?: (event: AllStakNextEvent) => AllStakNextEvent | null;
  /** RNG seam for deterministic tests. Defaults to Math.random. Returns [0,1). */
  random?: () => number;
  /**
   * Auto-detect the release when `release` is not set: env vars (ALLSTAK_RELEASE,
   * VERCEL_GIT_COMMIT_SHA, …), then local git at init (Node server runtime only),
   * then the SDK version so release is never empty. Default true. Set false to
   * gate off the git lookup and version fallback. The git step never runs on the
   * Next.js edge or browser runtimes — there it resolves from env/version only.
   */
  autoDetectRelease?: boolean;
  /**
   * Register the resolved release with AllStak from the server runtime at
   * startup, without requiring a CI/CD hook. Default true. Browser/edge
   * runtimes are skipped.
   */
  autoRegisterRelease?: boolean;
  /**
   * Enable release-health session tracking (Sentry-style "one session per
   * process / app-launch"). When true (the default), the client POSTs
   * `/ingest/v1/sessions/start` at init and `/ingest/v1/sessions/end` on
   * graceful shutdown, tracking a local ok/errored/crashed status in between.
   * Sessions are NEVER sampled. Fully fail-open. Set false to opt out.
   * Automatically skipped under a unit-test runtime (NODE_ENV=test / VITEST).
   */
  enableAutoSessionTracking?: boolean;
  /** Git runner seam for deterministic tests; defaults to a guarded spawnSync. */
  gitRunner?: GitRunner;
  /**
   * Persist un-sent telemetry so it survives a process/app restart AND a
   * network outage (Sentry-style offline store). When an event can't be
   * delivered (network error, retries exhausted, offline, or shutdown with
   * events still buffered) the already-PII-scrubbed payload is written to a
   * persistent store and replayed on the next init.
   *
   * Backend is chosen per runtime: localStorage (browser), an fs spool dir
   * (Node server), or in-memory degrade (edge/sandboxed). Session lifecycle
   * calls are NEVER persisted. Default true. Set false to opt out. Fully
   * fail-open. Automatically suppressed under a unit-test runtime
   * (NODE_ENV=test / VITEST) unless explicitly set true.
   */
  enableOfflineQueue?: boolean;
  /** Spool directory for the Node fs offline store. Defaults to os.tmpdir(). */
  offlineSpoolDir?: string;
  /** Override the offline store bounds (count / bytes / age). */
  offlineQueueLimits?: Partial<OfflineQueueLimits>;
}

function clamp01(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export class AllStakNextClient {
  private readonly apiKey: string;
  private readonly host: string;
  private readonly environment: string;
  private readonly release: string;
  private readonly sampleRate: number;
  private readonly beforeSend?: (event: AllStakNextEvent) => AllStakNextEvent | null;
  private readonly random: () => number;
  private breadcrumbs: Breadcrumb[] = [];
  private destroyed = false;
  private pendingRequests: Promise<void>[] = [];

  // ── Offline / persistent event queue (survive restart + outage) ──
  private readonly offlineQueueEnabled: boolean;
  private readonly offlineQueue: OfflineQueue | null;
  /** Resolves when the init-time drain finishes (test seam; fail-open). */
  private drainOnInit: Promise<void> = Promise.resolve();

  // ── Release-health session state (one session per process / app-launch) ──
  private readonly platform: string;
  private readonly sessionTrackingEnabled: boolean;
  private readonly sessionId: string;
  private sessionStart = 0;
  private sessionStatus: SessionStatus = 'ok';
  private sessionStarted = false;
  private sessionEnded = false;

  constructor(options: AllStakNextClientOptions) {
    this.apiKey = options.apiKey || options.dsn || '';
    this.host = (options.host || options.endpoint || DEFAULT_HOST).replace(/\/$/, '');
    this.environment = options.environment || '';
    // Resolve the release: explicit config > env vars > local git (Node server
    // runtime only) > SDK version. resolveRelease guards the git step itself,
    // so this is safe on the edge/browser bundle (git is skipped there).
    this.release = resolveRelease({
      explicit: options.release,
      autoDetectRelease: options.autoDetectRelease,
      gitRunner: options.gitRunner,
      version: SDK_VERSION,
    });
    this.sampleRate = clamp01(options.sampleRate);
    this.beforeSend = options.beforeSend;
    this.random = options.random || Math.random;
    this.platform = detectPlatform();
    this.sessionId = generateSessionId();
    this.sessionTrackingEnabled = shouldAutoSessionTrack(options.enableAutoSessionTracking);
    this.offlineQueueEnabled = shouldEnableOfflineQueue(options.enableOfflineQueue);
    this.offlineQueue = this.offlineQueueEnabled
      ? safeNewOfflineQueue({ spoolDir: options.offlineSpoolDir, limits: options.offlineQueueLimits })
      : null;
    if (shouldAutoRegisterRelease(options.autoRegisterRelease)) {
      this.registerRuntimeRelease();
    }
    if (this.sessionTrackingEnabled) {
      this.startSession();
    }
    // Replay any telemetry persisted by a previous process/app launch. Async +
    // fail-open: drain must never block init.
    if (this.offlineQueue && this.apiKey) {
      this.drainOnInit = this.drainPersistedQueue().catch(() => undefined);
    }
  }

  /** Stable id for the current release-health session. */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Whether release-health session tracking is active for this client. */
  isSessionTrackingEnabled(): boolean {
    return this.sessionTrackingEnabled;
  }

  /** Current in-memory session status (ok → errored → crashed). */
  getSessionStatus(): SessionStatus {
    return this.sessionStatus;
  }

  /**
   * Begin the release-health session: record the start time, mark status `ok`,
   * and POST `/ingest/v1/sessions/start`. Idempotent and fully fail-open — a
   * missing apiKey, a disabled client, or a network error never throws or
   * blocks init. Sessions are NEVER sampled. Fired through the existing
   * transport path; the POST is not awaited so init stays non-blocking.
   */
  startSession(): void {
    if (this.sessionStarted || this.destroyed) return;
    this.sessionStarted = true;
    this.sessionStart = Date.now();
    this.sessionStatus = 'ok';
    if (!this.apiKey) return;
    const scopeUser = getActiveMergedScope().user;
    const userId = typeof scopeUser?.id === 'string' ? scopeUser.id : undefined;
    const payload: Record<string, unknown> = {
      sessionId: this.sessionId,
      // Release-health needs a non-empty release; fall back to the SDK version.
      release: this.release || SDK_VERSION,
      environment: this.environment,
      userId,
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      platform: this.platform,
    };
    // Bypass the sampling pipeline (sessions are never sampled) and don't await:
    // init must not block on a network round-trip.
    void this.send('/ingest/v1/sessions/start', payload).catch(() => undefined);
  }

  /**
   * Record a HANDLED error against the active session: bump status to
   * `errored` unless it has already escalated to a terminal `crashed`. No I/O —
   * the status rides the session/end POST. Mirrors the Java `Session.recordError`.
   */
  markSessionErrored(): void {
    if (this.sessionStatus === 'ok') this.sessionStatus = 'errored';
  }

  /**
   * Record an UNHANDLED / fatal crash against the active session (overrides
   * `errored`). No I/O — the status rides the session/end POST. Mirrors the
   * Java `Session.recordCrash`.
   */
  markSessionCrashed(): void {
    this.sessionStatus = 'crashed';
  }

  /**
   * Terminate the release-health session on graceful shutdown: compute
   * `durationMs` and POST `/ingest/v1/sessions/end` with the final status.
   * Idempotent, best-effort, short timeout — must never block or throw. The
   * server does NOT downgrade an already-crashed session.
   */
  endSession(finalStatus?: SessionStatus): void {
    if (this.sessionEnded || !this.sessionStarted) return;
    this.sessionEnded = true;
    if (!this.apiKey) return;
    const status = finalStatus ?? this.sessionStatus;
    const durationMs = Math.max(0, Date.now() - this.sessionStart);
    const payload = { sessionId: this.sessionId, durationMs, status };
    void this.send('/ingest/v1/sessions/end', payload, SESSION_END_TIMEOUT_MS).catch(() => undefined);
  }

  private registerRuntimeRelease(): void {
    if (!this.apiKey || !this.release || !isNodeServer()) return;
    const environment = this.environment || 'production';
    const key = `${this.host}|${this.apiKey}|${environment}|${this.release}`;
    if (runtimeReleaseRegistrations.has(key)) return;
    runtimeReleaseRegistrations.add(key);
    void this.postOnce('/ingest/v1/releases', JSON.stringify({
      version: this.release,
      environment,
      author: `${SDK_NAME}/${SDK_VERSION}`,
      message: 'Registered automatically by AllStak Next SDK at runtime',
    })).catch(() => undefined);
  }

  /**
   * Capture-time event pipeline for error/message events:
   *   sampleRate drop → beforeSend → (transport applies redaction).
   * Returns the event to send, or `null` if it was dropped. `beforeSend` is
   * fail-open: a throwing callback yields the original event.
   */
  private applyEventPipeline(event: AllStakNextEvent): AllStakNextEvent | null {
    if (this.sampleRate < 1 && this.random() >= this.sampleRate) return null;
    if (!this.beforeSend) return event;
    try {
      return this.beforeSend(event) ?? null;
    } catch {
      return event; // beforeSend errors must never crash capture
    }
  }

  /**
   * Merge the active scope (per-request when inside a wrapped handler, else the
   * global scope) onto an error/message event the client just built:
   *   - scope user/tags/extras/contexts → metadata (user.* / tag.* / extra.* / context.*)
   *   - scope breadcrumbs prepended ahead of the client's own ring buffer
   *   - scope level overrides the default when set
   * Mutates and returns the payload. Pure w.r.t. the scope objects.
   */
  private mergeScope(payload: ErrorPayload, merged: MergedScopeData = getActiveMergedScope()): ErrorPayload {
    if (merged.user) {
      payload.metadata.user = { ...(payload.metadata.user as object | undefined ?? {}), ...merged.user };
    }
    for (const [k, v] of Object.entries(merged.tags)) payload.metadata[`tag.${k}`] = v;
    for (const [k, v] of Object.entries(merged.extras)) payload.metadata[`extra.${k}`] = v;
    for (const [name, ctx] of Object.entries(merged.contexts)) payload.metadata[`context.${name}`] = ctx;
    if (merged.fingerprint) payload.metadata.fingerprint = merged.fingerprint;
    if (merged.level) payload.level = merged.level;
    if (merged.breadcrumbs.length) {
      payload.breadcrumbs = [
        ...merged.breadcrumbs.map((c) => ({
          timestamp: c.timestamp ?? new Date().toISOString(),
          type: (c.type as Breadcrumb['type']) ?? 'custom',
          message: c.message,
          level: c.level,
          data: c.data,
        })),
        ...payload.breadcrumbs,
      ];
    }
    return payload;
  }

  addBreadcrumb(breadcrumb: Omit<Breadcrumb, 'timestamp'>): void {
    if (this.destroyed) return;
    this.breadcrumbs.push({ ...breadcrumb, timestamp: new Date().toISOString() });
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) {
      this.breadcrumbs = this.breadcrumbs.slice(-MAX_BREADCRUMBS);
    }
  }

  async captureException(error: Error, context: Record<string, unknown> = {}): Promise<void> {
    if (this.destroyed || !this.apiKey) return;
    const frames = parseStack(error.stack);

    // Resolve debug-IDs per frame so the symbolicator can pick the
    // right source map for each stack frame.
    for (const frame of frames) {
      const id = resolveDebugId(frame.filename);
      if (id) frame.debugId = id;
    }

    // Aggregate unique debug-IDs into debugMeta.images[] so the
    // backend can match by image-level debugId as well.
    const debugIdSet = new Set<string>();
    for (const f of frames) if (f.debugId) debugIdSet.add(f.debugId);
    const debugMeta = debugIdSet.size > 0
      ? { images: Array.from(debugIdSet).map((id): DebugImage => ({ type: 'sourcemap' as const, debugId: id })) }
      : undefined;

    const payload: ErrorPayload = {
      exceptionClass: error.name || 'Error',
      message: error.message,
      stackTrace: formatFrames(frames),
      frames,
      level: 'error',
      environment: this.environment,
      release: this.release,
      breadcrumbs: [...this.breadcrumbs],
      metadata: { sdkName: SDK_NAME, sdkVersion: SDK_VERSION, ...context },
      timestamp: new Date().toISOString(),
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      platform: this.platform,
      sessionId: this.sessionId,
      debugMeta,
    };
    this.mergeScope(payload);
    // Release-health status: an unhandled/fatal mechanism crashes the session,
    // anything else captured here is a handled error.
    if (isCrashMechanism(context, payload.level)) this.markSessionCrashed();
    else this.markSessionErrored();
    const outbound = this.applyEventPipeline(payload);
    if (!outbound) return;
    await this.send('/ingest/v1/errors', outbound);
  }

  async captureMessage(message: string, level: SeverityLevel = 'info'): Promise<void> {
    if (this.destroyed || !this.apiKey) return;
    const payload: ErrorPayload = {
      exceptionClass: 'Message',
      message,
      stackTrace: [],
      frames: [],
      level,
      environment: this.environment,
      release: this.release,
      breadcrumbs: [...this.breadcrumbs],
      metadata: { sdkName: SDK_NAME, sdkVersion: SDK_VERSION },
      timestamp: new Date().toISOString(),
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      platform: this.platform,
      sessionId: this.sessionId,
    };
    this.mergeScope(payload);
    // A fatal-level message escalates the session to crashed; error-level
    // marks it errored. info/warning/debug leave the session ok.
    if (level === 'fatal') this.markSessionCrashed();
    else if (level === 'error') this.markSessionErrored();
    const outbound = this.applyEventPipeline(payload);
    if (!outbound) return;
    await this.send('/ingest/v1/errors', outbound);
  }

  async captureSpan(span: SpanPayload): Promise<void> {
    if (this.destroyed || !this.apiKey) return;
    await this.send('/ingest/v1/spans', { spans: [span] });
  }

  async captureRequest(request: HttpRequestPayload): Promise<void> {
    if (this.destroyed || !this.apiKey) return;
    await this.send('/ingest/v1/http-requests', {
      requests: [{
        ...request,
        environment: request.environment ?? this.environment,
        release: request.release ?? this.release,
      }],
    });
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingRequests);
    this.pendingRequests = [];
  }

  /**
   * Browser tab-close flush: best-effort deliver any persisted (failed/buffered)
   * telemetry via `navigator.sendBeacon` so in-flight events are not lost when
   * the tab is closing. Beacon requests outlive the page, unlike `fetch`.
   * Entries that beacon accepts (queued by the browser) are removed from the
   * store; the rest stay for the next launch. Synchronous + fully fail-open —
   * safe to call from a `pagehide` / `visibilitychange('hidden')` listener.
   */
  flushViaBeacon(): void {
    const queue = this.offlineQueue;
    if (!queue || !this.apiKey) return;
    const beacon = (globalThis as { navigator?: { sendBeacon?: (url: string, data?: BodyInit) => boolean } })
      .navigator?.sendBeacon;
    if (typeof beacon !== 'function') return;
    try {
      const pending = queue.loadAll();
      if (pending.length === 0) return;
      const survivors: PersistedEnvelope[] = [];
      for (const env of pending) {
        let sent = false;
        try {
          // sendBeacon can't set custom headers, so pass the API key as a query
          // param; ingest accepts X-AllStak-Key or this fallback for beacons.
          const url = `${this.host}${env.path}?allstak_key=${encodeURIComponent(this.apiKey)}`;
          const blob = makeBeaconBlob(env.body);
          sent = beacon.call((globalThis as { navigator: object }).navigator, url, blob);
        } catch {
          sent = false;
        }
        if (!sent) survivors.push(env);
      }
      queue.replaceAll(survivors);
    } catch {
      // fail-open
    }
  }

  /** Whether the offline/persistent queue is active for this client. */
  isOfflineQueueEnabled(): boolean {
    return this.offlineQueueEnabled;
  }

  /** @internal test seam: await the init-time replay of the persisted store. */
  async _awaitInitDrainForTest(): Promise<void> {
    await this.drainOnInit;
  }

  destroy(): void {
    // Graceful dispose path: end the session (best-effort) before tearing down.
    if (this.sessionTrackingEnabled) {
      try {
        this.endSession();
      } catch {
        // fail-open
      }
    }
    this.destroyed = true;
    this.breadcrumbs = [];
    this.pendingRequests = [];
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getBreadcrumbs(): ReadonlyArray<Breadcrumb> {
    return this.breadcrumbs;
  }

  getEnvironment(): string {
    return this.environment;
  }

  getRelease(): string {
    return this.release;
  }

  private async send(path: string, payload: unknown, timeoutMs: number = TRANSPORT_TIMEOUT_MS): Promise<void> {
    const request = this.doFetch(path, payload, timeoutMs);
    this.pendingRequests.push(request);
    await request;
  }

  /**
   * Scrub a wire payload to its serialized body. One chokepoint protects every
   * telemetry type. Pure (no caller mutation), fail-open on sanitizer error.
   * Restores the SDK's own top-level `sessionId` correlation id that the
   * substring denylist would otherwise redact.
   */
  private scrubToBody(payload: unknown): string {
    try {
      const scrubbed = scrub(payload) as unknown;
      if (
        scrubbed && typeof scrubbed === 'object' &&
        payload && typeof payload === 'object' &&
        typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ) {
        (scrubbed as { sessionId?: unknown }).sessionId = (payload as { sessionId: string }).sessionId;
      }
      return JSON.stringify(scrubbed);
    } catch {
      return JSON.stringify(payload);
    }
  }

  private async doFetch(path: string, payload: unknown, timeoutMs: number = TRANSPORT_TIMEOUT_MS): Promise<void> {
    // Scrub BEFORE anything touches the wire OR the persistent store — never
    // persist secrets/unredacted data to disk/localStorage.
    const body = this.scrubToBody(payload);
    const outcome = await this.deliver(path, body, timeoutMs);
    // Persist on failure so the event survives a restart/outage. Session
    // lifecycle calls are excluded (handled inside the queue too).
    if (outcome === 'failed' && this.offlineQueue && isPersistablePath(path)) {
      this.offlineQueue.persist(path, body);
    }
  }

  /**
   * POST an already-scrubbed body once, honoring Retry-After on 429/503 exactly
   * once. Returns the delivery outcome:
   *   - `delivered`: a 2xx response (accepted).
   *   - `dropped`:   a 4xx other than 429 (permanently undeliverable).
   *   - `failed`:    network error, timeout, 429, 5xx, or any retry-able state
   *                  (the caller may persist it).
   * Never throws.
   */
  private async deliver(path: string, body: string, timeoutMs: number = TRANSPORT_TIMEOUT_MS): Promise<DeliveryOutcome> {
    try {
      let response = await this.postOnce(path, body, timeoutMs);
      if (response && (response.status === 429 || response.status === 503)) {
        const headerValue = response.headers?.get?.('Retry-After') ?? null;
        const waitMs = parseRetryAfter(headerValue, Date.now());
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, waitMs));
          response = await this.postOnce(path, body, timeoutMs);
        }
      }
      return classifyResponse(response);
    } catch {
      // Network error / timeout / abort — retry-able, persist it.
      return 'failed';
    }
  }

  /**
   * Drain telemetry persisted by a previous launch and re-send it through the
   * existing transport. Removes an entry only after it is accepted (2xx) or is
   * permanently undeliverable (4xx other than 429); a still-`failed` entry is
   * retained for the next launch. Fully fail-open; runs asynchronously so init
   * is never blocked.
   */
  private async drainPersistedQueue(): Promise<void> {
    const queue = this.offlineQueue;
    if (!queue || this.destroyed || !this.apiKey) return;
    let pending: PersistedEnvelope[];
    try {
      pending = queue.loadAll();
    } catch {
      return;
    }
    if (pending.length === 0) return;

    const survivors: PersistedEnvelope[] = [];
    for (const env of pending) {
      if (this.destroyed) {
        survivors.push(env);
        continue;
      }
      const outcome = await this.deliver(env.path, env.body);
      // Keep only the ones that still couldn't be delivered. `delivered` and
      // `dropped` (permanent 4xx) are both removed from the store.
      if (outcome === 'failed') survivors.push(env);
    }
    queue.replaceAll(survivors);
  }

  private async postOnce(path: string, body: string, timeoutMs: number = TRANSPORT_TIMEOUT_MS): Promise<Response | undefined> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.host}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AllStak-Key': this.apiKey,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function parseStack(stack?: string): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  const lines = stack.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s+at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (match) {
      frames.push({
        function: match[1] || '<anonymous>',
        filename: match[2],
        lineno: parseInt(match[3], 10),
        colno: parseInt(match[4], 10),
        in_app: !match[2]?.includes('node_modules'),
      });
    }
  }
  return frames;
}

export function formatFrames(frames: StackFrame[]): string[] {
  return frames.map((f) => {
    const fn = f.function || '<anonymous>';
    const file = f.filename || '<unknown>';
    return `at ${fn} (${file}:${f.lineno ?? 0}:${f.colno ?? 0})`;
  });
}

let clientSingleton: AllStakNextClient | null = null;

export function getClient(): AllStakNextClient | null {
  return clientSingleton;
}

export function setClient(client: AllStakNextClient | null): void {
  clientSingleton = client;
}

function isNodeServer(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string }; env?: Record<string, string | undefined> } }).process;
  return !!proc?.versions?.node && proc.env?.NEXT_RUNTIME !== 'edge';
}

function shouldAutoRegisterRelease(value: boolean | undefined): boolean {
  if (value === false) return false;
  if (value === true) return true;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NODE_ENV !== 'test' && env?.VITEST !== 'true';
}

/** Delivery outcome for a single transport attempt. */
type DeliveryOutcome = 'delivered' | 'dropped' | 'failed';

/**
 * Classify an HTTP response into a delivery outcome:
 *   - 2xx → `delivered` (accepted; remove from store).
 *   - 4xx other than 429 → `dropped` (permanently undeliverable; remove).
 *   - everything else (429, 5xx, or no response) → `failed` (retry-able; keep).
 */
function classifyResponse(response: Response | undefined): DeliveryOutcome {
  if (!response) return 'failed';
  const status = response.status;
  if (status >= 200 && status < 300) return 'delivered';
  if (status >= 400 && status < 500 && status !== 429) return 'dropped';
  return 'failed';
}

/**
 * Decide whether the offline/persistent queue is active. Defaults to TRUE, but
 * is automatically suppressed under a unit-test runtime (NODE_ENV=test /
 * VITEST) so the SDK's own tests don't touch localStorage/the fs spool. An
 * explicit `true`/`false` always wins (tests opt in by passing `true`).
 */
function shouldEnableOfflineQueue(value: boolean | undefined): boolean {
  if (value === false) return false;
  if (value === true) return true;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NODE_ENV !== 'test' && env?.VITEST !== 'true';
}

/** Construct an OfflineQueue without ever throwing into init (fail-open). */
function safeNewOfflineQueue(opts: { spoolDir?: string; limits?: Partial<OfflineQueueLimits> }): OfflineQueue | null {
  try {
    return new OfflineQueue(opts);
  } catch {
    return null;
  }
}

/**
 * Wrap a JSON body for `sendBeacon`. A typed Blob keeps the content-type as
 * JSON where Blob is available; otherwise fall back to the raw string.
 */
function makeBeaconBlob(body: string): BodyInit {
  try {
    const B = (globalThis as { Blob?: typeof Blob }).Blob;
    if (B) return new B([body], { type: 'application/json' });
  } catch {
    /* fall through */
  }
  return body;
}

/**
 * Decide whether release-health session tracking is active. Defaults to TRUE,
 * but is automatically suppressed under a unit-test runtime (NODE_ENV=test /
 * VITEST) so the SDK's own tests don't emit session start/end traffic — mirrors
 * the Java SDK's test guard and the existing `shouldAutoRegisterRelease`.
 * An explicit `true`/`false` always wins (tests opt in by passing `true`).
 */
function shouldAutoSessionTrack(value: boolean | undefined): boolean {
  if (value === false) return false;
  if (value === true) return true;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NODE_ENV !== 'test' && env?.VITEST !== 'true';
}

/**
 * Best-effort platform label for the active Next.js runtime. The original
 * client hardcoded `node` everywhere; sessions and events should report the
 * runtime they actually ran on: `browser`, `edge`, or `node`.
 */
function detectPlatform(): string {
  const proc = (globalThis as {
    process?: { versions?: { node?: string }; env?: Record<string, string | undefined> };
  }).process;
  if (proc?.env?.NEXT_RUNTIME === 'edge') return 'edge';
  if (typeof window !== 'undefined' && typeof document !== 'undefined') return 'browser';
  if (proc?.versions?.node) return 'node';
  // Edge runtime defines a minimal `process` shim without `versions.node`.
  return proc ? 'edge' : 'browser';
}

/** Runtime-safe session id (uses crypto.randomUUID when available). */
function generateSessionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * A captured exception is a session "crash" (vs. a handled "errored") when it
 * arrived through an unhandled/global mechanism or carries a fatal level.
 * Mirrors the Java SDK split between `recordError` and `recordCrash`.
 */
const CRASH_MECHANISMS = new Set([
  'uncaughtException',
  'unhandledRejection',
  'window.onerror',
  'window.onunhandledrejection',
]);
function isCrashMechanism(context: Record<string, unknown>, level: SeverityLevel): boolean {
  if (level === 'fatal') return true;
  const mechanism = context?.mechanism;
  return typeof mechanism === 'string' && CRASH_MECHANISMS.has(mechanism);
}

/** @internal */
export function _resetRuntimeReleaseRegistrationForTest(): void {
  runtimeReleaseRegistrations.clear();
}
