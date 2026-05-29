import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AllStakNextClient, setClient } from '../src/client';
import { instrumentFetch, uninstrumentFetch, isFetchInstrumented } from '../src/fetch-instrumentation';

/**
 * Outbound HTTP instrumentation: a global `fetch` wrapper that emits
 * direction:'outbound' HttpRequestPayloads to /ingest/v1/http-requests AND
 * injects W3C traceparent + baggage on the outbound request, while skipping the
 * SDK's own ingest host to avoid recursion.
 */
describe('instrumentFetch (outbound HTTP)', () => {
  let underlying: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setClient(null);
    uninstrumentFetch();
    // The underlying fetch the wrapper delegates to. Records the request it saw.
    underlying = vi.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
    }));
    vi.stubGlobal('fetch', underlying as unknown as typeof fetch);
    vi.stubGlobal('Headers', Headers);
    vi.stubGlobal('Request', Request);
    vi.stubGlobal('URL', URL);
  });

  afterEach(() => {
    uninstrumentFetch();
    setClient(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  /** Find the ingest POST that carries the outbound http-request payload. */
  function outboundRequestCall() {
    return underlying.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/http-requests'));
  }
  /** Find the (non-ingest) downstream call. */
  function downstreamCall() {
    return underlying.mock.calls.find(([url]) => !String(url).includes('/ingest/v1/'));
  }

  it('installs and uninstalls idempotently', () => {
    expect(isFetchInstrumented()).toBe(false);
    const teardown = instrumentFetch();
    expect(isFetchInstrumented()).toBe(true);
    // Second install is a no-op while already installed.
    instrumentFetch();
    expect(isFetchInstrumented()).toBe(true);
    teardown();
    expect(isFetchInstrumented()).toBe(false);
  });

  it('emits a direction:outbound http-request for a downstream call', async () => {
    const client = installClient();
    instrumentFetch();

    const res = await fetch('https://downstream.example.com/api/v2/data?x=1', { method: 'POST' });
    expect((res as { status: number }).status).toBe(200);
    await client.flush();

    const ingest = outboundRequestCall();
    expect(ingest).toBeTruthy();
    const payload = JSON.parse((ingest![1] as { body: string }).body).requests[0];
    expect(payload).toMatchObject({
      direction: 'outbound',
      method: 'POST',
      host: 'downstream.example.com',
      path: '/api/v2/data?x=1',
      statusCode: 200,
      environment: 'production',
      release: '1.0.0',
    });
    expect(payload.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(payload.spanId).toMatch(/^[a-f0-9]{16}$/);
  });

  it('injects traceparent + baggage on the downstream request (string input)', async () => {
    const client = installClient();
    instrumentFetch();

    await fetch('https://downstream.example.com/users');
    await client.flush();

    const call = downstreamCall();
    expect(call).toBeTruthy();
    const init = call![1] as { headers: Headers };
    const headers = init.headers as Headers;
    const traceparent = headers.get('traceparent');
    expect(traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    expect(headers.get('baggage')).toContain('allstak-trace_id=');
    expect(headers.get('x-allstak-trace-id')).toMatch(/^[a-f0-9]{32}$/);
  });

  it('continues an existing upstream traceparent rather than overwriting it', async () => {
    const client = installClient();
    instrumentFetch();

    const upstream = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await fetch('https://downstream.example.com/x', { headers: { traceparent: upstream } });
    await client.flush();

    const init = downstreamCall()![1] as { headers: Headers };
    expect((init.headers as Headers).get('traceparent')).toBe(upstream);
    // baggage still gets our allstak entries appended.
    expect((init.headers as Headers).get('baggage')).toContain('allstak-trace_id=');
  });

  it('injects headers when called with a Request object without mutating it', async () => {
    const client = installClient();
    instrumentFetch();

    const original = new Request('https://downstream.example.com/req-obj', { method: 'PUT' });
    await fetch(original);
    await client.flush();

    // The downstream call received our trace headers via the merged init.
    const call = downstreamCall();
    const init = call![1] as { headers: Headers };
    expect((init.headers as Headers).get('traceparent')).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    // Original Request was not mutated.
    expect(original.headers.get('traceparent')).toBeNull();

    const payload = JSON.parse((outboundRequestCall()![1] as { body: string }).body).requests[0];
    expect(payload.method).toBe('PUT');
    expect(payload.host).toBe('downstream.example.com');
  });

  it('SKIPS the SDK ingest host to avoid recursion', async () => {
    const client = installClient();
    instrumentFetch();

    // Directly hit the ingest host: must NOT emit its own outbound record.
    await fetch('https://api.allstak.sa/ingest/v1/errors', { method: 'POST', body: '{}' });
    await client.flush();

    // Only the manual call exists; no extra outbound http-request was emitted
    // for the ingest call itself.
    const ingestCalls = underlying.mock.calls.filter(([url]) =>
      String(url) === 'https://api.allstak.sa/ingest/v1/errors',
    );
    expect(ingestCalls).toHaveLength(1);
    expect(outboundRequestCall()).toBeFalsy();
    // No trace headers were injected onto the ingest call.
    const init = underlying.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/errors'))![1];
    expect((init as RequestInit | undefined)?.headers).not.toBeInstanceOf(Headers);
  });

  it('returns the response unchanged and records on network error', async () => {
    const client = installClient();
    instrumentFetch();
    underlying.mockImplementation(async (url: unknown) => {
      if (String(url).endsWith('/ingest/v1/http-requests')) {
        return { ok: true, status: 202, headers: { get: () => null } };
      }
      throw new Error('network down');
    });

    await expect(fetch('https://downstream.example.com/boom')).rejects.toThrow('network down');
    await client.flush();

    const payload = JSON.parse((outboundRequestCall()![1] as { body: string }).body).requests[0];
    expect(payload.direction).toBe('outbound');
    expect(payload.statusCode).toBe(0); // network error → status 0
  });

  it('passes through when no client is installed (still injects headers, no recursion)', async () => {
    instrumentFetch();
    const res = await fetch('https://downstream.example.com/no-client');
    expect((res as { status: number }).status).toBe(200);
    // Without a client, captureRequest is a no-op, so no ingest POST.
    expect(outboundRequestCall()).toBeFalsy();
    // Headers were still injected on the downstream request.
    const init = downstreamCall()![1] as { headers: Headers };
    expect((init.headers as Headers).get('traceparent')).toMatch(/^00-/);
  });
});
