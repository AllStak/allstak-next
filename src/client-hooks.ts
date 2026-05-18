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

  // Return a teardown function
  return () => {
    window.onerror = prevOnError;
    window.onunhandledrejection = prevOnUnhandledRejection;
  };
}
