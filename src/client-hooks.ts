import { getClient } from './client';

/**
 * Install global browser error handlers that forward to the AllStak client.
 *
 * Chains any previously-installed `window.onerror` and
 * `window.onunhandledrejection` handlers so existing behaviour is preserved.
 *
 * ```tsx
 * // app/layout.tsx  (client component wrapper)
 * 'use client';
 * import { installGlobalErrorHandlers } from '@allstak/next';
 * if (typeof window !== 'undefined') installGlobalErrorHandlers();
 * ```
 */
export function installGlobalErrorHandlers(): () => void {
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

  // Return a teardown function
  return () => {
    window.onerror = prevOnError;
    window.onunhandledrejection = prevOnUnhandledRejection;
    removeSessionHooks();
  };
}

/**
 * End the release-health session when the page is going away. `pagehide` is the
 * reliable browser signal for app-launch teardown (it fires on bfcache, tab
 * close, and navigation away where `unload` is unreliable). `endSession` is
 * idempotent and best-effort, so firing on both `pagehide` and a `hidden`
 * visibility change is safe. Returns a teardown that removes the listeners.
 */
function installSessionEndHook(): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const end = () => {
    try {
      getClient()?.endSession();
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
