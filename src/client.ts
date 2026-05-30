import { resolveDebugId } from './utils/debug-id';
import { getSanitizerRedactionCount, scrub } from './sanitize';
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
export const SDK_VERSION = '0.3.0';
const TRANSPORT_TIMEOUT_MS = 3000;
/** Shorter timeout for the session/end POST so graceful shutdown is never blocked. */
const SESSION_END_TIMEOUT_MS = 1500;
const MAX_BREADCRUMBS = 30;
const COMPRESSION_THRESHOLD_BYTES = 16 * 1024;
/** Upper bound for any honored Retry-After delay. */
const MAX_RETRY_AFTER_MS = 300_000;
const SESSION_STATE_VERSION = 1;
const SESSION_STATE_PREFIX = 'allstak.next.session.v1';
const SESSION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_RECOVERY_LOCK_MS = 30_000;
const SESSION_RECOVERY_MAX_ATTEMPTS = 3;
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

export interface SessionStateStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedSessionState {
  version: 1;
  sessionId: string;
  startedAt: number;
  updatedAt: number;
  status: SessionStatus;
  release?: string;
  environment?: string;
  userId?: string;
  sdkName?: string;
  sdkVersion?: string;
  platform?: string;
  closed?: boolean;
  endedAt?: number;
  recoveryAttempts?: number;
  recoveryLockOwner?: string;
  recoveryLockUntil?: number;
  recoveredAt?: number;
}

export interface Breadcrumb {
  timestamp: string;
  type: BreadcrumbType;
  message: string;
  level?: string;
  data?: Record<string, unknown>;
}

