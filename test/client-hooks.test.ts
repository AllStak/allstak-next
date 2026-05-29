import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { installGlobalErrorHandlers } from '../src/client-hooks';
import { AllStakNextClient, setClient } from '../src/client';

describe('installGlobalErrorHandlers', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    // Provide minimal window mock for Node test environment
    vi.stubGlobal('window', {
      onerror: null as any,
      onunhandledrejection: null as any,
    });
  });

  afterEach(() => {
    setClient(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('installs window.onerror handler that captures errors', () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    const captureSpy = vi.spyOn(client, 'captureException');
    setClient(client);

    const teardown = installGlobalErrorHandlers();

    expect(window.onerror).toBeTypeOf('function');
    (window.onerror as Function)('test error', 'file.js', 10, 5, new Error('onerror test'));

    expect(captureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'onerror test' }),
      expect.objectContaining({ mechanism: 'window.onerror' }),
    );

    teardown();
  });

  it('installs window.onunhandledrejection handler', () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    const captureSpy = vi.spyOn(client, 'captureException');
    setClient(client);

    const teardown = installGlobalErrorHandlers();

    expect(window.onunhandledrejection).toBeTypeOf('function');
    const event = { reason: new Error('rejected'), promise: Promise.resolve() };
    (window.onunhandledrejection as Function)(event);

    expect(captureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'rejected' }),
      expect.objectContaining({ mechanism: 'window.onunhandledrejection' }),
    );

    teardown();
  });

  it('chains previous onerror handler', () => {
    const prevHandler = vi.fn();
    (window as any).onerror = prevHandler;

    setClient(new AllStakNextClient({ apiKey: 'ask_test' }));
    const teardown = installGlobalErrorHandlers();

    (window.onerror as Function)('msg', 'file.js', 1, 1, new Error('test'));
    expect(prevHandler).toHaveBeenCalled();

    teardown();
    expect(window.onerror).toBe(prevHandler);
  });

  it('chains previous onunhandledrejection handler', () => {
    const prevHandler = vi.fn();
    (window as any).onunhandledrejection = prevHandler;

    setClient(new AllStakNextClient({ apiKey: 'ask_test' }));
    const teardown = installGlobalErrorHandlers();

    (window.onunhandledrejection as Function)({ reason: 'fail', promise: Promise.resolve() });
    expect(prevHandler).toHaveBeenCalled();

    teardown();
    expect(window.onunhandledrejection).toBe(prevHandler);
  });

  it('creates error from string message when no Error object provided', () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    const captureSpy = vi.spyOn(client, 'captureException');
    setClient(client);

    installGlobalErrorHandlers();
    (window.onerror as Function)('string error message', 'file.js', 1, 1, undefined);

    expect(captureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'string error message' }),
      expect.anything(),
    );
  });
});

describe('installGlobalErrorHandlers — session end on pagehide', () => {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};

  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.stubGlobal('window', {
      onerror: null as any,
      onunhandledrejection: null as any,
      addEventListener: (event: string, handler: (...args: any[]) => void) => {
        (listeners[event] ??= []).push(handler);
      },
      removeEventListener: (event: string, handler: (...args: any[]) => void) => {
        listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
      },
    });
  });

  afterEach(() => {
    setClient(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('ends the session when the page is hidden (pagehide)', () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      release: '1.0.0',
      enableAutoSessionTracking: true,
    });
    const endSpy = vi.spyOn(client, 'endSession');
    setClient(client);

    const teardown = installGlobalErrorHandlers();
    expect(listeners['pagehide']).toBeTruthy();

    listeners['pagehide'][0]();
    expect(endSpy).toHaveBeenCalled();

    teardown();
    expect(listeners['pagehide']).toHaveLength(0);
  });
});

describe('installGlobalErrorHandlers — web vitals wiring', () => {
  const docListeners: Record<string, Array<(...a: any[]) => void>> = {};
  const winListeners: Record<string, Array<(...a: any[]) => void>> = {};
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of Object.keys(docListeners)) delete docListeners[k];
    for (const k of Object.keys(winListeners)) delete winListeners[k];
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);
    // Full browser surface so initWebVitals's isBrowser() returns true.
    class FakePO {
      cb: any;
      constructor(cb: any) { this.cb = cb; }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', FakePO as any);
    vi.stubGlobal('performance', {
      getEntriesByType: (t: string) =>
        t === 'navigation' ? [{ responseStart: 100 }] : t === 'paint' ? [{ name: 'first-contentful-paint', startTime: 50 }] : [],
    });
    vi.stubGlobal('location', { href: 'https://example.com/' });
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      addEventListener: (e: string, h: any) => { (docListeners[e] ??= []).push(h); },
      removeEventListener: (e: string, h: any) => { docListeners[e] = (docListeners[e] ?? []).filter((x) => x !== h); },
    });
    vi.stubGlobal('window', {
      onerror: null as any,
      onunhandledrejection: null as any,
      addEventListener: (e: string, h: any) => { (winListeners[e] ??= []).push(h); },
      removeEventListener: (e: string, h: any) => { winListeners[e] = (winListeners[e] ?? []).filter((x) => x !== h); },
    });
  });

  afterEach(() => {
    setClient(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function spanCalls() {
    return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/ingest/v1/spans'));
  }

  it('emits a web.vital span on pagehide by default', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    setClient(client);

    const teardown = installGlobalErrorHandlers();
    // The web-vitals hook registered its own pagehide listener.
    expect(winListeners['pagehide']?.length).toBeGreaterThan(0);
    for (const h of winListeners['pagehide']) h();
    await client.flush();

    const span = JSON.parse(spanCalls()[0][1].body).spans[0];
    expect(span.op).toBe('web.vital');
    expect(span.platform).toBe('browser');
    teardown();
  });

  it('does NOT collect web vitals when enableWebVitals is false', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    setClient(client);

    const teardown = installGlobalErrorHandlers({ enableWebVitals: false });
    for (const h of winListeners['pagehide'] ?? []) h();
    await client.flush();

    expect(spanCalls()).toHaveLength(0);
    teardown();
  });
});
