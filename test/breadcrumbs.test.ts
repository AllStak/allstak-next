import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AllStakNextClient, setClient } from '../src/client';
import { scopeManager } from '../src/scope';
import {
  installAutoBreadcrumbs,
  areAutoBreadcrumbsInstalled,
  _resetAutoBreadcrumbsForTest,
} from '../src/breadcrumbs';

/**
 * Auto-breadcrumb collectors (console / navigation / fetch). They record onto
 * the active scope so a subsequent captured error carries recent context with
 * NO manual addBreadcrumb. window/document/history are stubbed (node runtime).
 */
describe('auto breadcrumbs', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let winListeners: Record<string, Array<(...a: unknown[]) => void>>;
  let docListeners: Record<string, Array<(...a: unknown[]) => void>>;
  let history: Record<string, unknown>;
  let originalConsole: { info?: unknown; warn?: unknown; error?: unknown; debug?: unknown };

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);
    setClient(null);
    _resetAutoBreadcrumbsForTest();
    scopeManager.getCurrentScope().clear();

    winListeners = {};
    docListeners = {};
    history = {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    };
    originalConsole = {
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };

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
      history,
    });
    vi.stubGlobal('history', history);
    vi.stubGlobal('location', { pathname: '/home', search: '', hash: '' });
  });

  afterEach(() => {
    _resetAutoBreadcrumbsForTest();
    setClient(null);
    console.info = originalConsole.info as typeof console.info;
    console.warn = originalConsole.warn as typeof console.warn;
    console.error = originalConsole.error as typeof console.error;
    console.debug = originalConsole.debug as typeof console.debug;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function crumbs() {
    return scopeManager.getCurrentScope().breadcrumbs;
  }

  function el(tagName: string, attrs: Record<string, string> = {}, classes: string[] = []) {
    return {
      tagName,
      classList: classes,
      parentElement: null,
      getAttribute: (name: string) => attrs[name] ?? null,
    };
  }

  function click(target: unknown) {
    for (const handler of docListeners.click ?? []) handler({ target });
  }

  it('is a no-op outside the browser', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', fetchSpy); // keep fetch but drop window/document
    const teardown = installAutoBreadcrumbs();
    expect(areAutoBreadcrumbsInstalled()).toBe(false);
    teardown();
  });

  it('records an initial navigation breadcrumb on install', () => {
    installAutoBreadcrumbs({ console: false, fetch: false });
    const nav = crumbs().filter((c) => c.type === 'navigation');
    expect(nav.length).toBeGreaterThanOrEqual(1);
    expect(nav[0].message).toContain('/home');
  });

  it('records a navigation breadcrumb on pushState', () => {
    installAutoBreadcrumbs({ console: false, fetch: false });
    const before = crumbs().filter((c) => c.type === 'navigation').length;
    // Simulate the app navigating.
    (history.pushState as (s: unknown, t: string, u: string) => void)({}, '', '/dashboard');
    const after = crumbs().filter((c) => c.type === 'navigation');
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].message).toMatch(/pushState/);
  });

  it('records a console breadcrumb while preserving original output', () => {
    const seen: unknown[][] = [];
    console.warn = ((...a: unknown[]) => seen.push(a)) as typeof console.warn;
    installAutoBreadcrumbs({ navigation: false, fetch: false });

    console.warn('low disk space');
    expect(seen).toEqual([['low disk space']]);
    const consoleCrumbs = crumbs().filter((c) => c.type === 'console');
    expect(consoleCrumbs.length).toBe(1);
    expect(consoleCrumbs[0].message).toBe('low disk space');
    expect(consoleCrumbs[0].level).toBe('warning');
  });

  it('records a fetch breadcrumb (method + url + status) and skips ingest urls', async () => {
    installAutoBreadcrumbs({ navigation: false, console: false });

    await fetch('https://api.example.com/things', { method: 'POST' });
    // An ingest URL must NOT produce a breadcrumb.
    await fetch('https://api.allstak.sa/ingest/v1/errors', { method: 'POST' });

    const httpCrumbs = crumbs().filter((c) => c.type === 'http');
    expect(httpCrumbs.length).toBe(1);
    expect(httpCrumbs[0].message).toContain('POST');
    expect(httpCrumbs[0].message).toContain('api.example.com/things');
    expect(httpCrumbs[0].data).toMatchObject({ status: 200 });
  });

  it('records privacy-safe click breadcrumbs without text or values', () => {
    installAutoBreadcrumbs({ navigation: false, console: false, fetch: false });

    click(el('BUTTON', { id: 'pay-now', value: '4111111111111111' }, ['primary', 'checkout']));

    const ui = crumbs().filter((c) => c.type === 'ui');
    expect(ui).toHaveLength(1);
    expect(ui[0].message).toBe('click button#pay-now.primary.checkout');
    expect(ui[0].data).toMatchObject({ action: 'click', selector: 'button#pay-now.primary.checkout', tag: 'button' });
    expect(JSON.stringify(ui[0])).not.toContain('4111111111111111');
  });

  it('ignores password input clicks', () => {
    installAutoBreadcrumbs({ navigation: false, console: false, fetch: false });

    click(el('INPUT', { type: 'password', id: 'password', value: 'secret' }));

    expect(crumbs().filter((c) => c.type === 'ui')).toHaveLength(0);
  });

  it('truncates long click selectors', () => {
    installAutoBreadcrumbs({ navigation: false, console: false, fetch: false, maxSelectorLength: 48 });

    click(el('BUTTON', { id: 'x'.repeat(200) }, ['a'.repeat(80)]));

    const ui = crumbs().filter((c) => c.type === 'ui');
    expect(ui).toHaveLength(1);
    expect(String(ui[0].data?.selector).length).toBeLessThanOrEqual(48);
  });

  it('beforeBreadcrumb can drop click breadcrumbs', () => {
    installAutoBreadcrumbs({
      navigation: false,
      console: false,
      fetch: false,
      beforeBreadcrumb: () => null,
    });

    click(el('BUTTON', { id: 'drop-me' }));

    expect(crumbs().filter((c) => c.type === 'ui')).toHaveLength(0);
  });

  it('attaches collected breadcrumbs to a captured error', async () => {
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      environment: 'production',
      release: '1.0.0',
    });
    setClient(client);
    console.error = (() => {}) as typeof console.error;

    installAutoBreadcrumbs();
    console.error('something happened');

    await client.captureException(new Error('boom'));
    await client.flush();

    const errCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/errors'));
    expect(errCall).toBeTruthy();
    const body = JSON.parse((errCall![1] as { body: string }).body);
    const messages = body.breadcrumbs.map((b: { message: string }) => b.message);
    expect(messages).toContain('something happened');
  });

  it('teardown removes the collectors and restores console', () => {
    const restored = (() => {}) as typeof console.info;
    console.info = restored;
    const teardown = installAutoBreadcrumbs({ navigation: false, fetch: false });
    expect(console.info).not.toBe(restored);
    teardown();
    expect(console.info).toBe(restored);
    expect(areAutoBreadcrumbsInstalled()).toBe(false);
  });
});
