# Changelog

All notable changes to @allstak/next will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]## [0.2.0] — 2026-05-29

Substantial feature wave on top of published `0.1.2`, reaching broad
Sentry-style parity for the standalone Next.js SDK. Fully additive and
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
- Event `369961a0-1e47-43db-bf81-59407a728af2` against `api.allstak.sa`.
  ClickHouse `leak_pos = 0` across `metadata` / `stack_trace` /
  `breadcrumbs` / `message`. Canary planted in 11 sensitive fields +
  3-level-nested `token` — all scrubbed.

### Tests
- 57/57 pass (was 48; +9 sanitizer cases incl. canary leak assert).

## [0.1.0] - 2026-04-25

### Added
- Initial public release.
