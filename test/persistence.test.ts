import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  OfflineQueue,
  isPersistablePath,
  setPersistenceAdapter,
  type PersistenceAdapter,
  type PersistedEnvelope,
} from '../src/persistence';
import { AllStakNextClient, setClient } from '../src/client';

/**
 * Controllable in-memory adapter used to make the offline queue deterministic
 * in tests (no real localStorage / fs). It is wired into the client via the
 * pluggable `setPersistenceAdapter` seam.
 */
class FakeAdapter implements PersistenceAdapter {
  store: PersistedEnvelope[] = [];
  available = true;
  isAvailable(): boolean {
    return this.available;
  }
  load(): PersistedEnvelope[] {
    return [...this.store];
  }
  save(envelopes: PersistedEnvelope[]): void {
    this.store = [...envelopes];
  }
  clear(): void {
    this.store = [];
  }
}

describe('OfflineQueue (bounded, fail-open store)', () => {
  it('excludes session lifecycle paths from persistence', () => {
    const adapter = new FakeAdapter();
    const q = new OfflineQueue({ adapter });

    q.persist('/ingest/v1/sessions/start', '{"sessionId":"a"}');
    q.persist('/ingest/v1/sessions/end', '{"sessionId":"a"}');
    expect(adapter.store).toHaveLength(0);

    q.persist('/ingest/v1/errors', '{"message":"boom"}');
    expect(adapter.store).toHaveLength(1);

    expect(isPersistablePath('/ingest/v1/sessions/start')).toBe(false);
    expect(isPersistablePath('/ingest/v1/sessions/end')).toBe(false);
    expect(isPersistablePath('/ingest/v1/errors')).toBe(true);
    expect(isPersistablePath('/ingest/v1/spans')).toBe(true);
    expect(isPersistablePath('/ingest/v1/http-requests')).toBe(true);
  });

  it('caps by count and drops the OLDEST entries first', () => {
    const adapter = new FakeAdapter();
    const q = new OfflineQueue({ adapter, limits: { maxCount: 3 } });

    for (let i = 0; i < 6; i++) q.persist('/ingest/v1/errors', `{"n":${i}}`);

    const bodies = adapter.store.map((e) => JSON.parse(e.body).n);
    expect(adapter.store).toHaveLength(3);
    // Oldest (0,1,2) dropped; newest 3 retained.
    expect(bodies).toEqual([3, 4, 5]);
  });

  it('caps by total bytes and drops the OLDEST entries first', () => {
    const adapter = new FakeAdapter();
    // each body is ~10 bytes; cap at ~25 bytes ⇒ keep ~2 newest
    const q = new OfflineQueue({ adapter, limits: { maxCount: 100, maxBytes: 25 } });

    q.persist('/ingest/v1/errors', '{"n":"aaa"}');
    q.persist('/ingest/v1/errors', '{"n":"bbb"}');
    q.persist('/ingest/v1/errors', '{"n":"ccc"}');

    expect(adapter.store.length).toBeLessThanOrEqual(2);
    // Newest must survive.
    expect(adapter.store[adapter.store.length - 1].body).toContain('ccc');
  });

  it('drops entries older than maxAge on load', () => {
    const adapter = new FakeAdapter();
    const q = new OfflineQueue({ adapter, limits: { maxAgeMs: 1000 } });

    adapter.store = [
      { path: '/ingest/v1/errors', body: '{"old":1}', ts: Date.now() - 5000 },
      { path: '/ingest/v1/errors', body: '{"fresh":1}', ts: Date.now() },
    ];

    const loaded = q.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].body).toContain('fresh');
  });

  it('persist never throws when the adapter is unavailable / throwing', () => {
    const throwingAdapter: PersistenceAdapter = {
      isAvailable: () => false,
      load: () => {
        throw new Error('boom');
      },
      save: () => {
        throw new Error('boom');
      },
      clear: () => {
        throw new Error('boom');
      },
    };
    const q = new OfflineQueue({ adapter: throwingAdapter });
    expect(() => q.persist('/ingest/v1/errors', '{}')).not.toThrow();
    expect(() => q.loadAll()).not.toThrow();
    expect(q.loadAll()).toEqual([]);
  });
});

