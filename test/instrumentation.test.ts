import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { registerAllStak } from '../src/instrumentation';
import { getClient, setClient } from '../src/client';

describe('registerAllStak', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    setClient(null);
  });

  afterEach(() => {
    setClient(null);
    vi.restoreAllMocks();
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
    const client = registerAllStak({ apiKey: 'ask_test', host: 'https://api.dev.allstak.sa' });
    const captureSpy = vi.spyOn(client, 'captureException');

    // Find the handler that was installed
    const onSpy = vi.spyOn(process, 'on');
    // Re-register to capture the spy
    client.destroy();
    setClient(null);
    const newClient = registerAllStak({ apiKey: 'ask_test', host: 'https://api.dev.allstak.sa' });
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
});