export interface SdkDiagnostics {
  eventsCaptured: number;
  eventsSent: number;
  eventsFailed: number;
  eventsDropped: number;
  eventsPersisted: number;
  eventsReplayed: number;
  queueSize: number;
  retryAttempts: number;
  rateLimitedCount: number;
  compressedPayloads: number;
  uncompressedPayloads: number;
  compressionBytesSaved: number;
  sanitizerRedactionCount: number;
  activeTraceCount: number;
  activeSpanCount: number;
  breadcrumbCount: number;
  sessionRecoveryCount: number;
  disabled: boolean;
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

/**
 * A span emitted to `/ingest/v1/spans` that carries a numeric `measurements`
 * map (the wire shape the backend `PerformanceRepository` reads). Used for Core
 * Web Vitals, which are ingested AS SPANS with `op="web.vital"`: the ingest API
 * classifies op IN ('pageload','navigation','browser.resource','web.vital') as
 * the "web" category and stores the `measurements` map, which is how vitals
 * reach the web-vitals dashboard.
 *
 * This is a superset of {@link SpanPayload} aligned with the backend SpanItem
 * shape: it adds `op`, `measurements`, `sessionId`, and `platform`, and most
 * descriptive fields are optional so a lean vitals span stays small.
 */
export interface WebVitalSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Canonical operation name, e.g. `web.vital`. */
  operation: string;
  /** Short op alias mirroring `operation` (backend reads `op`). */
  op: string;
  description?: string;
  status?: 'ok' | 'error' | 'timeout';
  durationMs: number;
  startTimeMillis: number;
  endTimeMillis: number;
  service?: string;
  environment?: string;
  release?: string;
  sessionId?: string;
  platform?: string;
  /** Numeric metric values, e.g. `{ LCP: 1234.5, CLS: 0.02 }`. */
  measurements: Record<string, number>;
  attributes?: Record<string, unknown>;
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
 * A single database query telemetry record sent (batched) to
 * `/ingest/v1/db`. Matches the backend `DbQueryIngestRequest` item shape used
 * by the other AllStak SDKs: the query text is ALWAYS normalized (literals
 * masked to `?`) before it leaves the SDK so bound values never reach the
 * wire — only the parameterized shape, its hash, and timing/status do.
 */
export interface DbQueryPayload {
  /** Parameterized query text with literals masked (no bound values). */
  normalizedQuery: string;
  /** Stable hash of `normalizedQuery` for dedup/aggregation. */
  queryHash: string;
  /** SELECT / INSERT / UPDATE / DELETE / BEGIN / COMMIT / ROLLBACK / OTHER. */
  queryType: string;
  durationMs: number;
  timestampMillis: number;
  /** `success` | `error`. */
  status: string;
  errorMessage?: string;
  databaseName?: string;
  /** postgresql | mysql | sqlite | mongodb | mssql. */
  databaseType?: string;
  service?: string;
  environment?: string;
  release?: string;
  traceId?: string;
  spanId?: string;
  rowsAffected?: number;
}

/**
 * Severity for a structured log forwarded to `/ingest/v1/logs`. Mirrors the
 * backend `LogIngestRequest` levels used by the other AllStak SDKs.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * A structured log line forwarded to `/ingest/v1/logs`. Matches the backend
 * `LogIngestRequest` DTO shape: top-level routing scalars plus a free-text
 * `message` and an arbitrary `metadata` bag (both scrubbed on the wire path).
 */
export interface LogPayload {
  level: string;
  message: string;
  service?: string;
  traceId?: string;
  environment?: string;
  release?: string;
  spanId?: string;
  requestId?: string;
  userId?: string;
  errorId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Outbound error/message event passed to `beforeSend`. The SDK sanitizes the
 * fully-built payload before invoking the hook, then sanitizes again before
 * persistence/network send. Returning `null` drops it.
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
   * Called once just before an error/message event is sent. The event passed to
   * the hook has already been sanitized. Return the event (optionally mutated)
   * to send it, or `null` to drop it. The returned event is sanitized again
   * before it can be persisted or sent, so hooks cannot reintroduce sensitive
   * values. If the callback throws, the pre-sanitized event is sent. Not called
   * for events already dropped by `sampleRate`.
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
   * Enable release-health session tracking ("one session per
   * process / app-launch"). When true (the default), the client POSTs
   * `/ingest/v1/sessions/start` at init and `/ingest/v1/sessions/end` on
   * graceful shutdown, tracking a local ok/errored/crashed status in between.
   * Sessions are NEVER sampled. Fully fail-open. Set false to opt out.
   * Automatically skipped under a unit-test runtime (NODE_ENV=test / VITEST).
   */
  enableAutoSessionTracking?: boolean;
  /** @internal test/custom persistence seam for abnormal session recovery. */
  sessionStateStore?: SessionStateStore | null;
  /** @internal test/custom key for abnormal session recovery. */
  sessionStateKey?: string;
  /** Git runner seam for deterministic tests; defaults to a guarded spawnSync. */
  gitRunner?: GitRunner;
  /**
   * Persist un-sent telemetry so it survives a process/app restart AND a
   * network outage (offline store). When an event can't be
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
  /**
   * Instrument the global `fetch` to capture OUTBOUND HTTP requests
   * (`direction:'outbound'`) and inject W3C `traceparent` + `baggage` headers on
   * the outbound request so distributed traces survive the first downstream
   * hop. The SDK's own ingest host is always skipped (no recursion). Default
   * true. Set false to opt out. Fully fail-open.
   */
  enableOutboundHttp?: boolean;
  /**
   * Send personally-identifiable information that the SDK would otherwise scrub
   * from free-text VALUES. Default FALSE. The redaction layers:
   *   - ALWAYS scrubbed (regardless of this flag): credit-card numbers that
   *     pass the Luhn checksum and hyphenated US SSNs — high-risk financial /
   *     identity data never legitimately wanted in telemetry.
   *   - Scrubbed only while this is FALSE: email addresses and IPv4/IPv6
   *     addresses that leak into messages / metadata / breadcrumbs / captured
   *     HTTP fields. Set TRUE to let the host opt into shipping that PII (and
   *     to keep any auto-collected client IP the SDK attaches).
   * The EXPLICIT user object set via `setUser` (id/email/ip) is intentional
   * identification and is NEVER value-scrubbed by either layer.
   */
  sendDefaultPii?: boolean;
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
  private readonly sendDefaultPii: boolean;
  private readonly beforeSend?: (event: AllStakNextEvent) => AllStakNextEvent | null;
  private readonly random: () => number;
  private breadcrumbs: Breadcrumb[] = [];
  private destroyed = false;
  private pendingRequests: Promise<void>[] = [];

  private eventsCaptured = 0;
  private eventsSent = 0;
  private eventsFailed = 0;
  private eventsDropped = 0;
  private eventsPersisted = 0;
  private eventsReplayed = 0;
  private retryAttempts = 0;
  private rateLimitedCount = 0;
  private compressedPayloads = 0;
  private uncompressedPayloads = 0;
  private compressionBytesSaved = 0;
  private sessionRecoveryCount = 0;

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
  private readonly sessionStateStore: SessionStateStore | null;
  private readonly sessionStateKey: string;

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
    this.sendDefaultPii = options.sendDefaultPii === true;
    this.beforeSend = options.beforeSend;
    this.random = options.random || Math.random;
    this.platform = detectPlatform();
    this.sessionId = generateSessionId();
    this.sessionTrackingEnabled = shouldAutoSessionTrack(options.enableAutoSessionTracking);
    this.sessionStateKey = options.sessionStateKey ?? sessionStateKey(this.host, this.apiKey, this.release);
    this.sessionStateStore = options.sessionStateStore === undefined
      ? defaultSessionStateStore()
      : options.sessionStateStore;
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
    this.recoverPreviousSession();
    this.sessionStarted = true;
    this.sessionStart = Date.now();
    this.sessionStatus = 'ok';
    const scopeUser = getActiveMergedScope().user;
    const userId = typeof scopeUser?.id === 'string' ? scopeUser.id : undefined;
    this.writeOpenSessionState(userId);
    if (!this.apiKey) return;
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
    this.writeOpenSessionState();
  }

