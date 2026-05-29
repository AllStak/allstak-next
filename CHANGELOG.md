# Changelog

All notable changes to @allstak/next will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-05-30

Auto-instrumentation wave: makes database capture, structured logs, and the
browser breadcrumb trail / client bootstrap AUTOMATIC. Fully additive and
backward-compatible — no public API removed and existing behavior preserved.
Every new collector is default-ON and individually toggleable.

### Added — Database query auto-instrumentation
- `src/db-instrumentation.ts`: opt-in-by-default driver wrappers wired from
  `registerAllStak` when the module resolves. `pg` (`Client.prototype.query`,
  covering Pool + prepared/named queries + transactions) is auto-patched;
  `instrumentPrisma(client)` (via `$on('query')`) and `allstakDrizzleLogger()`
  (Drizzle `logger` hook) cover the ORMs that need a live instance. Queries are
  NORMALIZED — string/numeric literals masked to `?` — before they leave the
  SDK (bound values never reach the wire) and emitted to `/ingest/v1/db`.
  Gated by `enableDbInstrumentation` (default true). Node-server only; fully
  fail-open.

### Added — Logs bridge
- `src/logs.ts`: forwards structured logs to `/ingest/v1/logs`. `logToAllStak`
  primitive, a default-ON `console.{debug,info,warn,error}` bridge
  (`installConsoleLogBridge`, wired from `registerAllStak` server-side and the
  browser bootstrap), a pino destination stream (`allstakPinoStream`), and a
  winston transport (`allstakWinstonTransport`, optional peer). `error`/`fatal`
  logs carrying an `Error` are promoted to `captureException`; warn/error/fatal
  add a breadcrumb. Message + metadata flow through the existing scrub
  chokepoint. Gated by `enableConsoleLogs` (default true). Fully fail-open.

### Added — Auto breadcrumbs + client bootstrap
- `src/breadcrumbs.ts`: console / navigation (History API + popstate) / fetch
  breadcrumb collectors that record onto the active scope, so any error
  captured afterwards carries recent context automatically. Default-ON in the
  browser (`installGlobalErrorHandlers` + the client bootstrap); gated by
  `enableAutoBreadcrumbs`.
- `src/instrumentation-client.ts` (`@allstak/next/client` subpath): an
  auto-running browser bootstrap from `NEXT_PUBLIC_*` env — registers a client
  and installs global error handlers, Core Web Vitals, the outbound-fetch
  tracer, auto-breadcrumbs, and the console→log bridge with no manual call.
  Re-export it from a root `instrumentation-client.ts`, or let `withAllStak()`
  inject the client entry into the browser bundle (default on,
  `clientBootstrap: false` to opt out).

### Tests
- Build + DTS green; new `typecheck` script (`tsconfig.build.json`, src-only).
  229/229 tests pass (22 files), up from 189 (+40 across db / logs /
  breadcrumbs / client-bootstrap / entry-injection).

## [0.2.0] — 2026-05-29

Substantial feature wave on top of published `0.1.2`, reaching broad
standard parity for the standalone Next.js SDK. Fully additive and
backward-compatible — no public API removed and existing behavior preserved.

### Added — Release-health session tracking
- Session lifecycle (start/end) posted to `/ingest/v1/sessions/*` with
  crash-free signal, wired through `client-hooks` / `instrumentation` so
  sessions begin on init and end on shutdown.

### Added — Offline / persistent transport queue
- `OfflineQueue` + pluggable `PersistenceAdapter` (browser `localStorage`,
  Node `fs` spool under `os.tmpdir()`, in-memory edge/sandbox degrade) with
  `setPersistenceAdapter()` for RN/custom embedders.
- Un-sent, PII-scrubbed telemetry is persisted on delivery failure (network
  error, retries exhausted, offline, or shutdown-with-buffer) and replayed on
  next init. Scrub happens BEFORE persist; session lifecycle calls are excluded
  to avoid skewed durations. Bounded by count/bytes/age (drop oldest); drains
  on init, fully fail-open and async.