describe('AllStakNextClient offline queue integration', () => {
  let adapter: FakeAdapter;

  beforeEach(() => {
    adapter = new FakeAdapter();
    setPersistenceAdapter(adapter);
    setClient(null);
  });

  afterEach(() => {
    setPersistenceAdapter(null);
    setClient(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function newClient(extra: Record<string, unknown> = {}) {
    return new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableOfflineQueue: true,
      // keep session traffic out of these assertions
      enableAutoSessionTracking: false,
      ...extra,
    });
  }

  it('PERSISTS a scrubbed payload when delivery fails (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const client = newClient();
    await client.captureException(new Error('boom'));

    expect(adapter.store).toHaveLength(1);
    expect(adapter.store[0].path).toBe('/ingest/v1/errors');
    expect(JSON.parse(adapter.store[0].body).message).toBe('boom');
  });

  it('PERSISTS on a retry-able 5xx but NOT on a permanent 4xx', async () => {
    const headers = { get: () => null };
    // First call (errors) → 500 retry-able → persisted.
    // Second call (spans)  → 400 permanent  → dropped (not persisted).
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, headers })
      .mockResolvedValueOnce({ ok: false, status: 400, headers });
    vi.stubGlobal('fetch', fetchSpy);

    const client = newClient();
    await client.captureException(new Error('server-down'));
    await client.captureSpan({
      traceId: 't', spanId: 's', parentSpanId: '', operation: 'op', description: '',
      status: 'ok', durationMs: 1, startTimeMillis: 0, endTimeMillis: 1, service: 'svc',
      environment: 'test', tags: {}, data: '{}',
    });

    expect(adapter.store).toHaveLength(1);
    expect(adapter.store[0].path).toBe('/ingest/v1/errors');
  });

  it('SCRUBS before persist — no secret hits the store', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const client = newClient();
    await client.captureException(new Error('boom'), {
      password: 'hunter2',
      authorization: 'Bearer abc.def',
      nested: { api_key: 'sk_live_123' },
    });

    expect(adapter.store).toHaveLength(1);
    const raw = adapter.store[0].body;
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('sk_live_123');
    expect(raw).not.toContain('Bearer abc.def');
    expect(raw).toContain('[REDACTED]');
  });

  it('does NOT persist session lifecycle calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const client = newClient({ enableAutoSessionTracking: true });
    // The session start fired (and failed) at init; flush its rejection.
    await client.flush();
    client.endSession();
    await client.flush();

    // Only non-session telemetry may ever be persisted.
    for (const env of adapter.store) {
      expect(env.path.startsWith('/ingest/v1/sessions/')).toBe(false);
    }
  });

  it('DRAINS persisted events on init and removes accepted ones', async () => {
    // Pre-seed the store as if a previous launch persisted two events.
    adapter.store = [
      { path: '/ingest/v1/errors', body: '{"message":"restart-1"}', ts: Date.now() },
      { path: '/ingest/v1/errors', body: '{"message":"restart-2"}', ts: Date.now() },
    ];
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);

    const client = newClient();
    await client._awaitInitDrainForTest();

    // Both re-sent through the transport...
    const replayed = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/ingest/v1/errors'));
    expect(replayed).toHaveLength(2);
    // ...and removed from the store once accepted.
    expect(adapter.store).toHaveLength(0);
  });

  it('KEEPS a persisted event when the replay still fails (survives next launch)', async () => {
    adapter.store = [{ path: '/ingest/v1/errors', body: '{"message":"keep-me"}', ts: Date.now() }];
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('still offline')));

    const client = newClient();
    await client._awaitInitDrainForTest();

    expect(adapter.store).toHaveLength(1);
    expect(JSON.parse(adapter.store[0].body).message).toBe('keep-me');
  });

  it('OPT-OUT: enableOfflineQueue=false disables persistence entirely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      release: '1.0.0',
      enableOfflineQueue: false,
      enableAutoSessionTracking: false,
    });
    expect(client.isOfflineQueueEnabled()).toBe(false);
    await client.captureException(new Error('boom'));
    expect(adapter.store).toHaveLength(0);
  });

  it('graceful no-op when the store is unavailable (never throws, in-memory behavior)', async () => {
    const throwingAdapter: PersistenceAdapter = {
      isAvailable: () => false,
      load: () => {
        throw new Error('no storage');
      },
      save: () => {
        throw new Error('no storage');
      },
      clear: () => {},
    };
    setPersistenceAdapter(throwingAdapter);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const client = newClient();
    await expect(client.captureException(new Error('boom'))).resolves.toBeUndefined();
    await expect(client._awaitInitDrainForTest()).resolves.toBeUndefined();
  });

  it('flushViaBeacon ships persisted events via navigator.sendBeacon on tab close', () => {
    adapter.store = [
      { path: '/ingest/v1/errors', body: '{"message":"a"}', ts: Date.now() },
      { path: '/ingest/v1/errors', body: '{"message":"b"}', ts: Date.now() },
    ];
    const beacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('fetch', vi.fn());

    const client = newClient();
    client.flushViaBeacon();

    expect(beacon).toHaveBeenCalledTimes(2);
    const [url] = beacon.mock.calls[0];
    expect(String(url)).toContain('/ingest/v1/errors');
    expect(String(url)).toContain('allstak_key=ask_test');
    // Accepted beacons are removed from the store.
    expect(adapter.store).toHaveLength(0);
  });

  it('flushViaBeacon keeps events the browser refused to queue', () => {
    adapter.store = [{ path: '/ingest/v1/errors', body: '{"message":"a"}', ts: Date.now() }];
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(false) });
    vi.stubGlobal('fetch', vi.fn());

    const client = newClient();
    client.flushViaBeacon();
    expect(adapter.store).toHaveLength(1);
  });

  it('flushViaBeacon is a safe no-op when sendBeacon is unavailable', () => {
    adapter.store = [{ path: '/ingest/v1/errors', body: '{"message":"a"}', ts: Date.now() }];
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', vi.fn());
    const client = newClient();
    expect(() => client.flushViaBeacon()).not.toThrow();
    expect(adapter.store).toHaveLength(1);
  });
});
