import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Re-exports from the consolidated client/middleware/integration surface ──
// Restores the public API that shipped on @allstak/next@0.1.0; the
// short-circuit publish of 0.1.1 missed these because index.ts didn't
// re-export from the freshly-tracked source files.
import { AllStakNextClient, getClient, setClient, type AllStakNextEvent, type SeverityLevel, type LogLevel, type SdkDiagnostics } from './client';
import {
  Scope,
  scopeManager,
  type ScopeUser,
  type ScopeBreadcrumb,
} from './scope';
import { initWebVitals } from './web-vitals';
import { instrumentFetch } from './fetch-instrumentation';
import { installAutoBreadcrumbs, type BeforeBreadcrumb } from './breadcrumbs';
import { installConsoleLogBridge, logToAllStak } from './logs';

export {
  AllStakNextClient,
  getClient,
  setClient,
  parseStack,
  formatFrames,
  parseRetryAfter,
  type AllStakNextClientOptions,
  type AllStakNextEvent,
  type Breadcrumb,
  type BreadcrumbType,
  type BreadcrumbCategory,
  type ErrorPayload,
  type SeverityLevel,
  type SessionStatus,
  type StackFrame,
  type DebugImage,
  type DbQueryPayload,
  type LogLevel,
  type LogPayload,
  type SdkDiagnostics,
  _resetRuntimeReleaseRegistrationForTest,
} from './client';
export { Scope } from './scope';
export type { ScopeUser, ScopeBreadcrumb, Severity, MergedScopeData } from './scope';
export { resolveDebugId, _resetDebugIdCache } from './utils/debug-id';
export {
  resolveRelease,
  resolveGitRelease,
  detectReleaseFromEnv,
  isNodeServerRuntime,
  defaultGitRunner,
  RELEASE_ENV_VARS,
  _resetReleaseCache,
  type GitRunner,
  type ResolveReleaseOptions,
} from './release';
export {
  OfflineQueue,
  setPersistenceAdapter,
  isPersistablePath,
  BROWSER_LIMITS,
  SERVER_LIMITS,
  type PersistenceAdapter,
  type PersistedEnvelope,
  type OfflineQueueLimits,
  type OfflineQueueOptions,
} from './persistence';
export { AllStakErrorBoundary, withAllStakErrorBoundary, type AllStakErrorBoundaryProps } from './error-boundary';
export { registerAllStak, type RegisterAllStakOptions } from './instrumentation';
export { captureUnderscoreErrorException, type NextErrorContext } from './pages-error';
export { installGlobalErrorHandlers, type GlobalErrorHandlerOptions } from './client-hooks';
export {
  initWebVitals,
  reportWebVitals,
  type WebVitalName,
  type NextWebVitalsMetric,
} from './web-vitals';
export {
  instrumentFetch,
  uninstrumentFetch,
  isFetchInstrumented,
} from './fetch-instrumentation';
export { withAllStakMiddleware } from './middleware';
export {
  withAllStakRouteHandler,
  withAllStakServerAction,
  createRouteTelemetryContext,
  type RouteTelemetryContext,
  type ServerActionTelemetryOptions,
} from './route-handler';
export {
  installDbInstrumentation,
  instrumentPgDriver,
  instrumentPrisma,
  allstakDrizzleLogger,
  type DbInstrumentationOptions,
  type PrismaInstrumentationOptions,
  type DrizzleLogger,
  type DrizzleLoggerOptions,
} from './db-instrumentation';
export {
  logToAllStak,
  installConsoleLogBridge,
  uninstallConsoleLogBridge,
  isConsoleLogBridgeInstalled,
  allstakPinoStream,
  allstakWinstonTransport,
  type LogToAllStakOptions,
  type ConsoleLogBridgeOptions,
  type PinoDestinationStream,
} from './logs';
export {
  installAutoBreadcrumbs,
  areAutoBreadcrumbsInstalled,
  type BeforeBreadcrumb,
  type BreadcrumbCollectorOptions,
} from './breadcrumbs';
export {
  bootstrapAllStakClient,
  isClientBootstrapped,
  type ClientBootstrapOptions,
} from './instrumentation-client';

const DEFAULT_HOST = 'https://api.allstak.sa';

