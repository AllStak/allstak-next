import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { withAllStakMiddleware } from '../src/middleware';
import { AllStakNextClient, setClient } from '../src/client';

describe('withAllStakMiddleware', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    setClient(null);
    vi.restoreAllMocks();
  });

  function makeRequest(url = 'https://example.com/api', method = 'GET') {
    return { url, method, headers: new Headers() };
  }

  function makeResponse() {
    return { headers: new Headers() };
  }

  it('passes through successful responses', async () => {
    const response = makeResponse();
    const handler = vi.fn().mockResolvedValue(response);
    const wrapped = withAllStakMiddleware(handler);

    const result = await wrapped(makeRequest());
    expect(result).toBe(response);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('adds trace headers to response', async () => {
    const response = makeResponse();
    const handler = vi.fn().mockResolvedValue(response);
    const wrapped = withAllStakMiddleware(handler);

    const result = await wrapped(makeRequest());
    expect(result.headers.get('x-allstak-trace-id')).toBeTruthy();
    expect(result.headers.get('server-timing')).toMatch(/allstak;dur=\d+/);
  });

  it('captures errors and re-throws', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    const captureSpy = vi.spyOn(client, 'captureException');
    setClient(client);

    const error = new Error('middleware boom');
    const handler = vi.fn().mockRejectedValue(error);
    const wrapped = withAllStakMiddleware(handler);

    await expect(wrapped(makeRequest('https://example.com/fail', 'POST'))).rejects.toThrow('middleware boom');

    expect(captureSpy).toHaveBeenCalledWith(error, expect.objectContaining({
      mechanism: 'middleware',
      url: 'https://example.com/fail',
      method: 'POST',
    }));
  });

  it('works without a client installed', async () => {
    const error = new Error('no client');
    const handler = vi.fn().mockRejectedValue(error);
    const wrapped = withAllStakMiddleware(handler);

    // Should still re-throw even without a client
    await expect(wrapped(makeRequest())).rejects.toThrow('no client');
  });

  it('handles non-Error throws', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    const captureSpy = vi.spyOn(client, 'captureException');
    setClient(client);

    const handler = vi.fn().mockRejectedValue('string error');
    const wrapped = withAllStakMiddleware(handler);

    await expect(wrapped(makeRequest())).rejects.toBe('string error');
    expect(captureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'string error' }),
      expect.anything(),
    );
  });
});
