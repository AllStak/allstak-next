import { getClient } from './client';
import { initWebVitals } from './web-vitals';
import { installAutoBreadcrumbs } from './breadcrumbs';
import { installConsoleLogBridge } from './logs';

export interface GlobalErrorHandlerOptions {
  /**
   * Collect Core Web Vitals (LCP/CLS/INP/FCP/TTFB) via PerformanceObserver and
   * emit them as `web.vital` spans. Default TRUE in the browser. Set false to
   * opt out (e.g. if you wire Next's `useReportWebVitals` + `reportWebVitals`
   * manually and don't want the automatic observers as well).
   */
  enableWebVitals?: boolean;
  /**
   * Install the console/navigation/fetch breadcrumb collectors so any error
   * captured afterwards carries recent activity context automatically. Default
   * TRUE in the browser. Set false to opt out.
   */
  enableAutoBreadcrumbs?: boolean;
  /**
   * Bridge `console.{debug,info,warn,error}` to `/ingest/v1/logs` (error+Error
   * promoted to captureException). The original console output is always
   * preserved. Default TRUE in the browser. Set false to opt out.
   */
  enableConsoleLogs?: boolean;
}

/**
 * Install global browser error handlers that forward to the AllStak client.
 *
 * Chains any previously-installed `window.onerror` and
 * `window.onunhandledrejection` handlers so existing behaviour is preserved.
 * Also starts Core Web Vitals collection by default (set
 * `enableWebVitals: false` to opt out).
 *
 * ```tsx
 * // app/layout.tsx  (client component wrapper)
 * 'use client';
 * import { installGlobalErrorHandlers } from '@allstak/next';
 * if (typeof window !== 'undefined') installGlobalErrorHandlers();
 * ```
 */
export function installGlobalErrorHandlers(options: GlobalErrorHandlerOptions = {}): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const prevOnError = window.onerror;
  const prevOnUnhandledRejection = window.onunhandledrejection;

  window.onerror = (
    message: string | Event,
    source?: string,
    lineno?: number,
    colno?: number,
    error?: Error,
  ) => {
    try {
      const client = getClient();
      if (client) {
        const err = error || new Error(typeof message === 'string' ? message : 'Unknown error');
        client.captureException(err, {
          mechanism: 'window.onerror',
          source,
          lineno,
          colno,
        });
      }
    } catch {
      // fail-open
    }

    if (typeof prevOnError === 'function') {
      return prevOnError.call(window, message, source, lineno, colno, error);
    }
    return false;
  };

  window.onunhandledrejection = (event: PromiseRejectionEvent) => {
    try {
      const client = getClient();
      if (client) {
        const error =
          event.reason instanceof Error
            ? event.reason
            : new Error(String(event.reason));
        client.captureException(error, {
          mechanism: 'window.onunhandledrejection',
        });
      }
    } catch {
      // fail-open
    }

    if (typeof prevOnUnhandledRejection === 'function') {
      prevOnUnhandledRejection.call(window, event);
    }
  };

  const removeSessionHooks = installSessionEndHook();

  // Core Web Vitals: default ON in the browser. Fully fail-open — collection
  // never affects the host page, and emission happens on pagehide/hidden.
  const teardownWebVitals = options.enableWebVitals === false ? () => {} : installWebVitalsHook();

  // Auto-breadcrumbs (console/navigation/fetch): default ON so browser errors
  // captured here carry recent activity context with no manual addBreadcrumb.
  const teardownBreadcrumbs = options.enableAutoBreadcrumbs === false ? () => {} : safeInstall(installAutoBreadcrumbs);

  // Console→logs bridge: default ON so browser `console.*` calls become
  // structured logs (error+Error promoted to an event). Host output preserved.
  const teardownConsoleLogs = options.enableConsoleLogs === false ? () => {} : safeInstall(installConsoleLogBridge);

  // Return a teardown function
  return () => {
    window.onerror = prevOnError;
    window.onunhandledrejection = prevOnUnhandledRejection;
    removeSessionHooks();
    teardownWebVitals();
    teardownBreadcrumbs();
    teardownConsoleLogs();
  };
}

/** Install a browser collector, never throwing into the host install. */
function safeInstall(install: () => () => void): () => void {
  try {
    return install();
  } catch {
    return () => {};
  }
}

/** Start Core Web Vitals collection, never throwing into the host install. */
function installWebVitalsHook(): () => void {
  try {
    return initWebVitals();
  } catch {
    return () => {};
  }
}

/**
 * End the release-health session when the page is going away, and flush any
 * persisted (failed/buffered) telemetry via `navigator.sendBeacon` so in-flight
 * events are not lost on tab close. `pagehide` is the reliable browser signal
 * for app-launch teardown (it fires on bfcache, tab close, and navigation away
 * where `unload` is unreliable). Both `endSession` and the beacon flush are
 * idempotent and best-effort, so firing on both `pagehide` and a `hidden`
 * visibility change is safe. Returns a teardown that removes the listeners.
 */
function installSessionEndHook(): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const end = () => {
    try {
      const client = getClient();
      // Beacon-flush persisted telemetry BEFORE ending the session: beacon
      // requests outlive the page, so this is the last chance to ship buffered
      // events that a plain fetch would drop on tab close.
      client?.flushViaBeacon();
      client?.endSession();
    } catch {
      // fail-open
    }
  };
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') end();
  };
  window.addEventListener('pagehide', end);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    window.removeEventListener('pagehide', end);
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}
