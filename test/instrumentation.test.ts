import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { registerAllStak } from '../src/instrumentation';
import { getClient, setClient } from '../src/client';
import { isFetchInstrumented, uninstrumentFetch } from '../src/fetch-instrumentation';

describe('registerAllStak', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    setClient(null);
    uninstrumentFetch();
  });

  afterEach(() => {
    setClient(null);
    uninstrumentFetch();
    vi.restoreAllMocks();
  });

  it('instruments outbound fetch by default', () => {
    registerAllStak({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    expect(isFetchInstrumented()).toBe(true);
  });

  it('does NOT instrument outbound fetch when enableOutboundHttp is false', () => {
    registerAllStak({ apiKey: 'ask_test', host: 'https://api.allstak.sa', enableOutboundHttp: false });
    expect(isFetchInstrumented()).toBe(false);
  });

  it('creates and sets the client singleton', () => {
    const client = registerAllStak({ apiKey: 'ask_test' });
    expect(client).toBeTruthy();
    expect(getClient()).toBe(client);
  });

  it('returns existing client if not destroyed', () => {
    const first = registerAllStak({ apiKey: 'ask_test' });
    const second = registerAllStak({ apiKey: 'ask_other' });
    expect(second).toBe(first);
  });

  it('creates new client if previous was destroyed', () => {
    const first = registerAllStak({ apiKey: 'ask_test' });
    first.destroy();
    const second = registerAllStak({ apiKey: 'ask_test' });
    expect(second).not.toBe(first);
  });

  it('installs uncaughtException handler by default', () => {
    const onSpy = vi.spyOn(process, 'on');
    registerAllStak({ apiKey: 'ask_test' });
    const calls = onSpy.mock.calls.map(c => c[0]);
    expect(calls).toContain('uncaughtException');
    expect(calls).toContain('unhandledRejection');
  });

  it('skips handlers when disabled', () => {
    const onSpy = vi.spyOn(process, 'on');
    registerAllStak({
      apiKey: 'ask_test',
      captureUncaughtExceptions: false,
      captureUnhandledRejections: false,
    });
    const calls = onSpy.mock.calls.map(c => c[0]);
    expect(calls).not.toContain('uncaughtException');
    expect(calls).not.toContain('unhandledRejection');
  });

  it('uncaughtException handler captures to client', async () => {
    const client = registerAllStak({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    const captureSpy = vi.spyOn(client, 'captureException');

    // Find the handler that was installed
    const onSpy = vi.spyOn(process, 'on');
    // Re-register to capture the spy
    client.destroy();
    setClient(null);
    const newClient = registerAllStak({ apiKey: 'ask_test', host: 'https://api.allstak.sa' });
    const captureSpyNew = vi.spyOn(newClient, 'captureException');

    const uncaughtCall = onSpy.mock.calls.find(c => c[0] === 'uncaughtException');
    if (uncaughtCall) {
      const handler = uncaughtCall[1] as (err: Error) => void;
      handler(new Error('crash'));
      expect(captureSpyNew).toHaveBeenCalledWith(
        expect.any(Error),
        { mechanism: 'uncaughtException' },
      );
    }
  });

  describe('release-health session shutdown hooks', () => {
    const installed: string[] = [];
    let beforeExitHandler: (() => void) | undefined;

    beforeEach(() => {
      installed.length = 0;
      beforeExitHandler = undefined;
      vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: any[]) => void) => {
        installed.push(event);
        if (event === 'beforeExit') beforeExitHandler = handler as () => void;
        return process;
      }) as typeof process.on);
    });

    it('registers graceful-shutdown hooks when session tracking is enabled', () => {
      registerAllStak({ apiKey: 'ask_test', release: '1.0.0', enableAutoSessionTracking: true });
      expect(installed).toContain('beforeExit');
      expect(installed).toContain('exit');
      expect(installed).toContain('SIGTERM');
      expect(installed).toContain('SIGINT');
    });

    it('does NOT register shutdown hooks when session tracking is disabled', () => {
      registerAllStak({ apiKey: 'ask_test', release: '1.0.0', enableAutoSessionTracking: false });
      expect(installed).not.toContain('beforeExit');
      expect(installed).not.toContain('SIGTERM');
    });

    it('ends the session when a shutdown signal fires', () => {
      const client = registerAllStak({ apiKey: 'ask_test', release: '1.0.0', enableAutoSessionTracking: true });
      const endSpy = vi.spyOn(client, 'endSession');
      expect(beforeExitHandler).toBeTypeOf('function');
      beforeExitHandler!();
      expect(endSpy).toHaveBeenCalled();
    });
  });
});
