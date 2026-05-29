import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AllStakNextClient, setClient } from '../src/client';
import {
  initWebVitals,
  reportWebVitals,
  _finalizeWebVitalsForTest,
  _resetWebVitalsForTest,
  _getWebVitalsMeasurementsForTest,
} from '../src/web-vitals';

/**
 * Core Web Vitals are ingested AS SPANS via POST /ingest/v1/spans with
 * op="web.vital". The backend classifies that op into the "web" category and
 * persists the `measurements` column. These tests assert the wire shape and the
 * collection/finalize behaviour. PerformanceObserver / window / document are
 * stubbed in the node test runtime.
 */
describe('web vitals', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let observers: Array<{ type?: string; cb: (list: { getEntries: () => unknown[] }) => void }>;
  let docListeners: Record<string, Array<(...a: unknown[]) => void>>;
  let winListeners: Record<string, Array<(...a: unknown[]) => void>>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);
    setClient(null);
    _resetWebVitalsForTest();

    observers = [];
    docListeners = {};
    winListeners = {};

    // Minimal PerformanceObserver mock: capture observers + the entry types.
    class FakePerformanceObserver {
      cb: (list: { getEntries: () => unknown[] }) => void;
      constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
        this.cb = cb;
      }
      observe(opts: { type?: string }) {
        observers.push({ type: opts?.type, cb: this.cb });
      }
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver as unknown as typeof PerformanceObserver);

    vi.stubGlobal('performance', {
      getEntriesByType: (type: string) => {
        if (type === 'navigation') return [{ responseStart: 120 }];
        if (type === 'paint') return [{ name: 'first-contentful-paint', startTime: 80 }];
        return [];
      },
    });

    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: (event: string, h: (...a: unknown[]) => void) => {
        (docListeners[event] ??= []).push(h);
      },
      removeEventListener: (event: string, h: (...a: unknown[]) => void) => {
        docListeners[event] = (docListeners[event] ?? []).filter((x) => x !== h);
      },
    });
    vi.stubGlobal('window', {
      addEventListener: (event: string, h: (...a: unknown[]) => void) => {
        (winListeners[event] ??= []).push(h);
      },
      removeEventListener: (event: string, h: (...a: unknown[]) => void) => {
        winListeners[event] = (winListeners[event] ?? []).filter((x) => x !== h);
      },
    });
    vi.stubGlobal('location', { href: 'https://example.com/page' });
  });

  afterEach(() => {
    _resetWebVitalsForTest();
    setClient(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function spanCalls() {
    return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/ingest/v1/spans'));
  }
  function emit(type: string, entries: unknown[]) {
    for (const o of observers) {
      if (o.type === type) o.cb({ getEntries: () => entries });
    }
  }

  function installClient() {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      environment: 'production',
      release: '1.0.0',
    });
    setClient(client);
    return client;
  }

  it('emits a web.vital span with op + operation + measurements on finalize', async () => {
    const client = installClient();
    initWebVitals();

    emit('largest-contentful-paint', [{ startTime: 2500.4 }]);
    emit('layout-shift', [{ value: 0.03, hadRecentInput: false }, { value: 0.01, hadRecentInput: false }]);
    emit('event', [{ interactionId: 1, duration: 180 }, { interactionId: 2, duration: 250 }]);

    expect(_finalizeWebVitalsForTest()).toBe(true);
    await client.flush();

    const calls = spanCalls();
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe('https://api.allstak.sa/ingest/v1/spans');
    expect(init.method).toBe('POST');
    expect(init.headers['X-AllStak-Key']).toBe('ask_test');

    const span = JSON.parse(init.body).spans[0];
    expect(span.op).toBe('web.vital');
    expect(span.operation).toBe('web.vital');
    expect(span.measurements.LCP).toBe(2500); // rounded ms
    expect(span.measurements.CLS).toBeCloseTo(0.04, 4); // summed
    expect(span.measurements.INP).toBe(250); // worst interaction wins
    expect(span.measurements.FCP).toBe(80); // from paint timing
    expect(span.measurements.TTFB).toBe(120); // from navigation responseStart
    expect(typeof span.measurements.LCP).toBe('number');
  });

  it('reports platform as "browser" (uses detectPlatform, not hardcoded node)', async () => {
    const client = installClient();
    initWebVitals();
    emit('largest-contentful-paint', [{ startTime: 1000 }]);
    _finalizeWebVitalsForTest();
    await client.flush();

    const span = JSON.parse(spanCalls()[0][1].body).spans[0];
    expect(span.platform).toBe('browser');
    expect(span.sessionId).toBe(client.getSessionId());
    expect(span.environment).toBe('production');
    expect(span.release).toBe('1.0.0');
  });

  it('finalizes on visibilitychange(hidden) exactly once (double-send guard)', async () => {
    const client = installClient();
    initWebVitals();
    emit('largest-contentful-paint', [{ startTime: 900 }]);

    // visibilitychange while still visible: no send.
    docListeners['visibilitychange'][0]();
    expect(spanCalls()).toHaveLength(0);

    // now hidden → one send.
    (globalThis as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
    docListeners['visibilitychange'][0]();
    // pagehide also fires; must NOT double-send.
    winListeners['pagehide'][0]();
    await client.flush();

    expect(spanCalls()).toHaveLength(1);
  });

  it('does not send when no metrics were collected', async () => {
    const client = installClient();
    // performance returns no navigation/paint either
    vi.stubGlobal('performance', { getEntriesByType: () => [] });
    initWebVitals();
    expect(_finalizeWebVitalsForTest()).toBe(false);
    await client.flush();
    expect(spanCalls()).toHaveLength(0);
  });

  it('ignores layout-shift entries that had recent input (CLS rule)', async () => {
    const client = installClient();
    initWebVitals();
    emit('layout-shift', [
      { value: 0.5, hadRecentInput: true }, // ignored
      { value: 0.02, hadRecentInput: false }, // counted
    ]);
    _finalizeWebVitalsForTest();
    await client.flush();
    const span = JSON.parse(spanCalls()[0][1].body).spans[0];
    expect(span.measurements.CLS).toBeCloseTo(0.02, 4);
  });

  it('is a no-op outside the browser (no document)', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', fetchSpy);
    const teardown = initWebVitals();
    expect(teardown).toBeTypeOf('function');
    expect(_finalizeWebVitalsForTest()).toBe(false);
  });
});