export interface AllStakNextConfig {
  apiKey?: string;
  /**
   * Backward-compatible alias for apiKey. The runtime client already supports
   * this; keeping it in the public config type prevents wizard-generated
   * instrumentation from failing TypeScript builds.
   */
  dsn?: string;
  host?: string;
  environment?: string;
  release?: string;
  uploadToken?: string;
  dist?: string;
  tunnelRoute?: string;
  /**
   * Enable release-health session tracking (start on init, end on graceful
   * shutdown, ok/errored/crashed status). Default true. Set false to opt out.
   */
  enableAutoSessionTracking?: boolean;
  /**
   * Persist un-sent telemetry so it survives a process/app restart AND a
   * network outage, replaying it on the next init (offline store).
   * Default true. Set false to opt out. Fully fail-open.
   */
  enableOfflineQueue?: boolean;
  /** Spool directory for the Node fs offline store. Defaults to os.tmpdir(). */
  offlineSpoolDir?: string;
  /**
   * Send personally-identifiable information found in free-text VALUES. Default
   * FALSE. Credit-card numbers (Luhn-valid) and hyphenated US
   * SSNs are ALWAYS scrubbed regardless. While false, email and IPv4/IPv6
   * addresses leaking into messages / metadata / breadcrumbs / captured HTTP
   * fields are scrubbed too; set true to ship that PII. The explicit user
   * object set via `setUser` is never value-scrubbed.
   */
  sendDefaultPii?: boolean;
  /**
   * Collect Core Web Vitals (LCP/CLS/INP/FCP/TTFB) via PerformanceObserver and
   * emit them as `web.vital` spans. Default TRUE in browser contexts (a no-op on
   * the server/edge). Set false to opt out of the automatic observers.
   */
  enableWebVitals?: boolean;
  /**
   * Instrument the global `fetch` to capture OUTBOUND HTTP requests
   * (`direction:'outbound'`) and inject W3C `traceparent` + `baggage` headers so
   * distributed traces survive the first downstream hop. Works in node server,
   * edge, and browser. The SDK's own ingest host is always skipped. Default
   * true. Set false to opt out. Fully fail-open.
   */
  enableOutboundHttp?: boolean;
  /**
   * Install the browser console/navigation/fetch breadcrumb collectors so any
   * error captured afterwards carries recent activity context automatically.
   * Default TRUE in browser contexts (a no-op on the server/edge). Set false to
   * opt out.
   */
  enableAutoBreadcrumbs?: boolean;
  /** Capture privacy-safe click breadcrumbs. Default TRUE with auto breadcrumbs. */
  enableClickBreadcrumbs?: boolean;
  /** Edit/drop auto breadcrumbs before storing them. Must not return sensitive data. */
  beforeBreadcrumb?: BeforeBreadcrumb;
  /**
   * Bridge `console.{debug,info,warn,error}` to `/ingest/v1/logs` so existing
   * `console.*` calls become structured logs (error+Error promoted to an
   * event). The original console output is always preserved. Default TRUE. Set
   * false to opt out.
   */
  enableConsoleLogs?: boolean;
  /**
   * Last-mile event hook for compatibility with the base SDKs. The SDK runs
   * sanitization before this hook and again before persistence/network send, so
   * a hook cannot reintroduce secrets into stored or transmitted events.
   */
  beforeSend?: (event: AllStakNextEvent) => AllStakNextEvent | null;
}

export interface SourceMapUploadOptions {
  dir: string;
  release: string;
  uploadToken: string;
  host?: string;
  dist?: string;
  deleteAfterUpload?: boolean;
}

