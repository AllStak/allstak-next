import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getClient, setClient } from '../src/client';
import {
  bootstrapAllStakClient,
  isClientBootstrapped,
  _resetClientBootstrapForTest,
} from '../src/instrumentation-client';
import { isConsoleLogBridgeInstalled, uninstallConsoleLogBridge } from '../src/logs';
import { areAutoBreadcrumbsInstalled, _resetAutoBreadcrumbsForTest } from '../src/breadcrumbs';
import { isFetchInstrumented, uninstrumentFetch } from '../src/fetch-instrumentation';
import { _resetWebVitalsForTest } from '../src/web-vitals';

/**
 * The auto-running client bootstrap reads NEXT_PUBLIC_* env, registers a client
 * if needed, and installs the full browser instrumentation surface
 * (global handlers + web vitals + fetch + breadcrumbs + console logs) with no
 * manual call. window/document are stubbed for the node test runtime.
 */
describe('client bootstrap', () => {
  let winListeners: Record<string, Array<(...a: unknown[]) => void>>;
  let docListeners: Record<string, Array<(...a: unknown[]) => void>>;
  let originalConsole: Record<string, unknown>;

  beforeEach(() => {
    setClient(null);
    _resetClientBootstrapForTest();
    _resetAutoBreadcrumbsForTest();
    _resetWebVitalsForTest();
    uninstrumentFetch();
    uninstallConsoleLogBridge();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } }));
    vi.stubGlobal('PerformanceObserver', class {
      observe() {}
      disconnect() {}
    } as unknown as typeof PerformanceObserver);
    vi.stubGlobal('performance', { getEntriesByType: () => [] });

    winListeners = {};
    docListeners = {};
    originalConsole = {
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };

    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: (e: string, h: (...a: unknown[]) => void) => {
        (docListeners[e] ??= []).push(h);
      },
      removeEventListener: () => {},
    });
    vi.stubGlobal('window', {
      addEventListener: (e: string, h: (...a: unknown[]) => void) => {
        (winListeners[e] ??= []).push(h);
      },
      removeEventListener: () => {},
      history: { pushState: () => {}, replaceState: () => {} },
    });
    vi.stubGlobal('history', { pushState: () => {}, replaceState: () => {} });
    vi.stubGlobal('location', { pathname: '/', search: '', hash: '' });
  });

  afterEach(() => {
    setClient(null);
    _resetClientBootstrapForTest();
    _resetAutoBreadcrumbsForTest();
    _resetWebVitalsForTest();
    uninstrumentFetch();
    uninstallConsoleLogBridge();
    console.info = originalConsole.info as typeof console.info;
    console.warn = originalConsole.warn as typeof console.warn;
    console.error = originalConsole.error as typeof console.error;
    console.debug = originalConsole.debug as typeof console.debug;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('registers a client and installs the full browser surface by default', () => {
    console.info = (() => {}) as typeof console.info;
    const teardown = bootstrapAllStakClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa', release: '1.0.0' });

    expect(isClientBootstrapped()).toBe(true);
    expect(getClient()).toBeTruthy();
    expect(isFetchInstrumented()).toBe(true);
    expect(areAutoBreadcrumbsInstalled()).toBe(true);
    expect(isConsoleLogBridgeInstalled()).toBe(true);
    // window.onerror handler was installed.
    expect(typeof (window as unknown as { onerror?: unknown }).onerror).toBe('function');

    teardown();
  });

  it('honors individual opt-outs', () => {
    bootstrapAllStakClient({
      apiKey: 'ask_test',
      enableOutboundHttp: false,
      enableAutoBreadcrumbs: false,
      enableConsoleLogs: false,
    });
    expect(getClient()).toBeTruthy();
    expect(isFetchInstrumented()).toBe(false);
    expect(areAutoBreadcrumbsInstalled()).toBe(false);
    expect(isConsoleLogBridgeInstalled()).toBe(false);
  });

  it('does not create a client when no apiKey is available', () => {
    bootstrapAllStakClient({});
    expect(getClient()).toBeNull();
    // Booted regardless (collectors that need no client still install).
    expect(isClientBootstrapped()).toBe(true);
  });

  it('is idempotent — a second call is a no-op', () => {
    bootstrapAllStakClient({ apiKey: 'ask_test' });
    const first = getClient();
    bootstrapAllStakClient({ apiKey: 'ask_other' });
    expect(getClient()).toBe(first);
  });
});

import { wrapEntryWithClientBootstrap } from '../src/index';

/**
 * withAllStak() injects the client bootstrap into the browser webpack entry so
 * the bootstrap runs without a manual root instrumentation-client.ts. The
 * injection must be additive (never drop existing entries) and idempotent.
 */
describe('withAllStak entry injection', () => {
  const IMPORT = '@allstak/next/client';

  async function resolve(entry: unknown) {
    const wrapped = wrapEntryWithClientBootstrap(entry);
    return typeof wrapped === 'function' ? (wrapped as () => Promise<unknown>)() : wrapped;
  }

  it('prepends the bootstrap import to the main-app entry (string value)', async () => {
    const entry = async () => ({ 'main-app': './app-shell.js', other: ['x.js'] });
    const result = (await resolve(entry)) as Record<string, unknown>;
    expect(result['main-app']).toEqual([IMPORT, './app-shell.js']);
    // Unrelated entries are untouched.
    expect(result.other).toEqual(['x.js']);
  });

  it('prepends to the array form without dropping existing imports', async () => {
    const entry = async () => ({ 'main-app': ['a.js', 'b.js'] });
    const result = (await resolve(entry)) as Record<string, unknown>;
    expect(result['main-app']).toEqual([IMPORT, 'a.js', 'b.js']);
  });

  it('falls back to `main` when there is no main-app entry', async () => {
    const entry = async () => ({ main: 'm.js' });
    const result = (await resolve(entry)) as Record<string, unknown>;
    expect(result.main).toEqual([IMPORT, 'm.js']);
  });

  it('handles the { import } descriptor form', async () => {
    const entry = async () => ({ 'main-app': { import: ['a.js'], dependOn: 'x' } });
    const result = (await resolve(entry)) as Record<string, { import: string[]; dependOn: string }>;
    expect(result['main-app'].import).toEqual([IMPORT, 'a.js']);
    expect(result['main-app'].dependOn).toBe('x');
  });

  it('is idempotent (does not double-inject)', async () => {
    const entry = async () => ({ 'main-app': [IMPORT, 'a.js'] });
    const result = (await resolve(entry)) as Record<string, unknown>;
    expect(result['main-app']).toEqual([IMPORT, 'a.js']);
  });

  it('leaves a non-function entry untouched', () => {
    expect(wrapEntryWithClientBootstrap(undefined)).toBeUndefined();
    expect(wrapEntryWithClientBootstrap('str')).toBe('str');
  });
});
