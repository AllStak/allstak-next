import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { withAllStakRouteHandler, withAllStakServerAction } from '../src/route-handler';
import { AllStakNextClient, setClient } from '../src/client';

describe('withAllStakRouteHandler', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    setClient(null);
    vi.restoreAllMocks();
  });

  function makeRequest(url = 'https://example.com/api/users?active=true', method = 'GET', traceparent?: string, requestId?: string) {
    const headers = new Headers();
    if (traceparent) headers.set('traceparent', traceparent);
    if (requestId) headers.set('x-request-id', requestId);
    return { url, method, headers };
  }

  function makeResponse(status = 200) {
    return { status, headers: new Headers() };
  }

  it('injects trace headers and captures correlated request/span telemetry', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      environment: 'test',
      release: '1.2.3',
    });
    setClient(client);

    const handler = vi.fn().mockResolvedValue(makeResponse(201));
    const wrapped = withAllStakRouteHandler(handler);

    const result = await wrapped(makeRequest('https://example.com/api/users?active=true', 'POST'));
    await client.flush();

    const traceId = result.headers.get('x-allstak-trace-id');
    const requestId = result.headers.get('x-allstak-request-id');
    const spanId = result.headers.get('x-allstak-span-id');
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(requestId).toMatch(/^[a-f0-9]{32}$/);
    expect(spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(result.headers.get('traceparent')).toBe(`00-${traceId}-${spanId}-01`);
    expect(result.headers.get('allstak-baggage')).toContain(`allstak-trace_id=${traceId}`);
    expect(result.headers.get('baggage')).toContain(`allstak-request_id=${requestId}`);
    expect(result.headers.get('server-timing')).toMatch(/allstak;dur=\d+/);

    const requestCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/http-requests'));
    const spanCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/spans'));
    expect(requestCall).toBeTruthy();
    expect(spanCall).toBeTruthy();

    const requestPayload = JSON.parse(requestCall![1].body);
    const spanPayload = JSON.parse(spanCall![1].body);
    expect(requestPayload.requests[0]).toMatchObject({
      traceId,
      requestId,
      spanId,
      parentSpanId: '',
      direction: 'inbound',
      method: 'POST',
      host: 'example.com',
      path: '/api/users?active=true',
      statusCode: 201,
      environment: 'test',
      release: '1.2.3',
    });
    expect(spanPayload.spans[0]).toMatchObject({
      traceId,
      spanId,
      parentSpanId: '',
      operation: 'next.route',
      description: 'POST /api/users?active=true',
      status: 'ok',
      environment: 'test',
    });
  });

  it('continues a W3C traceparent trace id', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    setClient(client);
    const upstreamTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const wrapped = withAllStakRouteHandler(async () => makeResponse(200));

    const result = await wrapped(makeRequest(
      'https://example.com/api/continue',
      'GET',
      `00-${upstreamTraceId}-00f067aa0ba902b7-01`,
      'req-from-upstream',
    ));
    await client.flush();

    expect(result.headers.get('x-allstak-trace-id')).toBe(upstreamTraceId);
    expect(result.headers.get('x-allstak-request-id')).toBe('req-from-upstream');
    expect(result.headers.get('baggage')).toContain(`allstak-trace_id=${upstreamTraceId}`);
    expect(result.headers.get('baggage')).toContain('allstak-request_id=req-from-upstream');
    const spanCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/spans'));
    const span = JSON.parse(spanCall![1].body).spans[0];
    expect(span.traceId).toBe(upstreamTraceId);
    expect(span.parentSpanId).toBe('00f067aa0ba902b7');
  });

  it('captures route errors with the same trace ids and rethrows', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    const captureSpy = vi.spyOn(client, 'captureException');
    setClient(client);

    const error = new Error('route boom');
    const wrapped = withAllStakRouteHandler(async () => {
      throw error;
    });

    await expect(wrapped(makeRequest('https://example.com/api/fail', 'PATCH'))).rejects.toThrow('route boom');
    await client.flush();

    expect(captureSpy).toHaveBeenCalledWith(error, expect.objectContaining({
      mechanism: 'route-handler',
      method: 'PATCH',
      traceId: expect.stringMatching(/^[a-f0-9]{32}$/),
      requestId: expect.stringMatching(/^[a-f0-9]{32}$/),
    }));

    const requestCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/http-requests'));
    const spanCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/spans'));
    expect(JSON.parse(requestCall![1].body).requests[0]).toMatchObject({
      statusCode: 500,
      method: 'PATCH',
      path: '/api/fail',
    });
    expect(JSON.parse(spanCall![1].body).spans[0]).toMatchObject({
      operation: 'next.route',
      status: 'error',
    });
  });

  it('works without an installed client', async () => {
    const wrapped = withAllStakRouteHandler(async () => makeResponse(204));

    const result = await wrapped(makeRequest());

    expect(result.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('withAllStakServerAction', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    setClient(null);
    vi.restoreAllMocks();
  });

  it('captures a correlated server action span on success', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      environment: 'test',
    });
    setClient(client);

    const action = withAllStakServerAction(async (value: number) => value + 1, {
      name: 'increment',
      tags: { feature: 'counter' },
    });

    await expect(action(41)).resolves.toBe(42);
    await client.flush();

    const spanCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/spans'));
    expect(spanCall).toBeTruthy();
    const span = JSON.parse(spanCall![1].body).spans[0];
    expect(span).toMatchObject({
      traceId: expect.stringMatching(/^[a-f0-9]{32}$/),
      spanId: expect.stringMatching(/^[a-f0-9]{16}$/),
      operation: 'next.server_action',
      description: 'increment',
      status: 'ok',
      environment: 'test',
      tags: { component: 'server-action', feature: 'counter' },
    });
  });

  it('captures server action errors with the same trace ids and rethrows', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    const captureSpy = vi.spyOn(client, 'captureException');
    setClient(client);
    const error = new Error('action boom');
    const action = withAllStakServerAction(async () => {
      throw error;
    }, { name: 'saveOrder' });

    await expect(action()).rejects.toThrow('action boom');
    await client.flush();

    expect(captureSpy).toHaveBeenCalledWith(error, expect.objectContaining({
      mechanism: 'server-action',
      action: 'saveOrder',
      traceId: expect.stringMatching(/^[a-f0-9]{32}$/),
      spanId: expect.stringMatching(/^[a-f0-9]{16}$/),
    }));
    const spanCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/spans'));
    expect(JSON.parse(spanCall![1].body).spans[0]).toMatchObject({
      operation: 'next.server_action',
      description: 'saveOrder',
      status: 'error',
    });
  });
});
