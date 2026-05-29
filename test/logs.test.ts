import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AllStakNextClient, setClient } from '../src/client';
import {
  logToAllStak,
  installConsoleLogBridge,
  uninstallConsoleLogBridge,
  isConsoleLogBridgeInstalled,
  allstakPinoStream,
  allstakWinstonTransport,
} from '../src/logs';

/**
 * Structured-log bridge → /ingest/v1/logs. error/fatal carrying an Error are
 * also promoted to /ingest/v1/errors. console.* output is always preserved.
 */
describe('logs bridge', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);
    setClient(null);
    uninstallConsoleLogBridge();
  });

  afterEach(() => {
    uninstallConsoleLogBridge();
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

  function logCalls() {
    return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/ingest/v1/logs'));
  }
  function errorCalls() {
    return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/ingest/v1/errors'));
  }
  function firstLogBody() {
    const c = logCalls()[0];
    return c ? JSON.parse(c[1].body) : undefined;
  }

  describe('logToAllStak', () => {
    it('forwards a structured log with the backend LogIngestRequest shape', async () => {
      const client = installClient();
      logToAllStak('info', 'user signed in', { meta: { traceId: 'abc', userId: 'u1' } });
      await client.flush();

      const body = firstLogBody();
      expect(body.level).toBe('info');
      expect(body.message).toBe('user signed in');
      expect(body.service).toBe('nextjs');
      expect(body.traceId).toBe('abc');
      expect(body.userId).toBe('u1');
      expect(body.environment).toBe('production');
      expect(body.release).toBe('1.0.0');
      expect(body.metadata).toMatchObject({ traceId: 'abc', userId: 'u1' });
    });

    it('normalizes aliased levels (warning→warn, critical→fatal)', async () => {
      const client = installClient();
      logToAllStak('warning' as never, 'careful');
      logToAllStak('critical' as never, 'boom');
      await client.flush();
      const levels = logCalls().map((c) => JSON.parse(c[1].body).level);
      expect(levels).toContain('warn');
      expect(levels).toContain('fatal');
    });

    it('promotes an error-level log carrying an Error to captureException', async () => {
      const client = installClient();
      logToAllStak('error', 'request failed', { error: new Error('boom') });
      await client.flush();

      expect(logCalls()).toHaveLength(1);
      expect(errorCalls()).toHaveLength(1);
      const errBody = JSON.parse(errorCalls()[0][1].body);
      expect(errBody.message).toBe('boom');
      expect(errBody.metadata.mechanism).toBe('log');
    });

    it('does NOT promote a bare error-level string log (no Error object)', async () => {
      const client = installClient();
      logToAllStak('error', 'just a message');
      await client.flush();
      expect(logCalls()).toHaveLength(1);
      expect(errorCalls()).toHaveLength(0);
    });

    it('is a safe no-op when no client is registered', () => {
      logToAllStak('info', 'nobody listening');
      expect(logCalls()).toHaveLength(0);
    });
  });

  describe('console bridge', () => {
    let original: typeof console.error;

    beforeEach(() => {
      original = console.error;
    });
    afterEach(() => {
      console.error = original;
    });

    it('preserves the original console output AND ships a structured log', async () => {
      const client = installClient();
      const seen: unknown[][] = [];
      console.info = vi.fn((...args: unknown[]) => seen.push(args));

      const teardown = installConsoleLogBridge();
      expect(isConsoleLogBridgeInstalled()).toBe(true);

      console.info('hello', 'world');
      await client.flush();

      // Original console.info still ran.
      expect(seen).toEqual([['hello', 'world']]);
      // And a log was shipped.
      const body = firstLogBody();
      expect(body.level).toBe('info');
      expect(body.message).toBe('hello world');

      teardown();
      expect(isConsoleLogBridgeInstalled()).toBe(false);
    });

    it('drops console.debug below the default minLevel (info)', async () => {
      const client = installClient();
      console.debug = vi.fn();
      installConsoleLogBridge();
      console.debug('verbose');
      await client.flush();
      expect(logCalls()).toHaveLength(0);
    });

    it('promotes console.error carrying an Error to an event', async () => {
      const client = installClient();
      console.error = vi.fn();
      installConsoleLogBridge();
      console.error('failed:', new Error('kaboom'));
      await client.flush();

      expect(logCalls()).toHaveLength(1);
      expect(errorCalls()).toHaveLength(1);
      expect(JSON.parse(errorCalls()[0][1].body).message).toBe('kaboom');
    });

    it('install is idempotent', () => {
      installClient();
      const t1 = installConsoleLogBridge();
      installConsoleLogBridge();
      expect(isConsoleLogBridgeInstalled()).toBe(true);
      t1();
      expect(isConsoleLogBridgeInstalled()).toBe(false);
    });
  });

  describe('pino stream', () => {
    it('parses an NDJSON line and forwards it as a structured log', async () => {
      const client = installClient();
      const stream = allstakPinoStream();
      stream.write(JSON.stringify({ level: 50, msg: 'pino error', time: 1, pid: 9, hostname: 'h', extra: 'x' }));
      await client.flush();

      const body = firstLogBody();
      expect(body.level).toBe('error'); // pino 50 → error
      expect(body.message).toBe('pino error');
      // Structural pino keys are stripped from metadata; custom field retained.
      expect(body.metadata).toMatchObject({ extra: 'x' });
      expect(body.metadata.pid).toBeUndefined();
      expect(body.metadata.time).toBeUndefined();
    });

    it('forwards a non-JSON line as a plain info log', async () => {
      const client = installClient();
      allstakPinoStream().write('not json');
      await client.flush();
      const body = firstLogBody();
      expect(body.level).toBe('info');
      expect(body.message).toBe('not json');
    });
  });

  describe('winston transport', () => {
    it('returns null when winston/winston-transport is not installed', () => {
      vi.stubGlobal('require', ((_: string) => {
        throw new Error('not found');
      }) as unknown as NodeRequire);
      expect(allstakWinstonTransport()).toBeNull();
    });

    it('builds a transport that forwards log() calls', async () => {
      const client = installClient();
      // Minimal winston-transport base class.
      class FakeTransport {
        emit(_e: string, ..._a: unknown[]) {}
      }
      vi.stubGlobal('require', ((id: string) => {
        if (id === 'winston-transport') return FakeTransport;
        throw new Error('not found');
      }) as unknown as NodeRequire);

      const transport = allstakWinstonTransport() as { log: (info: unknown, cb?: () => void) => void } | null;
      expect(transport).toBeTruthy();

      const cb = vi.fn();
      transport!.log({ level: 'warn', message: 'winston warn', foo: 'bar' }, cb);
      await client.flush();

      const body = firstLogBody();
      expect(body.level).toBe('warn');
      expect(body.message).toBe('winston warn');
      expect(body.metadata).toMatchObject({ foo: 'bar' });
      expect(cb).toHaveBeenCalled();
    });
  });
});
