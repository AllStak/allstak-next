import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AllStakNextClient, parseStack, getClient, setClient, parseRetryAfter } from '../src/client';

describe('AllStakNextClient', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    setClient(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends structured error payload with captureException', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      environment: 'test',
      release: '1.0.0',
    });
    const error = new Error('test error');
    await client.captureException(error, { extra: 'data' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.allstak.sa/ingest/v1/errors');
    expect(init.method).toBe('POST');
    expect(init.headers['X-AllStak-Key']).toBe('ask_test');

    const body = JSON.parse(init.body);
    expect(body.exceptionClass).toBe('Error');
    expect(body.message).toBe('test error');
    expect(body.level).toBe('error');
    expect(body.environment).toBe('test');
    expect(body.release).toBe('1.0.0');
    expect(body.metadata.extra).toBe('data');
    expect(body.metadata.sdkName).toBe('@allstak/next');
    expect(body.timestamp).toBeTypeOf('string');
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
    expect(body.sdkName).toBe('@allstak/next');
    expect(body.sdkVersion).toBe('0.1.3');
    expect(body.platform).toBe('node');
    expect(body.stackTrace).toBeInstanceOf(Array);
    if (body.stackTrace.length > 0) {
      expect(body.stackTrace[0]).toBeTypeOf('string');
    }
    expect(body.frames).toBeInstanceOf(Array);
  });

  it('sends message payload with captureMessage', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
    });
    await client.captureMessage('hello world', 'warning');

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.exceptionClass).toBe('Message');
    expect(body.message).toBe('hello world');
    expect(body.level).toBe('warning');
  });

  it('defaults captureMessage level to info', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    await client.captureMessage('test');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.level).toBe('info');
  });

  it('does not send when apiKey is missing', async () => {
    const client = new AllStakNextClient({});
    await client.captureException(new Error('no key'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts dsn as alias for apiKey', async () => {
    const client = new AllStakNextClient({ dsn: 'ask_dsn_test' });
    await client.captureException(new Error('dsn test'));
    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers['X-AllStak-Key']).toBe('ask_dsn_test');
  });

  it('fails open when fetch rejects', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    await expect(client.captureException(new Error('fail'))).resolves.toBeUndefined();
  });

  it('maintains breadcrumb ring buffer', () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    for (let i = 0; i < 35; i++) {
      client.addBreadcrumb({ type: 'custom', message: `crumb-${i}` });
    }
    const crumbs = client.getBreadcrumbs();
    expect(crumbs.length).toBe(30);
    expect(crumbs[0].message).toBe('crumb-5');
    expect(crumbs[29].message).toBe('crumb-34');
  });

  it('includes breadcrumbs in error payload', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    client.addBreadcrumb({ type: 'navigation', message: 'page /home' });
    await client.captureException(new Error('test'));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.breadcrumbs).toHaveLength(1);
    expect(body.breadcrumbs[0].type).toBe('navigation');
    expect(body.breadcrumbs[0].timestamp).toBeTypeOf('string');
    expect(() => new Date(body.breadcrumbs[0].timestamp).toISOString()).not.toThrow();
  });

  it('flush resolves all pending requests', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    client.captureException(new Error('one'));
    client.captureException(new Error('two'));
    await client.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('destroy prevents further captures', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    client.destroy();
    await client.captureException(new Error('destroyed'));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.isDestroyed()).toBe(true);
  });

  it('strips trailing slash from host', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa/',
    });
    await client.captureException(new Error('slash'));
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.allstak.sa/ingest/v1/errors');
  });

  it('uses endpoint as alias for host', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      endpoint: 'https://custom.allstak.sa',
    });
    await client.captureException(new Error('endpoint'));
    expect(fetchSpy.mock.calls[0][0]).toBe('https://custom.allstak.sa/ingest/v1/errors');
  });
});

describe('parseStack', () => {
  it('parses V8-style stack traces', () => {
    const stack = `Error: test
    at myFunction (/app/src/handler.ts:10:5)
    at Object.<anonymous> (/app/node_modules/lib/index.js:20:10)`;

    const frames = parseStack(stack);
    expect(frames).toHaveLength(2);
    expect(frames[0].function).toBe('myFunction');
    expect(frames[0].filename).toBe('/app/src/handler.ts');
    expect(frames[0].lineno).toBe(10);
    expect(frames[0].colno).toBe(5);
    expect(frames[0].in_app).toBe(true);
    expect(frames[1].in_app).toBe(false);
  });

  it('returns empty array for undefined stack', () => {
    expect(parseStack(undefined)).toEqual([]);
  });
});

describe('client singleton', () => {
  it('get/set client works', () => {
    expect(getClient()).toBeNull();
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    setClient(client);
    expect(getClient()).toBe(client);
    setClient(null);
    expect(getClient()).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  const NOW = 1_700_000_000_000;

  it('parses delta-seconds: "2" → 2000', () => {
    expect(parseRetryAfter('2', NOW)).toBe(2000);
  });

  it('parses HTTP-date into a delta-from-now in ms', () => {
    const future = new Date(NOW + 5000).toUTCString();
    expect(parseRetryAfter(future, NOW)).toBe(5000);
  });

  it('returns 0 for null and empty string', () => {
    expect(parseRetryAfter(null, NOW)).toBe(0);
    expect(parseRetryAfter('', NOW)).toBe(0);
    expect(parseRetryAfter('   ', NOW)).toBe(0);
  });

  it('returns 0 for garbage', () => {
    expect(parseRetryAfter('soon', NOW)).toBe(0);
    expect(parseRetryAfter('12.5', NOW)).toBe(0);
    expect(parseRetryAfter('-3', NOW)).toBe(0);
  });

  it('clamps anything over 300s to 300000', () => {
    expect(parseRetryAfter('400', NOW)).toBe(300_000);
    expect(parseRetryAfter('301', NOW)).toBe(300_000);
    expect(parseRetryAfter('300', NOW)).toBe(300_000);
    const farFuture = new Date(NOW + 600_000).toUTCString();
    expect(parseRetryAfter(farFuture, NOW)).toBe(300_000);
  });

  it('treats a past HTTP-date as 0', () => {
    const past = new Date(NOW - 5000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBe(0);
  });
});

describe('transport Retry-After handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function headers(map: Record<string, string>) {
    return { get: (name: string) => map[name] ?? map[name.toLowerCase()] ?? null };
  }

  it('waits the Retry-After delay and retries once on 429 with header', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: headers({ 'Retry-After': '2' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: headers({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    const promise = client.captureMessage('hi');

    // First POST has fired; the retry is gated behind the 2s wait.
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a 2xx response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: headers({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    await client.captureMessage('hi');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('does not retry on 429 when Retry-After is absent (preserves fail-open)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 429, headers: headers({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    await client.captureMessage('hi');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