describe('reportWebVitals (Next useReportWebVitals hook)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);
    setClient(null);
    _resetWebVitalsForTest();
    // No PerformanceObserver in this block: reportWebVitals must still work.
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('performance', { getEntriesByType: () => [] });
  });

  afterEach(() => {
    _resetWebVitalsForTest();
    setClient(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function spanCalls() {
    return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/ingest/v1/spans'));
  }

  it('accepts Next {name,value,id} and records it into the web.vital span', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    setClient(client);

    reportWebVitals({ name: 'LCP', value: 1800.9, id: 'v1-1' });
    reportWebVitals({ name: 'CLS', value: 0.07, id: 'v1-2' });
    reportWebVitals({ name: 'FCP', value: 950, id: 'v1-3' });

    expect(_finalizeWebVitalsForTest()).toBe(true);
    await client.flush();

    const span = JSON.parse(spanCalls()[0][1].body).spans[0];
    expect(span.op).toBe('web.vital');
    expect(span.measurements.LCP).toBe(1801);
    expect(span.measurements.CLS).toBeCloseTo(0.07, 4);
    expect(span.measurements.FCP).toBe(950);
  });

  it('maps a legacy FID metric onto INP', () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    setClient(client);
    reportWebVitals({ name: 'FID', value: 42, id: 'fid-1' });
    expect(_getWebVitalsMeasurementsForTest().INP).toBe(42);
  });

  it('ignores unknown metric names and malformed metrics (fail-open)', () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    setClient(client);
    reportWebVitals({ name: 'TBT', value: 100 });
    reportWebVitals({ name: 'LCP', value: Number.NaN });
    // @ts-expect-error intentional malformed input
    reportWebVitals(null);
    // @ts-expect-error intentional malformed input
    reportWebVitals({ name: 'LCP' });
    expect(_getWebVitalsMeasurementsForTest()).toEqual({});
  });
});
