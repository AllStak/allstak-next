/**
 * Auto-running CLIENT bootstrap for @allstak/next.
 *
 * This module wires the full browser instrumentation surface from
 * `NEXT_PUBLIC_*` environment variables with ZERO per-call developer code.
 * Two ways it runs:
 *
 *   1. Next.js App Router auto-loads a root `instrumentation-client.ts` in the
 *      browser. Re-export this and you're done:
 *
 *      ```ts
 *      // instrumentation-client.ts  (project root)
 *      export * from '@allstak/next/client';
 *      ```
 *
 *   2. `withAllStak()` can inject a generated client entry that imports this,
 *      so even apps that don't add the file get the browser bootstrap.
 *
 * On the browser it: registers a client (if `NEXT_PUBLIC_ALLSTAK_API_KEY` is
 * present and none exists yet), installs global error handlers, Core Web
 * Vitals, the outbound-fetch trace wrapper, the auto-breadcrumb collectors, and
 * the console→log bridge. Everything is default-ON, individually toggleable via
 * env vars, and fully fail-open. A no-op on the server/edge — importing it
 * there does nothing.
 *
 * Toggle env vars (set to `'false'` to opt out):
 *   NEXT_PUBLIC_ALLSTAK_API_KEY        — project API key (required to start)
 *   NEXT_PUBLIC_ALLSTAK_HOST           — ingest host (default https://api.allstak.sa)
 *   NEXT_PUBLIC_ALLSTAK_ENVIRONMENT    — environment label
 *   NEXT_PUBLIC_ALLSTAK_RELEASE        — release/version
 *   NEXT_PUBLIC_ALLSTAK_WEB_VITALS     — Core Web Vitals collection
 *   NEXT_PUBLIC_ALLSTAK_OUTBOUND_HTTP  — outbound fetch trace wrapper
 *   NEXT_PUBLIC_ALLSTAK_BREADCRUMBS    — auto-breadcrumb collectors
 *   NEXT_PUBLIC_ALLSTAK_CONSOLE_LOGS   — console→/ingest/v1/logs bridge
 *   NEXT_PUBLIC_ALLSTAK_SEND_PII       — sendDefaultPii
 */

import { AllStakNextClient, getClient, setClient } from './client';
import { installGlobalErrorHandlers } from './client-hooks';
import { instrumentFetch } from './fetch-instrumentation';

export interface ClientBootstrapOptions {
  apiKey?: string;
  host?: string;
  environment?: string;
  release?: string;
  /** Collect Core Web Vitals. Default true. */
  enableWebVitals?: boolean;
  /** Instrument outbound fetch (trace propagation + capture). Default true. */
  enableOutboundHttp?: boolean;
  /** Install console/navigation/fetch breadcrumb collectors. Default true. */
  enableAutoBreadcrumbs?: boolean;
  /** Bridge `console.*` to `/ingest/v1/logs`. Default true. */
  enableConsoleLogs?: boolean;
  /** Ship email/IP PII in free-text values. Default false. */
  sendDefaultPii?: boolean;
}

let booted = false;

/**
 * Whether the browser bootstrap has already run (module auto-runs once).
 * @internal also used by tests.
 */
export function isClientBootstrapped(): boolean {
  return booted;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function env(name: string): string | undefined {
  try {
    const e = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const v = e?.[name];
    return v != null && v !== '' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `'false'`/`'0'`/`'off'` → false; anything else (incl. undefined) → the default. */
function flag(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v == null) return fallback;
  const lower = v.toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no') return false;
  if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'yes') return true;
  return fallback;
}

/** Read the bootstrap options from `NEXT_PUBLIC_*` env. */
function optionsFromEnv(): ClientBootstrapOptions {
  return {
    apiKey: env('NEXT_PUBLIC_ALLSTAK_API_KEY'),
    host: env('NEXT_PUBLIC_ALLSTAK_HOST'),
    environment: env('NEXT_PUBLIC_ALLSTAK_ENVIRONMENT') ?? env('NODE_ENV'),
    release: env('NEXT_PUBLIC_ALLSTAK_RELEASE'),
    enableWebVitals: flag('NEXT_PUBLIC_ALLSTAK_WEB_VITALS', true),
    enableOutboundHttp: flag('NEXT_PUBLIC_ALLSTAK_OUTBOUND_HTTP', true),
    enableAutoBreadcrumbs: flag('NEXT_PUBLIC_ALLSTAK_BREADCRUMBS', true),
    enableConsoleLogs: flag('NEXT_PUBLIC_ALLSTAK_CONSOLE_LOGS', true),
    sendDefaultPii: flag('NEXT_PUBLIC_ALLSTAK_SEND_PII', false),
  };
}

/**
 * Run the browser bootstrap explicitly with overrides. Merges over the
 * `NEXT_PUBLIC_*` env defaults. Idempotent (a second call is a no-op once
 * booted). No-op on the server/edge. Fully fail-open. Returns a teardown.
 */
export function bootstrapAllStakClient(overrides: ClientBootstrapOptions = {}): () => void {
  if (!isBrowser() || booted) return () => {};
  booted = true;

  const opts: ClientBootstrapOptions = { ...optionsFromEnv(), ...overrides };
  const teardowns: Array<() => void> = [];

  try {
    // Register a client if the host hasn't already (e.g. via initAllStakNext).
    const existing = getClient();
    if ((!existing || existing.isDestroyed()) && opts.apiKey) {
      setClient(
        new AllStakNextClient({
          apiKey: opts.apiKey,
          host: opts.host,
          environment: opts.environment,
          release: opts.release,
          sendDefaultPii: opts.sendDefaultPii,
          // The browser bootstrap installs the fetch wrapper itself below.
          enableOutboundHttp: false,
        }),
      );
    }
  } catch {
    // fail-open
  }

  // Global error handlers (window.onerror / onunhandledrejection) + session end
  // hook. installGlobalErrorHandlers owns Core Web Vitals, the auto-breadcrumb
  // collectors, and the console→logs bridge, so we thread the bootstrap toggles
  // through it (avoiding a double-install) rather than wiring them separately.
  safe(teardowns, () =>
    installGlobalErrorHandlers({
      enableWebVitals: opts.enableWebVitals,
      enableAutoBreadcrumbs: opts.enableAutoBreadcrumbs,
      enableConsoleLogs: opts.enableConsoleLogs,
    }),
  );

  // Outbound fetch trace wrapper is independent of the error handlers.
  if (opts.enableOutboundHttp !== false) safe(teardowns, () => instrumentFetch());

  return () => {
    for (const t of teardowns) {
      try {
        t();
      } catch {
        // fail-open
      }
    }
  };
}

function safe(teardowns: Array<() => void>, install: () => () => void): void {
  try {
    teardowns.push(install());
  } catch {
    // fail-open
  }
}

/** @internal test seam: reset the once-only boot guard. */
export function _resetClientBootstrapForTest(): void {
  booted = false;
}

// ── Auto-run on import in the browser ──────────────────────────────────────────
// Importing this module from a client entry (instrumentation-client.ts or the
// withAllStak() injected entry) is enough — no function call required.
if (isBrowser()) {
  try {
    bootstrapAllStakClient();
  } catch {
    // fail-open: a bootstrap failure must never break the host page.
  }
}