export function initAllStakNext(config: AllStakNextConfig): void {
  const apiKey = config.apiKey || config.dsn;
  (globalThis as typeof globalThis & { __ALLSTAK_NEXT__?: AllStakNextConfig }).__ALLSTAK_NEXT__ = {
    ...config,
    apiKey,
    host: (config.host || DEFAULT_HOST).replace(/\/$/, ''),
  };
  // Register a real client so the module-level captureException/captureMessage
  // and scope API route through the full pipeline (frame parsing, breadcrumbs,
  // sampling, beforeSend, redaction) instead of the old raw-fetch shadow.
  // Skip if a client was already registered (e.g. via registerAllStak).
  const existing = getClient();
  if ((!existing || existing.isDestroyed()) && apiKey) {
    setClient(new AllStakNextClient({
      apiKey,
      host: config.host,
      environment: config.environment,
      release: config.release,
      enableAutoSessionTracking: config.enableAutoSessionTracking,
      enableOfflineQueue: config.enableOfflineQueue,
      offlineSpoolDir: config.offlineSpoolDir,
      sendDefaultPii: config.sendDefaultPii,
      enableOutboundHttp: config.enableOutboundHttp,
      beforeSend: config.beforeSend,
    }));
  }

  // Browser-side instrumentation: Core Web Vitals (default on), the outbound
  // fetch wrapper (default on), auto-breadcrumbs (default on), and the
  // console→logs bridge (default on). All fully fail-open and no-ops on the
  // server/edge. On the server/edge the outbound wrapper + console bridge are
  // installed by registerAllStak instead.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (config.enableWebVitals !== false) {
      try {
        initWebVitals();
      } catch {
        // fail-open
      }
    }
    if (config.enableOutboundHttp !== false) {
      try {
        instrumentFetch();
      } catch {
        // fail-open
      }
    }
    if (config.enableAutoBreadcrumbs !== false) {
      try {
        installAutoBreadcrumbs({
          click: config.enableClickBreadcrumbs,
          beforeBreadcrumb: config.beforeBreadcrumb,
        });
      } catch {
        // fail-open
      }
    }
    if (config.enableConsoleLogs !== false) {
      try {
        installConsoleLogBridge();
      } catch {
        // fail-open
      }
    }
  }
}

/**
 * Forward a structured log line to `/ingest/v1/logs` on demand through the
 * registered client. warn/error/fatal add a breadcrumb; error/fatal carrying
 * an `Error` are promoted to `captureException`. Safe no-op if no client is
 * registered. Fully fail-open.
 */
export function captureLog(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  logToAllStak(level, message, { meta });
}

/**
 * Capture an exception on demand.
 *
 * Routes through the registered {@link AllStakNextClient} (set via
 * `registerAllStak`) so the capture runs through the full pipeline — stack
 * frame parsing + debug-IDs, breadcrumbs, sampling, beforeSend, and wire
 * redaction — and merges the active scope (user/tags/extras/contexts set via
 * the scope API below). The previous degraded top-level raw-fetch shadow has
 * been removed.
 *
 * If `registerAllStak` was not called, this is a safe no-op (telemetry must
 * never crash the host app).
 */
export async function captureException(error: Error, context: Record<string, unknown> = {}): Promise<void> {
  const client = getClient();
  if (!client || client.isDestroyed()) return;
  await client.captureException(error, context);
}

/**
 * Capture a freeform message on demand through the registered client.
 * Safe no-op if no client is registered.
 */
export async function captureMessage(message: string, level: SeverityLevel = 'info'): Promise<void> {
  const client = getClient();
  if (!client || client.isDestroyed()) return;
  await client.captureMessage(message, level);
}

/** Privacy-safe SDK diagnostics for the registered client. */
export function getDiagnostics(): SdkDiagnostics | null {
  const client = getClient();
  return client?.getDiagnostics() ?? null;
}

// ── Module-level scope API ──────────────────────────────────────────────────
// Mutates the active scope (per-request when inside a wrapped route handler /
// server action, else the process-global scope). Values attach to events
// captured afterwards.

/** Set the user on the active (request or global) scope. */
export function setUser(user: ScopeUser | null): void {
  scopeManager.getCurrentScope().setUser(user);
}
/** Set a single tag on the active scope. */
export function setTag(key: string, value: string): void {
  scopeManager.getCurrentScope().setTag(key, value);
}
/** Merge tags onto the active scope. */
export function setTags(tags: Record<string, string>): void {
  scopeManager.getCurrentScope().setTags(tags);
}
/** Set a single extra value on the active scope. */
export function setExtra(key: string, value: unknown): void {
  scopeManager.getCurrentScope().setExtra(key, value);
}
/** Merge extras onto the active scope. */
export function setExtras(extras: Record<string, unknown>): void {
  scopeManager.getCurrentScope().setExtras(extras);
}
/** Attach (or remove, with `null`) a named context bag on the active scope. */
export function setContext(name: string, ctx: Record<string, unknown> | null): void {
  scopeManager.getCurrentScope().setContext(name, ctx);
}
/** Add a breadcrumb to the active scope; attached to subsequently captured events. */
export function addBreadcrumb(crumb: ScopeBreadcrumb): void {
  scopeManager.getCurrentScope().addBreadcrumb(crumb);
}
/** Run `callback` with a forked scope that is popped afterwards (sync or async). */
export function withScope<T>(callback: (scope: Scope) => T): T {
  return scopeManager.withScope(callback);
}
/** Mutate the active scope in place. */
export function configureScope(callback: (scope: Scope) => void): void {
  scopeManager.configureScope(callback);
}
/**
 * Run `work` inside a fresh request-isolated scope (AsyncLocalStorage). Used by
 * the route-handler / server-action wrappers so per-request user/tags don't
 * leak across concurrent requests. Exposed for advanced manual wiring.
 */
