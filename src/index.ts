import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Re-exports from the consolidated client/middleware/integration surface ──
// Restores the public API that shipped on @allstak/next@0.1.0; the
// short-circuit publish of 0.1.1 missed these because index.ts didn't
// re-export from the freshly-tracked source files.
import { AllStakNextClient, getClient, setClient, type SeverityLevel } from './client';
import {
  Scope,
  scopeManager,
  type ScopeUser,
  type ScopeBreadcrumb,
} from './scope';

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
  type StackFrame,
  type DebugImage,
} from './client';
export { Scope } from './scope';
export type { ScopeUser, ScopeBreadcrumb, Severity, MergedScopeData } from './scope';
export { resolveDebugId, _resetDebugIdCache } from './utils/debug-id';
export { AllStakErrorBoundary, withAllStakErrorBoundary, type AllStakErrorBoundaryProps } from './error-boundary';
export { registerAllStak, type RegisterAllStakOptions } from './instrumentation';
export { captureUnderscoreErrorException, type NextErrorContext } from './pages-error';
export { installGlobalErrorHandlers } from './client-hooks';
export { withAllStakMiddleware } from './middleware';
export {
  withAllStakRouteHandler,
  withAllStakServerAction,
  createRouteTelemetryContext,
  type RouteTelemetryContext,
  type ServerActionTelemetryOptions,
} from './route-handler';

const DEFAULT_HOST = 'https://api.allstak.sa';

export interface AllStakNextConfig {
  apiKey?: string;
  host?: string;
  environment?: string;
  release?: string;
  uploadToken?: string;
  dist?: string;
  tunnelRoute?: string;
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
  (globalThis as typeof globalThis & { __ALLSTAK_NEXT__?: AllStakNextConfig }).__ALLSTAK_NEXT__ = {
    ...config,
    host: (config.host || DEFAULT_HOST).replace(/\/$/, ''),
  };
  // Register a real client so the module-level captureException/captureMessage
  // and scope API route through the full pipeline (frame parsing, breadcrumbs,
  // sampling, beforeSend, redaction) instead of the old raw-fetch shadow.
  // Skip if a client was already registered (e.g. via registerAllStak).
  const existing = getClient();
  if ((!existing || existing.isDestroyed()) && config.apiKey) {
    setClient(new AllStakNextClient({
      apiKey: config.apiKey,
      host: config.host,
      environment: config.environment,
      release: config.release,
    }));
  }
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
 * Capture a freeform message on demand through the registered client (parity
 * with @sentry/node `captureMessage`). Safe no-op if no client is registered.
 */
export async function captureMessage(message: string, level: SeverityLevel = 'info'): Promise<void> {
  const client = getClient();
  if (!client || client.isDestroyed()) return;
  await client.captureMessage(message, level);
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
}

export function withAllStak(allstak: WithAllStakOptions, nextConfig: Record<string, unknown> = {}): Record<string, unknown> {
  const userWebpack = nextConfig.webpack as ((config: any, ctx: any) => any) | undefined;
  const userRewrites = nextConfig.rewrites as (() => unknown | Promise<unknown>) | undefined;
  const tunnelRoute = normalizeTunnelRoute(allstak.tunnelRoute);
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
