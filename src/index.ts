import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Re-exports from the consolidated client/middleware/integration surface ──
// Restores the public API that shipped on @allstak/next@0.1.0; the
// short-circuit publish of 0.1.1 missed these because index.ts didn't
// re-export from the freshly-tracked source files.
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
}

export async function captureException(error: Error, context: Record<string, unknown> = {}): Promise<void> {
  const config = (globalThis as typeof globalThis & { __ALLSTAK_NEXT__?: AllStakNextConfig }).__ALLSTAK_NEXT__;
  if (!config?.apiKey) return;
  await fetch(`${(config.host || DEFAULT_HOST).replace(/\/$/, '')}/ingest/v1/errors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AllStak-Key': config.apiKey,
    },
    body: JSON.stringify({
      exceptionClass: error.name || 'Error',
      message: error.message,
      stackTrace: error.stack ? error.stack.split('\n') : [],
      level: 'error',
      environment: config.environment || '',
      release: config.release || '',
      metadata: { sdkName: '@allstak/next', ...context },
    }),
  });
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
