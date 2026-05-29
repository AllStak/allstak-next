import { getClient } from './client';

/**
 * Core Web Vitals collection for the browser bundle.
 *
 * Vitals are ingested AS SPANS via `POST /ingest/v1/spans` with `op="web.vital"`
 * (the backend `PerformanceRepository` classifies that op into the "web"
 * category and persists the `measurements` column to ClickHouse — that is how
 * vitals reach the web-vitals dashboard). We collect LCP/CLS/INP/FCP/TTFB with
 * `PerformanceObserver` directly (no `web-vitals` dependency), finalize on the
 * standard reporting moment — `visibilitychange('hidden')` / `pagehide` — and
 * emit a single `web.vital` span. Everything is best-effort and fully fail-open:
 * a missing API, an unsupported entry type, or a throwing observer never affects
 * the host page.
 *
 * Two collection paths feed the same span:
 *   1. {@link initWebVitals} — automatic `PerformanceObserver` collection.
 *   2. {@link reportWebVitals} — Next's official `useReportWebVitals` /
 *      `pages/_app reportWebVitals` hook, accepting Next's `{ name, value, id }`
 *      metric shape.
 */

/** Metric names the SDK collects, mirroring the wire contract. */
export type WebVitalName = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';

/** Next's `useReportWebVitals` / `reportWebVitals` metric shape. */
export interface NextWebVitalsMetric {
  name: string;
  value: number;
  id?: string;
  label?: string;
  startTime?: number;
  [key: string]: unknown;
}

const VITAL_NAMES: readonly WebVitalName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];

interface VitalsState {
  measurements: Partial<Record<WebVitalName, number>>;
  observers: PerformanceObserver[];
  removeListeners: (() => void) | null;
  /** Guards against a double-send across pagehide + visibilitychange. */
  reported: boolean;
  /** Whether automatic collection has been installed. */
  installed: boolean;
}

let state: VitalsState | null = null;

function freshState(): VitalsState {
  return {
    measurements: {},
    observers: [],
    removeListeners: null,
    reported: false,
    installed: false,
  };
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/** Record a metric, keeping the most representative value per the web-vitals rules. */
function record(name: WebVitalName, value: number): void {
  if (!state || !Number.isFinite(value) || value < 0) return;
  if (name === 'CLS' || name === 'INP') {
    // CLS accumulates; INP keeps the worst (largest) interaction latency.
    const prev = state.measurements[name];
    state.measurements[name] = prev === undefined ? value : Math.max(prev, value);
  } else {
    // LCP/FCP/TTFB: last-write-wins (LCP's last entry is the largest; FCP/TTFB
    // are single-shot).
    state.measurements[name] = value;
  }
}

/** Set CLS to an absolute accumulated total (layout-shift is summed, not maxed). */
function setCls(total: number): void {
  if (!state || !Number.isFinite(total) || total < 0) return;
  state.measurements.CLS = total;
}

/**
 * Subscribe to a PerformanceObserver entry type, fully fail-open. Returns the
 * observer (added to state) or null when the type is unsupported.
 */
function observe(
  type: string,
  callback: (entries: PerformanceEntry[]) => void,
  opts: PerformanceObserverInit = {},
): PerformanceObserver | null {
  const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (typeof PO !== 'function') return null;
  try {
    const observer = new PO((list) => {
      try {
        callback(list.getEntries());
      } catch {
        // fail-open
      }
    });
    observer.observe({ type, buffered: true, ...opts });
    state?.observers.push(observer);
    return observer;
  } catch {
    // Unsupported entry type (older browsers) — ignore.
    return null;
  }
}

/** Read TTFB + FCP from navigation/paint timing (works without observers too). */
function collectNavigationTiming(): void {
  try {
    const perf = (globalThis as { performance?: Performance }).performance;
    if (!perf?.getEntriesByType) return;

    // TTFB = responseStart from the navigation timing entry.
    const nav = perf.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav && typeof nav.responseStart === 'number' && nav.responseStart > 0) {
      record('TTFB', nav.responseStart);
    }

    // FCP from the paint timing buffer.
    const fcp = perf.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
    if (fcp && typeof fcp.startTime === 'number' && fcp.startTime > 0) {
      record('FCP', fcp.startTime);
    }
  } catch {
    // fail-open
  }
}

/** Install the PerformanceObserver collectors. Idempotent + fail-open. */
function installObservers(): void {
  // LCP — keep the last (largest) largest-contentful-paint entry.
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1] as (PerformanceEntry & { startTime: number }) | undefined;
    if (last) record('LCP', last.startTime);
  });

  // CLS — sum layout-shift values that did NOT have recent user input.
  let clsTotal = 0;
  observe('layout-shift', (entries) => {
    for (const entry of entries as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) {
      if (!entry.hadRecentInput && typeof entry.value === 'number') clsTotal += entry.value;
    }
    setCls(clsTotal);
  });

  // INP / FID — interaction latency from event-timing entries (largest wins).
  observe(
    'event',
    (entries) => {
      for (const entry of entries as Array<PerformanceEntry & { duration: number; interactionId?: number }>) {
        // Only entries tied to a discrete user interaction count toward INP.
        if (entry.interactionId && entry.duration > 0) record('INP', entry.duration);
      }
    },
    { durationThreshold: 40 } as PerformanceObserverInit,
  );

  // First-input fallback for browsers without event-timing interactionId (FID).
  observe('first-input', (entries) => {
    const first = entries[0] as (PerformanceEntry & { processingStart?: number; startTime: number }) | undefined;
    if (first && typeof first.processingStart === 'number') {
      const fid = first.processingStart - first.startTime;
      if (fid >= 0) record('INP', fid);
    }
  });

  // Paint timing (FCP) via observer too, so it lands even before navigation read.
  observe('paint', (entries) => {
    for (const entry of entries) {
      if (entry.name === 'first-contentful-paint') record('FCP', entry.startTime);
    }
  });
}