export function runWithRequestScope<T>(work: () => T): T {
  return scopeManager.runInRequestScope(work);
}

export async function processNextSourceMaps(options: SourceMapUploadOptions): Promise<{ pairs: number; uploaded: number }> {
  const pairs = findPairs(options.dir);
  let uploaded = 0;
  for (const pair of pairs) {
    const debugId = injectDebugId(pair.js, pair.map);
    const form = new FormData();
    form.set('debugId', debugId);
    form.set('type', 'sourcemap');
    form.set('release', options.release);
    if (options.dist) form.set('dist', options.dist);
    form.set('fileName', pair.jsName);
    form.set('file', new Blob([readFileSync(pair.map)]), pair.mapName);
    const response = await fetch(`${(options.host || DEFAULT_HOST).replace(/\/$/, '')}/api/v1/artifacts/upload`, {
      method: 'POST',
      headers: { 'X-AllStak-Upload-Token': options.uploadToken },
      body: form,
    });
    if (!response.ok) throw new Error(`AllStak source-map upload failed: HTTP ${response.status}`);
    if (options.deleteAfterUpload) {
      try {
        unlinkSync(pair.map);
      } catch {
        /* non-fatal cleanup */
      }
    }
    uploaded++;
  }
  return { pairs: pairs.length, uploaded };
}

export interface WithAllStakOptions extends Partial<SourceMapUploadOptions> {
  tunnelRoute?: string;
  silent?: boolean;
  /**
   * Inject the auto-running client bootstrap (`@allstak/next/client`) into the
   * browser bundle so browser errors / Core Web Vitals / fetch breadcrumbs are
   * live from `NEXT_PUBLIC_*` env with NO manual `installGlobalErrorHandlers()`
   * call. Default true. Set false to opt out (e.g. you wire a root
   * `instrumentation-client.ts` yourself). Fully fail-open: a webpack-entry
   * shape we don't recognize is left untouched.
   */
  clientBootstrap?: boolean;
}

/** The client bootstrap entry module injected into the browser compilation. */
const CLIENT_BOOTSTRAP_IMPORT = '@allstak/next/client';

export function withAllStak(allstak: WithAllStakOptions, nextConfig: Record<string, unknown> = {}): Record<string, unknown> {
  const userWebpack = nextConfig.webpack as ((config: any, ctx: any) => any) | undefined;
  const userRewrites = nextConfig.rewrites as (() => unknown | Promise<unknown>) | undefined;
  const tunnelRoute = normalizeTunnelRoute(allstak.tunnelRoute);
  const injectClient = allstak.clientBootstrap !== false;
  return {
    ...nextConfig,
    productionBrowserSourceMaps: nextConfig.productionBrowserSourceMaps ?? true,
    ...(tunnelRoute ? {
      async rewrites() {
        const existing = typeof userRewrites === 'function' ? await userRewrites() : [];
        const tunnelRewrite = {
          source: tunnelRoute,
          destination: `${(allstak.host || DEFAULT_HOST).replace(/\/$/, '')}/ingest/v1/:path*`,
        };
        return mergeRewrite(tunnelRewrite, existing);
      },
    } : {}),
    webpack(config: any, ctx: any) {
      config.plugins = config.plugins || [];
      config.plugins.push({
        apply(compiler: any) {
          compiler.hooks?.environment?.tap?.('AllStakNextEnvironment', () => {
            compiler.options = compiler.options || {};
            compiler.options.plugins = compiler.options.plugins || [];
          });
        },
      });

      // Auto-inject the client bootstrap into the BROWSER compilation only, so
      // the browser instrumentation runs without a manual call. We prepend our
      // import ahead of Next's `main` entry. Fully fail-open and idempotent.
      if (injectClient && !ctx?.isServer) {
        try {
          config.entry = wrapEntryWithClientBootstrap(config.entry);
        } catch {
          // fail-open: never break the host build over the bootstrap injection
        }
      }

      if (!ctx?.isServer && !ctx?.dev && allstak.release && allstak.uploadToken) {
        const plugin = {
          apply(compiler: any) {
            compiler.hooks.afterEmit.tapPromise('AllStakNextSourceMaps', async () => {
              try {
                await processNextSourceMaps({
                  dir: compiler.outputPath,
                  release: allstak.release!,
                  uploadToken: allstak.uploadToken!,
                  host: allstak.host,
                  dist: allstak.dist,
                  deleteAfterUpload: allstak.deleteAfterUpload,
                });
              } catch (error) {
                if (allstak.silent === false) throw error;
              }
            });
          },
        };
        config.plugins.push(plugin);
      }
      return userWebpack ? userWebpack(config, ctx) : config;
    },
  };
}