  /**
   * Record an UNHANDLED / fatal crash against the active session (overrides
   * `errored`). No I/O — the status rides the session/end POST. Mirrors the
   * Java `Session.recordCrash`.
   */
  markSessionCrashed(): void {
    this.sessionStatus = 'crashed';
    this.writeOpenSessionState();
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
    const status = finalStatus ?? this.sessionStatus;
    const durationMs = Math.max(0, Date.now() - this.sessionStart);
    this.writeClosedSessionState(status);
    if (!this.apiKey) return;
    const payload = { sessionId: this.sessionId, durationMs, status };
    void this.send('/ingest/v1/sessions/end', payload, SESSION_END_TIMEOUT_MS).catch(() => undefined);
  }

  private recoverPreviousSession(): void {
    const previous = this.readSessionState();
    if (!previous) return;
    const now = Date.now();
    if (previous.closed) {
      this.removeSessionState();
      return;
    }
    if (now - previous.startedAt > SESSION_STATE_MAX_AGE_MS) {
      this.removeSessionState();
      return;
    }
    if ((previous.recoveryAttempts ?? 0) >= SESSION_RECOVERY_MAX_ATTEMPTS) {
      this.removeSessionState();
      return;
    }
    if (previous.recoveryLockUntil && previous.recoveryLockUntil > now) return;

    const owner = generateSessionId();
    const locked: PersistedSessionState = {
      ...previous,
      recoveryAttempts: (previous.recoveryAttempts ?? 0) + 1,
      recoveryLockOwner: owner,
      recoveryLockUntil: now + SESSION_RECOVERY_LOCK_MS,
      updatedAt: now,
    };
    this.writeSessionState(locked);
    if (this.readSessionState()?.recoveryLockOwner !== owner) return;

    const status: SessionStatus = previous.status === 'crashed' ? 'crashed' : 'abnormal';
    try {
      if (this.apiKey) {
        void this.send('/ingest/v1/sessions/end', {
          sessionId: previous.sessionId,
          durationMs: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, (previous.updatedAt || now) - previous.startedAt)),
          status,
        }, SESSION_END_TIMEOUT_MS).catch(() => undefined);
      }
      this.writeSessionState({
        ...locked,
        status,
        closed: true,
        endedAt: now,
        recoveredAt: now,
        recoveryLockUntil: 0,
      });
      this.sessionRecoveryCount += 1;
    } catch {
      this.writeSessionState({ ...locked, recoveryLockUntil: 0 });
    }
  }

  private writeOpenSessionState(userId?: string): void {
    this.writeSessionState({
      version: SESSION_STATE_VERSION,
      sessionId: this.sessionId,
      startedAt: this.sessionStart || Date.now(),
      updatedAt: Date.now(),
      status: this.sessionStatus,
      release: this.release || SDK_VERSION,
      environment: this.environment,
      userId,
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      platform: this.platform,
      closed: false,
    });
  }

  private writeClosedSessionState(status: SessionStatus): void {
    this.writeSessionState({
      version: SESSION_STATE_VERSION,
      sessionId: this.sessionId,
      startedAt: this.sessionStart || Date.now(),
      updatedAt: Date.now(),
      status,
      release: this.release || SDK_VERSION,
      environment: this.environment,
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      platform: this.platform,
      closed: true,
      endedAt: Date.now(),
    });
  }

  private readSessionState(): PersistedSessionState | null {
    if (!this.sessionStateStore) return null;
    try {
      const raw = this.sessionStateStore.getItem(this.sessionStateKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!isPersistedSessionState(parsed)) {
        this.removeSessionState();
        return null;
      }
      return parsed;
    } catch {
      this.removeSessionState();
      return null;
    }
  }

  private writeSessionState(state: PersistedSessionState): void {
    if (!this.sessionStateStore) return;
    try {
      this.sessionStateStore.setItem(this.sessionStateKey, JSON.stringify(state));
    } catch {
      // fail-open
    }
  }

  private removeSessionState(): void {
    if (!this.sessionStateStore) return;
    try {
      this.sessionStateStore.removeItem(this.sessionStateKey);
    } catch {
      // ignore
    }
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
   *   sampleRate drop → pre-hook sanitization → beforeSend → final transport
   *   sanitization.
   * Returns the event to send, or `null` if it was dropped. `beforeSend` is
   * fail-open: a throwing callback yields the already-sanitized event.
   */
  private applyEventPipeline(event: AllStakNextEvent): AllStakNextEvent | null {
    if (this.sampleRate < 1 && this.random() >= this.sampleRate) return null;
    const sanitized = this.sanitizePayload(event) as AllStakNextEvent;
    if (!this.beforeSend) return sanitized;
    try {
      return this.beforeSend(sanitized) ?? null;
    } catch {
      return sanitized; // beforeSend errors must never crash capture
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
    if (this.destroyed || !this.apiKey) {
      this.eventsDropped += 1;
      return;
    }
    this.eventsCaptured += 1;
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
    if (!outbound) {
      this.eventsDropped += 1;
      return;
    }
    await this.send('/ingest/v1/errors', outbound);
  }

  async captureMessage(message: string, level: SeverityLevel = 'info'): Promise<void> {
    if (this.destroyed || !this.apiKey) {
      this.eventsDropped += 1;
      return;
    }
    this.eventsCaptured += 1;
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
    if (!outbound) {
      this.eventsDropped += 1;
      return;
    }
    await this.send('/ingest/v1/errors', outbound);
  }

  async captureSpan(span: SpanPayload): Promise<void> {
    if (this.destroyed || !this.apiKey) {
      this.eventsDropped += 1;
      return;
    }
    this.eventsCaptured += 1;
    await this.send('/ingest/v1/spans', { spans: [span] });
  }

  /**
   * Emit a span carrying a numeric `measurements` map (Core Web Vitals). Filled
   * in here from client state — environment, release, session id, and the
   * detected platform (`browser`/`edge`/`node`) — unless the caller overrode
   * them. Routed through the standard span endpoint and transport (scrub →
   * deliver → persist-on-failure), so vitals reach the web-vitals dashboard.
   */
  async captureWebVital(span: WebVitalSpan): Promise<void> {
    if (this.destroyed || !this.apiKey) {
      this.eventsDropped += 1;
      return;
    }
    this.eventsCaptured += 1;
    await this.send('/ingest/v1/spans', {
      spans: [{
        ...span,
        environment: span.environment ?? this.environment,
        release: span.release ?? this.release,
        sessionId: span.sessionId ?? this.sessionId,
        platform: span.platform ?? this.platform,
      }],
    });
  }

  async captureRequest(request: HttpRequestPayload): Promise<void> {
    if (this.destroyed || !this.apiKey) {
      this.eventsDropped += 1;
      return;
    }
    this.eventsCaptured += 1;
    await this.send('/ingest/v1/http-requests', {
      requests: [{
        ...request,
        environment: request.environment ?? this.environment,
        release: request.release ?? this.release,
      }],
    });
  }

  /**
   * Emit a database-query telemetry record to `/ingest/v1/db`. The query text
   * is expected to be ALREADY normalized by the integration (literals masked
   * to `?`); the transport scrub layer is a second line of defence. Filled in
   * with this client's environment/release when the integration left them
   * blank. Fail-open: never throws into the host query chain.
   */
  async captureDbQuery(query: DbQueryPayload): Promise<void> {
    if (this.destroyed || !this.apiKey) {
      this.eventsDropped += 1;
      return;
    }
    this.eventsCaptured += 1;
    await this.send('/ingest/v1/db', {
      queries: [{
        ...query,
        environment: query.environment ?? this.environment,
        release: query.release ?? this.release,
      }],
    });
  }

  /**
   * Forward a structured log line to `/ingest/v1/logs`. The free-text
   * `message` and the `metadata` bag flow through the standard scrub
   * chokepoint (key-name redaction always; CC/SSN always; email/IP unless
   * `sendDefaultPii`). Filled in with this client's environment/release/session
   * when the caller left them blank. Fail-open.
   */
  async captureLog(log: LogPayload): Promise<void> {
    if (this.destroyed || !this.apiKey) {
      this.eventsDropped += 1;
      return;
    }
    this.eventsCaptured += 1;
    await this.send('/ingest/v1/logs', {
      ...log,
      environment: log.environment ?? this.environment,
      release: log.release ?? this.release,
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
        if (sent) {
          this.eventsSent += 1;
          this.eventsReplayed += 1;
        } else {
          this.eventsFailed += 1;
          survivors.push(env);
        }
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

  /** Detected runtime platform for this client: `browser`, `edge`, or `node`. */
  getPlatform(): string {
    return this.platform;
  }

  /** Normalized ingest host (no trailing slash). Used to skip self-instrumentation. */
  getHost(): string {
    return this.host;
  }

  /** Privacy-safe diagnostics. Contains counters and queue sizes only. */
  getDiagnostics(): SdkDiagnostics {
    return {
      eventsCaptured: this.eventsCaptured,
      eventsSent: this.eventsSent,
      eventsFailed: this.eventsFailed,
      eventsDropped: this.eventsDropped + (this.offlineQueue?.droppedCount() ?? 0),
      eventsPersisted: this.eventsPersisted,
      eventsReplayed: this.eventsReplayed,
      queueSize: this.pendingRequests.length + (this.offlineQueue?.count() ?? 0),
      retryAttempts: this.retryAttempts,
      rateLimitedCount: this.rateLimitedCount,
      compressedPayloads: this.compressedPayloads,
      uncompressedPayloads: this.uncompressedPayloads,
      compressionBytesSaved: this.compressionBytesSaved,
      sanitizerRedactionCount: getSanitizerRedactionCount(),
      activeTraceCount: 0,
      activeSpanCount: 0,
      breadcrumbCount: this.breadcrumbs.length,
      sessionRecoveryCount: this.sessionRecoveryCount,
      disabled: this.destroyed || !this.apiKey,
    };
  }

  private async send(path: string, payload: unknown, timeoutMs: number = TRANSPORT_TIMEOUT_MS): Promise<void> {
    const request = this.doFetch(path, payload, timeoutMs);
    this.pendingRequests.push(request);
    await request;
  }

  /**
   * Scrub a wire payload to its serialized body. One chokepoint protects every
   * telemetry type. Pure (no caller mutation), fail-open on sanitizer error.
   * Restores the SDK's own `sessionId` correlation id — at the top level (errors/
   * messages/sessions) AND on each entry of a `spans[]` envelope (web.vital
   * spans) — that the substring denylist would otherwise redact. The sessionId
   * is the SDK's own session-health correlation id, not user PII.
   */
  private sanitizePayload<T>(payload: T): T | { redacted: true; reason: string } {
    try {
      // Key-name redaction (always) PLUS value-pattern PII scrubbing of
      // free-text string values. (A) CC/SSN always; (B) email/IP unless the
      // host opted into PII via sendDefaultPii. Key-aware: structural fields
      // and the explicit user subtree are preserved (see sanitize.ts).
      const scrubbed = scrub(payload, {
        scrubValues: true,
        sendDefaultPii: this.sendDefaultPii,
      }) as unknown;
      if (
        scrubbed && typeof scrubbed === 'object' &&
        payload && typeof payload === 'object' &&
        typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ) {
        (scrubbed as { sessionId?: unknown }).sessionId = (payload as { sessionId?: unknown }).sessionId;
      }
      restoreSpanSessionIds(payload, scrubbed);
      return scrubbed as T;
    } catch {
      return { redacted: true, reason: 'sanitizer_error' };
    }
  }

  private scrubToBody(payload: unknown): string {
    return JSON.stringify(this.sanitizePayload(payload));
  }

  private async doFetch(path: string, payload: unknown, timeoutMs: number = TRANSPORT_TIMEOUT_MS): Promise<void> {
    // Scrub BEFORE anything touches the wire OR the persistent store — never
    // persist secrets/unredacted data to disk/localStorage.
    const body = this.scrubToBody(payload);
    const outcome = await this.deliver(path, body, timeoutMs);
    // Persist on failure so the event survives a restart/outage. Session
    // lifecycle calls are excluded (handled inside the queue too).
    if (outcome === 'failed' && this.offlineQueue && isPersistablePath(path)) {
      if (this.offlineQueue.persist(path, body)) {
        this.eventsPersisted += 1;
      } else {
        this.eventsDropped += 1;
      }
    } else if (outcome === 'failed' && isPersistablePath(path)) {
      this.eventsDropped += 1;
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
        if (response.status === 429) this.rateLimitedCount += 1;
        const headerValue = response.headers?.get?.('Retry-After') ?? null;
        const waitMs = parseRetryAfter(headerValue, Date.now());
        if (waitMs > 0) {
          this.retryAttempts += 1;
          await new Promise((r) => setTimeout(r, waitMs));
          response = await this.postOnce(path, body, timeoutMs);
        }
      }
      const outcome = classifyResponse(response);
      this.recordDeliveryOutcome(outcome);
      return outcome;
    } catch {
      // Network error / timeout / abort — retry-able, persist it.
      this.eventsFailed += 1;
      return 'failed';
    }
  }

  private recordDeliveryOutcome(outcome: DeliveryOutcome): void {
    if (outcome === 'delivered') this.eventsSent += 1;
    else if (outcome === 'dropped') this.eventsDropped += 1;
    else this.eventsFailed += 1;
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
      else if (outcome === 'delivered') this.eventsReplayed += 1;
    }
    queue.replaceAll(survivors);
  }

  private async postOnce(path: string, body: string, timeoutMs: number = TRANSPORT_TIMEOUT_MS): Promise<Response | undefined> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const prepared = await this.prepareRequestBody(body);
    try {
      return await fetch(`${this.host}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AllStak-Key': this.apiKey,
          ...prepared.headers,
        },
        body: prepared.body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async prepareRequestBody(body: string): Promise<PreparedBody> {
    const rawBytes = byteLength(body);
    if (rawBytes < COMPRESSION_THRESHOLD_BYTES) {
      this.uncompressedPayloads += 1;
      return { body, headers: {} };
    }

    const compressed = await gzipBody(body);
    if (!compressed || compressed.byteLength >= rawBytes) {
      this.uncompressedPayloads += 1;
      return { body, headers: {} };
    }

    this.compressedPayloads += 1;
    this.compressionBytesSaved += rawBytes - compressed.byteLength;
    return {
      body: compressed as unknown as BodyInit,
      headers: { 'Content-Encoding': 'gzip' },
    };
  }
}

interface PreparedBody {
  body: BodyInit;
  headers: Record<string, string>;
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length;
}

async function gzipBody(body: string): Promise<Uint8Array | null> {
  const compressionStream = (globalThis as any).CompressionStream;
  if (typeof compressionStream === 'function' && typeof Blob !== 'undefined' && typeof Response !== 'undefined') {
    try {
      const stream = new Blob([body], { type: 'application/json' })
        .stream()
        .pipeThrough(new compressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // fall through to Node zlib when available
    }
  }

  try {
    const proc = (globalThis as any).process;
    const zlib = proc?.getBuiltinModule?.('node:zlib') ??
      optionalRequire('node:zlib') ??
      optionalRequire('zlib') ??
      (proc?.versions?.node ? await import('node:zlib').catch(() => null) : null);
    const compressed = zlib?.gzipSync?.(body);
    return compressed ? new Uint8Array(compressed) : null;
  } catch {
    return null;
  }
}

function optionalRequire(id: string): any | null {
  try {
    // eslint-disable-next-line no-new-func
    const req = Function('return typeof require === "function" ? require : undefined')();
    return typeof req === 'function' ? req(id) : null;
  } catch {
    return null;
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

/**
 * Re-attach the SDK's own `sessionId` to each entry of a `{ spans: [...] }`
 * envelope after scrubbing. The substring denylist redacts `sessionId`
 * everywhere (it contains "session"), but on a span it is the SDK's session-
 * health correlation id — not user PII — and the backend uses it to attribute
 * the span to a session. Mutates `scrubbed` in place, copying values from the
 * pre-scrub `original`. Fully defensive: any shape mismatch is a no-op.
 */
function restoreSpanSessionIds(original: unknown, scrubbed: unknown): void {
  const origSpans = (original as { spans?: unknown })?.spans;
  const scrubbedSpans = (scrubbed as { spans?: unknown })?.spans;
  if (!Array.isArray(origSpans) || !Array.isArray(scrubbedSpans)) return;
  const len = Math.min(origSpans.length, scrubbedSpans.length);
  for (let i = 0; i < len; i++) {
    const o = origSpans[i] as { sessionId?: unknown } | null;
    const s = scrubbedSpans[i] as { sessionId?: unknown } | null;
    if (o && s && typeof o === 'object' && typeof s === 'object' && typeof o.sessionId === 'string') {
      s.sessionId = o.sessionId;
    }
  }
}

/** Runtime-safe session id (uses crypto.randomUUID when available). */
function generateSessionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function isPersistedSessionState(value: unknown): value is PersistedSessionState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<PersistedSessionState>;
  return (
    s.version === SESSION_STATE_VERSION &&
    typeof s.sessionId === 'string' &&
    s.sessionId.length > 0 &&
    typeof s.startedAt === 'number' &&
    Number.isFinite(s.startedAt) &&
    typeof s.updatedAt === 'number' &&
    Number.isFinite(s.updatedAt) &&
    (s.status === 'ok' || s.status === 'errored' || s.status === 'crashed' || s.status === 'abnormal')
  );
}

function sessionStateKey(host: string, apiKey: string, release: string): string {
  return `${SESSION_STATE_PREFIX}.${stableHash(`${host}|${apiKey}|${release || SDK_VERSION}`)}`;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function defaultSessionStateStore(): SessionStateStore | null {
  try {
    if (!isNodeServer()) return null;
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (env?.NODE_ENV === 'test' || env?.VITEST === 'true') return null;
    const req = typeof require === 'function' ? require : null;
    if (!req) return null;
    const fs = req('node:fs') as typeof import('node:fs');
    const os = req('node:os') as typeof import('node:os');
    const path = req('node:path') as typeof import('node:path');
    const dir = path.join(os.tmpdir(), 'allstak-next-session-state');
    const fileFor = (key: string) => path.join(dir, `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
    return {
      getItem(key: string) {
        try {
          const file = fileFor(key);
          return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        } catch {
          return null;
        }
      },
      setItem(key: string, value: string) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fileFor(key), value);
        } catch {
          // ignore
        }
      },
      removeItem(key: string) {
        try {
          const file = fileFor(key);
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch {
          // ignore
        }
      },
    };
  } catch {
    return null;
  }
}

declare const require: undefined | ((id: string) => any);

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
