import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AllStakNextClient, SDK_NAME, SDK_VERSION, setClient, type SessionStateStore } from '../src/client';

/**
 * Release-health session tracking ("one session per process / app-launch").
 *
 * Session tracking is suppressed by default under the unit-test runtime
 * (mirroring `autoRegisterRelease`), so every test here opts in explicitly with
 * `enableAutoSessionTracking: true`.
 */
describe('release-health session tracking', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);
    setClient(null);
  });

  afterEach(() => {
    setClient(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function callsTo(path: string) {
    return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith(path));
  }
  function bodyOf(path: string) {
    const call = callsTo(path)[0];
    return call ? JSON.parse(call[1].body) : undefined;
  }
  function makeStore(initial?: string): SessionStateStore & { value: string | null } {
    return {
      value: initial ?? null,
      getItem: vi.fn(function (this: { value: string | null }) { return this.value; }),
      setItem: vi.fn(function (this: { value: string | null }, _key: string, value: string) { this.value = value; }),
      removeItem: vi.fn(function (this: { value: string | null }) { this.value = null; }),
    };
  }

  it('POSTs sessions/start at init with the documented payload shape', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      environment: 'production',
      release: '1.2.3',
      enableAutoSessionTracking: true,
    });
    await client.flush();

    const startCalls = callsTo('/ingest/v1/sessions/start');
    expect(startCalls).toHaveLength(1);

    const [url, init] = startCalls[0];
    expect(url).toBe('https://api.allstak.sa/ingest/v1/sessions/start');
    expect(init.method).toBe('POST');
    expect(init.headers['X-AllStak-Key']).toBe('ask_test');

    const body = JSON.parse(init.body);
    expect(body.sessionId).toBe(client.getSessionId());
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId.length).toBeGreaterThan(0);
    expect(body.release).toBe('1.2.3');
    expect(body.environment).toBe('production');
    expect(body.sdkName).toBe(SDK_NAME);
    expect(body.sdkVersion).toBe(SDK_VERSION);
    expect(body.platform).toBeTypeOf('string');
  });

  it('falls back to the SDK version as release when no release is resolved', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '',
      autoDetectRelease: false, // force an empty release
      enableAutoSessionTracking: true,
    });
    await client.flush();

    const body = bodyOf('/ingest/v1/sessions/start');
    expect(body.release).toBe(SDK_VERSION);
  });

  it('never sends a session when apiKey is missing (fail-open)', async () => {
    const client = new AllStakNextClient({ enableAutoSessionTracking: true });
    await client.flush();
    expect(callsTo('/ingest/v1/sessions/start')).toHaveLength(0);
  });

  it('does NOT POST sessions/start when tracking is disabled (opt-out)', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: false,
    });
    await client.flush();
    expect(callsTo('/ingest/v1/sessions/start')).toHaveLength(0);

    // ...and end is a no-op too.
    client.endSession();
    await client.flush();
    expect(callsTo('/ingest/v1/sessions/end')).toHaveLength(0);
  });

  it('attaches sessionId to every captured error/message payload', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
    });
    await client.captureException(new Error('boom'));
    await client.captureMessage('hello', 'info');
    await client.flush();

    const errorCalls = callsTo('/ingest/v1/errors');
    expect(errorCalls).toHaveLength(2);
    for (const [, init] of errorCalls) {
      expect(JSON.parse(init.body).sessionId).toBe(client.getSessionId());
    }
  });

  it('tracks status ok → errored on a HANDLED error', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
    });
    expect(client.getSessionStatus()).toBe('ok');

    await client.captureException(new Error('handled'));
    expect(client.getSessionStatus()).toBe('errored');
  });

  it('escalates status errored → crashed on an UNHANDLED mechanism', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
    });
    await client.captureException(new Error('handled'));
    expect(client.getSessionStatus()).toBe('errored');

    await client.captureException(new Error('fatal'), { mechanism: 'uncaughtException' });
    expect(client.getSessionStatus()).toBe('crashed');
  });

  it('treats a fatal-level message as a crash', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
    });
    await client.captureMessage('the end', 'fatal');
    expect(client.getSessionStatus()).toBe('crashed');
  });

  it('does NOT downgrade a crashed session back to errored', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
    });
    await client.captureException(new Error('crash'), { mechanism: 'unhandledRejection' });
    expect(client.getSessionStatus()).toBe('crashed');

    await client.captureException(new Error('later handled'));
    expect(client.getSessionStatus()).toBe('crashed');
  });

  it('POSTs sessions/end with sessionId + durationMs + status', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
    });
    await client.captureException(new Error('handled'));
    client.endSession();
    await client.flush();

    const endCalls = callsTo('/ingest/v1/sessions/end');
    expect(endCalls).toHaveLength(1);
    const body = JSON.parse(endCalls[0][1].body);
    expect(body.sessionId).toBe(client.getSessionId());
    expect(body.status).toBe('errored');
    expect(typeof body.durationMs).toBe('number');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('endSession is idempotent (only one sessions/end POST)', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
    });
    client.endSession();
    client.endSession();
    client.endSession();
    await client.flush();
    expect(callsTo('/ingest/v1/sessions/end')).toHaveLength(1);
  });

  it('ends an ok session via destroy()', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
    });
    client.destroy();
    await Promise.resolve();

    const endCalls = callsTo('/ingest/v1/sessions/end');
    expect(endCalls).toHaveLength(1);
    expect(JSON.parse(endCalls[0][1].body).status).toBe('ok');
  });

  it('does not recover abnormal after a clean session shutdown', async () => {
    const store = makeStore();
    const key = 'allstak.next.session.clean';
    const first = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
      sessionStateStore: store,
      sessionStateKey: key,
    });
    first.endSession();
    await first.flush();
    fetchSpy.mockClear();

    const second = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
      sessionStateStore: store,
      sessionStateKey: key,
    });
    await second.flush();

    expect(callsTo('/ingest/v1/sessions/end')).toHaveLength(0);
    expect(callsTo('/ingest/v1/sessions/start')).toHaveLength(1);
  });

  it('recovers a previous open session as abnormal', async () => {
    const store = makeStore();
    const key = 'allstak.next.session.abnormal';
    const first = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
      sessionStateStore: store,
      sessionStateKey: key,
    });
    const previousId = first.getSessionId();
    await first.flush();
    fetchSpy.mockClear();

    const second = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
      sessionStateStore: store,
      sessionStateKey: key,
    });
    await second.flush();

    const recovered = bodyOf('/ingest/v1/sessions/end');
    expect(recovered).toMatchObject({ sessionId: previousId, status: 'abnormal' });
  });

  it('recovers a previous crashed session as crashed', async () => {
    const store = makeStore();
    const key = 'allstak.next.session.crashed';
    const first = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
      sessionStateStore: store,
      sessionStateKey: key,
    });
    const previousId = first.getSessionId();
    await first.captureException(new Error('fatal'), { mechanism: 'uncaughtException' });
    await first.flush();
    fetchSpy.mockClear();

    const second = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
      sessionStateStore: store,
      sessionStateKey: key,
    });
    await second.flush();

    const recovered = bodyOf('/ingest/v1/sessions/end');
    expect(recovered).toMatchObject({ sessionId: previousId, status: 'crashed' });
  });

  it('drops corrupt session state safely', async () => {
    const store = makeStore('{not-json');
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
      sessionStateStore: store,
      sessionStateKey: 'allstak.next.session.corrupt',
    });
    await client.flush();

    expect(callsTo('/ingest/v1/sessions/end')).toHaveLength(0);
    expect(callsTo('/ingest/v1/sessions/start')).toHaveLength(1);
  });

  it('does not duplicate a recovered abnormal session report', async () => {
    const store = makeStore();
    const key = 'allstak.next.session.dedupe';
    new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
      sessionStateStore: store,
      sessionStateKey: key,
    });
    fetchSpy.mockClear();

    const second = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
      sessionStateStore: store,
      sessionStateKey: key,
    });
    second.endSession();
    await second.flush();
    expect(callsTo('/ingest/v1/sessions/end').map(([, init]) => JSON.parse(init.body).status))
      .toContain('abnormal');
    fetchSpy.mockClear();

    const third = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableAutoSessionTracking: true,
      sessionStateStore: store,
      sessionStateKey: key,
    });
    await third.flush();

    expect(callsTo('/ingest/v1/sessions/end').map(([, init]) => JSON.parse(init.body).status))
      .not.toContain('abnormal');
  });

  it('start failure never throws into init (fail-open)', () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    expect(
      () =>
        new AllStakNextClient({
          apiKey: 'ask_test',
          host: 'https://api.allstak.sa',
          release: '1.0.0',
          enableAutoSessionTracking: true,
        }),
    ).not.toThrow();
  });
});
