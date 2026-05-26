/**
 * Manual capture + scope API tests for @allstak/next.
 *
 * Verifies the additive parity surface:
 *   - module-level captureException / captureMessage route through the
 *     registered AllStakNextClient (NOT the old raw-fetch shadow), no real net
 *   - setUser / setTag / setContext attach to subsequently captured events
 *   - withScope forks a temporary scope that is popped afterwards
 *   - concurrent request scopes (withAllStakRouteHandler) do not leak
 *   - auto-capture (route-handler wrapper) includes scope-set user/tags
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllStakNextClient,
  setClient,
  initAllStakNext,
  captureException,
  captureMessage,
  setUser,
  setTag,
  setTags,
  setContext,
  setExtra,
  addBreadcrumb,
  withScope,
  configureScope,
  withAllStakRouteHandler,
} from '../src/index';

interface FetchCall { url: string; body: any; }

function captureFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, headers: { get: () => null } } as any;
  }));
  return calls;
}

function errors(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.url.endsWith('/ingest/v1/errors'));
}

function register(beforeSend?: (e: any) => any): void {
  setClient(new AllStakNextClient({
    apiKey: 'ask_dev_test',
    host: 'https://api.allstak.sa',
    environment: 'test',
    beforeSend,
  }));
}

describe('@allstak/next manual capture + scope', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => {
    configureScope((s) => s.clear());
    setClient(null);
    vi.unstubAllGlobals();
  });

  it('module-level captureException routes through the client (frames + sdk meta)', async () => {
    const calls = captureFetch();
    register();
    await captureException(new Error('manual boom'));
    expect(errors(calls).length).toBe(1);
    const ev = errors(calls)[0].body;
    expect(ev.message).toBe('manual boom');
    expect(ev.exceptionClass).toBe('Error');
    // Client pipeline attaches structured frames + sdk identity — the degraded
    // raw-fetch shadow did neither.
    expect(Array.isArray(ev.frames)).toBe(true);
    expect(ev.sdkName).toBe('@allstak/next');
    expect(calls[0].url).toBe('https://api.allstak.sa/ingest/v1/errors');
  });

  it('captureMessage routes through the client', async () => {
    const calls = captureFetch();
    register();
    await captureMessage('hello world', 'warning');
    expect(errors(calls).length).toBe(1);
    const ev = errors(calls)[0].body;
    expect(ev.message).toBe('hello world');
    expect(ev.level).toBe('warning');
    expect(ev.exceptionClass).toBe('Message');
  });

  it('initAllStakNext registers a real client (no raw-fetch shadow)', async () => {
    const calls = captureFetch();
    initAllStakNext({ apiKey: 'ask_dev_test', host: 'https://api.allstak.sa', release: 'r1' });
    await captureException(new Error('via init'));
    const ev = errors(calls)[0].body;
    // frames[] is produced only by the client pipeline.
    expect(Array.isArray(ev.frames)).toBe(true);
    expect(ev.release).toBe('r1');
  });

  it('setUser / setTag / setContext / setExtra attach to captured events', async () => {
    const calls = captureFetch();
    register();
    setUser({ id: 'u-42', email: 'a@b.co' });
    setTag('feature', 'checkout');
    setTags({ region: 'eu' });
    setExtra('orderId', 'o-9');
    setContext('app', { build: '1.2.3' });
    await captureException(new Error('with scope'));
    const meta = errors(calls)[0].body.metadata;
    expect(meta.user).toMatchObject({ id: 'u-42', email: 'a@b.co' });
    expect(meta['tag.feature']).toBe('checkout');
    expect(meta['tag.region']).toBe('eu');
    expect(meta['extra.orderId']).toBe('o-9');
    expect(meta['context.app']).toEqual({ build: '1.2.3' });
  });

  it('addBreadcrumb attaches breadcrumbs to captured events', async () => {
    const calls = captureFetch();
    register();
    addBreadcrumb({ type: 'custom', message: 'step-1' });
    await captureException(new Error('crumbs'));
    const crumbs = errors(calls)[0].body.breadcrumbs;
    expect(crumbs.some((c: any) => c.message === 'step-1')).toBe(true);
  });

  it('withScope forks a temporary scope that is popped afterwards', async () => {
    const calls = captureFetch();
    register();
    await withScope(async (scope) => {
      scope.setTag('temp', 'yes');
      await captureException(new Error('inside'));
    });
    await captureException(new Error('outside'));
    const inside = errors(calls).find((c) => c.body.message === 'inside')!.body;
    const outside = errors(calls).find((c) => c.body.message === 'outside')!.body;
    expect(inside.metadata['tag.temp']).toBe('yes');
    expect(outside.metadata['tag.temp']).toBeUndefined();
  });

  it('beforeSend still runs on scoped manual captures (pipeline preserved)', async () => {
    const calls = captureFetch();
    register((ev) => { ev.metadata.tagged = true; return ev; });
    setTag('feature', 'x');
    await captureException(new Error('pipe'));
    const ev = errors(calls)[0].body;
    expect(ev.metadata.tagged).toBe(true);
    expect(ev.metadata['tag.feature']).toBe('x');
  });

  it('concurrent route-handler scopes do not leak; auto-capture includes scope user/tags', async () => {
    const calls = captureFetch();
    register();

    const handlerA = withAllStakRouteHandler(async (_req: any) => {
      setUser({ id: 'user-A' });
      setTag('which', 'A');
      await new Promise((r) => setTimeout(r, 30));
      throw new Error('boom-A');
    });
    const handlerB = withAllStakRouteHandler(async (_req: any) => {
      setUser({ id: 'user-B' });
      setTag('which', 'B');
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('boom-B');
    });

    const reqA = { url: 'https://x/a', method: 'GET', headers: new Headers() };
    const reqB = { url: 'https://x/b', method: 'GET', headers: new Headers() };

    const [ra, rb] = await Promise.allSettled([handlerA(reqA), handlerB(reqB)]);
    expect(ra.status).toBe('rejected');
    expect(rb.status).toBe('rejected');

    const a = errors(calls).find((c) => c.body.message === 'boom-A')!.body;
    const b = errors(calls).find((c) => c.body.message === 'boom-B')!.body;
    expect(a.metadata.user).toMatchObject({ id: 'user-A' });
    expect(a.metadata['tag.which']).toBe('A');
    expect(b.metadata.user).toMatchObject({ id: 'user-B' });
    expect(b.metadata['tag.which']).toBe('B');
    // No cross-request leak.
    expect(a.metadata['tag.which']).not.toBe('B');
    expect(b.metadata['tag.which']).not.toBe('A');
  });
});