### Added — Value-pattern PII scrubbing + `sendDefaultPii`
- Value-pattern scrubbing layered on the existing key-name denylist: always
  scrubs Luhn-valid credit-card numbers and hyphenated US SSNs; scrubs
  email + IPv4/IPv6 unless `sendDefaultPii === true` (defaults to `false`).
- Key-aware: stack frame paths, release/SDK fields, URLs/paths, span/operation
  names, the SDK `sessionId`, and the explicit `setUser` subtree are never
  touched. Wired into the single `scrubToBody` chokepoint; fail-open; regexes
  compiled once with a max-scan-length cap.

### Added — Core Web Vitals spans
- `src/web-vitals.ts` collects LCP/CLS/INP/FCP/TTFB via `PerformanceObserver`
  (no new dependency); emitted once as `web.vital` spans to
  `/ingest/v1/spans` on `visibilitychange('hidden')`/`pagehide` with a
  double-send guard. `reportWebVitals(metric)` helper accepts Next's
  `{name,value,id}` shape (FID maps onto INP). Gated by `enableWebVitals`
  (default true in browser).

### Added — Outbound HTTP instrumentation
- `src/fetch-instrumentation.ts` wraps global `fetch` (node server + edge +
  browser): emits `direction:'outbound'` `HttpRequestPayload` to
  `/ingest/v1/http-requests` and injects W3C `traceparent` + `baggage`,
  continuing an upstream `traceparent` when present. Skips the SDK's own
  ingest host (no recursion); idempotent install/uninstall; gated by
  `enableOutboundHttp` (default true).

### Added — Manual capture + scope API
- Module-level `captureException`, `captureMessage`, `setUser`, `setTag(s)`,
  `setExtra(s)`, `setContext`, `addBreadcrumb`, `withScope`, `configureScope`,
  `runWithRequestScope` backed by an `AsyncLocalStorage` `ScopeManager`.
  Route-handler / server-action wrappers run inside `runInRequestScope` for
  per-request isolation; the active scope merges onto every event.

### Added — Runtime release auto-detection
- Resolves event `release` with a documented priority: explicit config > env
  vars (`ALLSTAK_RELEASE`, `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`,
  `RENDER_GIT_COMMIT`, `GIT_COMMIT`, `GIT_SHA`, `SOURCE_VERSION`) > local git
  (`git describe --tags --always --dirty`) > SDK version. Server-only,
  guarded optional require (edge/browser safe), cached. Opt out via
  `autoDetectRelease: false`. Runtime releases are auto-registered.

### Added — `beforeSend` + `sampleRate`
- `sampleRate` (0..1, default 1) deterministic drop at capture, applied before
  `beforeSend(event) => event | null`. Fail-open; injectable RNG for tests.

### Fixed
- Transport now honors the `Retry-After` header on `429`/`503` (delta-seconds
  or HTTP-date, clamped to 300000ms), retrying the POST exactly once; exported
  pure `parseRetryAfter()` helper. All other responses keep fail-open no-retry.

### Tests
- Build green; 189/189 tests pass (18 files), up from 57.

## [0.1.1] — 2026-05-18

### Consolidation
Lands the full SDK source on the canonical AllStak repo. Prior `0.1.0`
publish was built from local source files that never made it to git;
this commit reconciles `AllStak/allstak-next` with what's actually in
the published npm package. No public API change.

### Added — Recursive payload sanitizer
- New `src/sanitize.ts` — 25-term canonical denylist, recursive over
  plain objects + arrays, `[REDACTED]` substitution, `WeakSet` cycle
  protection. Pure (no caller mutation).
- Wired into `AllStakNextClient.doFetch` so every wire payload is
  scrubbed before `JSON.stringify`. Fail-open.

### Live canary E2E
- End-to-end canary event sent against `api.allstak.sa`. Ingest-side
  inspection found `leak_pos = 0` across `metadata` / `stack_trace` /
  `breadcrumbs` / `message`. Canary planted in 11 sensitive fields +
  3-level-nested `token` — all scrubbed.

### Tests
- 57/57 pass (was 48; +9 sanitizer cases incl. canary leak assert).

## [0.1.0] - 2026-04-25

### Added
- Initial public release.