/**
 * Prepend the client bootstrap import to Next's browser entry. Next's
 * `config.entry` is a function returning a Promise of an entry map; entry
 * values are usually a string or an array of strings (sometimes `{ import }`
 * descriptors). We add our import to the `main-app` / `main` entry (where
 * Next puts the app shell) without removing anything, and only when it isn't
 * already present (idempotent). Any unrecognized shape is returned unchanged.
 */
export function wrapEntryWithClientBootstrap(entry: unknown): unknown {
  if (typeof entry !== 'function') return entry;
  const original = entry as () => Promise<Record<string, unknown>> | Record<string, unknown>;
  return async function allstakEntry(): Promise<Record<string, unknown>> {
    const resolved = await original();
    try {
      // Prefer the app-router shell entry; fall back to the pages-router one.
      const target = resolved['main-app'] !== undefined ? 'main-app' : 'main';
      resolved[target] = addImport(resolved[target]);
    } catch {
      // fail-open: hand back the entry untouched
    }
    return resolved;
  };
}

/** Add the bootstrap import to a single webpack entry value, idempotently. */
function addImport(value: unknown): unknown {
  if (value === undefined || value === null) {
    return [CLIENT_BOOTSTRAP_IMPORT];
  }
  if (typeof value === 'string') {
    return value === CLIENT_BOOTSTRAP_IMPORT ? value : [CLIENT_BOOTSTRAP_IMPORT, value];
  }
  if (Array.isArray(value)) {
    return value.includes(CLIENT_BOOTSTRAP_IMPORT) ? value : [CLIENT_BOOTSTRAP_IMPORT, ...value];
  }
  // `{ import: string | string[], ... }` descriptor form.
  if (typeof value === 'object') {
    const desc = value as { import?: string | string[] };
    const imp = desc.import;
    if (typeof imp === 'string') {
      return { ...desc, import: imp === CLIENT_BOOTSTRAP_IMPORT ? imp : [CLIENT_BOOTSTRAP_IMPORT, imp] };
    }
    if (Array.isArray(imp)) {
      return { ...desc, import: imp.includes(CLIENT_BOOTSTRAP_IMPORT) ? imp : [CLIENT_BOOTSTRAP_IMPORT, ...imp] };
    }
    return { ...desc, import: [CLIENT_BOOTSTRAP_IMPORT] };
  }
  return value;
}

function normalizeTunnelRoute(route: string | undefined): string | undefined {
  if (!route) return undefined;
  const trimmed = route.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function mergeRewrite(tunnelRewrite: Record<string, string>, existing: unknown): unknown {
  if (Array.isArray(existing)) {
    return [tunnelRewrite, ...existing];
  }
  if (existing && typeof existing === 'object') {
    const grouped = existing as { beforeFiles?: unknown[] };
    return {
      ...grouped,
      beforeFiles: [tunnelRewrite, ...(Array.isArray(grouped.beforeFiles) ? grouped.beforeFiles : [])],
    };
  }
  return [tunnelRewrite];
}

function findPairs(dir: string): Array<{ js: string; map: string; jsName: string; mapName: string }> {
  const out: Array<{ js: string; map: string; jsName: string; mapName: string }> = [];
  for (const file of walk(dir)) {
    if (!file.endsWith('.js')) continue;
    const map = `${file}.map`;
    try {
      statSync(map);
      out.push({ js: file, map, jsName: file.slice(dir.length + 1), mapName: map.slice(dir.length + 1) });
    } catch {
      /* no pair */
    }
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function injectDebugId(jsPath: string, mapPath: string): string {
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const debugId = map.debugId || randomUUID();
  map.debugId = debugId;
  writeFileSync(mapPath, JSON.stringify(map));
  const js = readFileSync(jsPath, 'utf8');
  if (!js.includes(`debugId=${debugId}`)) {
    writeFileSync(jsPath, `${js}\n//# debugId=${debugId}\n`);
  }
  return debugId;
}
