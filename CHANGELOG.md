# Changelog

All notable changes to @allstak/next will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