/**
 * Build and emit a single `web.vital` span from whatever has been collected.
 * No-op when there is nothing to report or no client. Guarded so it sends at
 * most once. Returns true when a span was emitted.
 */
function finalizeAndSend(): boolean {
  if (!state || state.reported) return false;

  // Pull a last-moment read of navigation/paint timing in case the observers
  // never fired (very fast loads, disabled observers).
  collectNavigationTiming();

  const measurements: Record<string, number> = {};
  for (const name of VITAL_NAMES) {
    const value = state.measurements[name];
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Round CLS to a sane precision; the rest are ms.
      measurements[name] = name === 'CLS' ? Math.round(value * 10000) / 10000 : Math.round(value);
    }
  }
  if (Object.keys(measurements).length === 0) return false;

  const client = getClient();
  if (!client || client.isDestroyed()) return false;

  state.reported = true;
  const now = Date.now();
  try {
    void client.captureWebVital({
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      operation: 'web.vital',
      op: 'web.vital',
      description: 'Core Web Vitals',
      status: 'ok',
      durationMs: 0,
      startTimeMillis: now,
      endTimeMillis: now,
      service: 'nextjs',
      // platform is filled by the client from detectPlatform() ('browser').
      measurements,
      attributes: { url: currentUrl() },
    }).catch(() => undefined);
  } catch {
    // fail-open
  }
  return true;
}

function currentUrl(): string {
  try {
    return (globalThis as { location?: { href?: string } }).location?.href ?? '';
  } catch {
    return '';
  }
}

/**
 * Begin automatic Core Web Vitals collection in the browser. Installs the
 * PerformanceObservers and finalizes/emits one `web.vital` span on the standard
 * reporting moment (`visibilitychange('hidden')` / `pagehide`). Idempotent and
 * fully fail-open. No-op outside the browser. Returns a teardown that removes
 * the observers/listeners.
 */
export function initWebVitals(): () => void {
  if (!isBrowser()) return () => {};
  if (state?.installed) return () => teardown();

  state = freshState();
  state.installed = true;

  try {
    installObservers();
    // Seed from already-buffered navigation/paint timing immediately.
    collectNavigationTiming();
  } catch {
    // fail-open
  }

  const onHidden = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      finalizeAndSend();
    }
  };
  const onPageHide = () => {
    finalizeAndSend();
  };

  try {
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
  } catch {
    // fail-open
  }

  state.removeListeners = () => {
    try {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
    } catch {
      // fail-open
    }
  };

  return () => teardown();
}

function teardown(): void {
  if (!state) return;
  for (const obs of state.observers) {
    try {
      obs.disconnect();
    } catch {
      // fail-open
    }
  }
  state.removeListeners?.();
  state = null;
}

/**
 * Wire Next's official web-vitals hook into AllStak. Accepts Next's
 * `{ name, value, id }` metric shape and records it into the same `web.vital`
 * span as automatic collection, so both paths feed one stream.
 *
 * ```tsx
 * // app/ (App Router)
 * 'use client';
 * import { useReportWebVitals } from 'next/web-vitals';
 * import { reportWebVitals } from '@allstak/next';
 * export function WebVitals() {
 *   useReportWebVitals(reportWebVitals);
 *   return null;
 * }
 * ```
 * ```ts
 * // pages/_app (Pages Router)
 * export { reportWebVitals } from '@allstak/next';
 * ```
 */
export function reportWebVitals(metric: NextWebVitalsMetric): void {
  if (!isBrowser()) return;
  try {
    if (!metric || typeof metric.name !== 'string' || typeof metric.value !== 'number') return;
    const name = normalizeVitalName(metric.name);
    if (!name) return;

    // Ensure collection is running so the value has somewhere to land and a
    // reporting hook is registered, even if initWebVitals was not called.
    if (!state) initWebVitals();

    if (name === 'CLS') {
      // Next reports CLS as the absolute accumulated value, not a delta.
      setCls(metric.value);
    } else {
      record(name, metric.value);
    }
  } catch {
    // fail-open
  }
}

/** Map a Next/web-vitals metric name to our canonical vital name, or null. */
function normalizeVitalName(raw: string): WebVitalName | null {
  const upper = raw.toUpperCase();
  // Treat FID as INP's first-input fallback so legacy metrics still land.
  if (upper === 'FID') return 'INP';
  return (VITAL_NAMES as readonly string[]).includes(upper) ? (upper as WebVitalName) : null;
}

function generateTraceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function generateSpanId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/** @internal test seam: force a finalize+send and report whether a span went out. */
export function _finalizeWebVitalsForTest(): boolean {
  return finalizeAndSend();
}

/** @internal test seam: tear down all observers/listeners and reset state. */
export function _resetWebVitalsForTest(): void {
  teardown();
}

/** @internal test seam: snapshot the currently-collected measurements. */
export function _getWebVitalsMeasurementsForTest(): Partial<Record<WebVitalName, number>> {
  return state ? { ...state.measurements } : {};
}
