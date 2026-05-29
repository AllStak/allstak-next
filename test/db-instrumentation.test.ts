import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AllStakNextClient, setClient } from '../src/client';
import {
  instrumentPgDriver,
  instrumentPrisma,
  allstakDrizzleLogger,
  _resetDbInstrumentationForTest,
} from '../src/db-instrumentation';
import { normalizeQuery, hashQuery, detectQueryType } from '../src/db-shared';

/**
 * Database query auto-instrumentation. Queries are NORMALIZED (literals masked
 * to `?`) before they leave the SDK and emitted (batched) to /ingest/v1/db.
 * Driver/ORM objects are stubbed; the wire shape + value-stripping are asserted.
 */
describe('db instrumentation', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);
    setClient(null);
    _resetDbInstrumentationForTest();
  });

  afterEach(() => {
    setClient(null);
    _resetDbInstrumentationForTest();
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

  function dbCalls() {
    return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/ingest/v1/db'));
  }
  function firstDbItem() {
    const call = dbCalls()[0];
    return call ? JSON.parse(call[1].body).queries[0] : undefined;
  }

  describe('query normalization helpers', () => {
    it('masks string + numeric literals to ? but preserves quoted identifiers', () => {
      const sql = `SELECT * FROM "public"."User" WHERE email = 'a@b.com' AND age > 30`;
      const normalized = normalizeQuery(sql);
      expect(normalized).toContain('"public"."User"'); // identifier preserved
      expect(normalized).not.toContain('a@b.com'); // literal value stripped
      expect(normalized).not.toContain('30');
      expect(normalized).toContain('= ?');
    });

    it('detects the query type from the first keyword', () => {
      expect(detectQueryType('select 1')).toBe('SELECT');
      expect(detectQueryType('INSERT INTO t VALUES (1)')).toBe('INSERT');
      expect(detectQueryType('explain analyze ...')).toBe('OTHER');
    });

    it('hashes deterministically', () => {
      expect(hashQuery('SELECT ?')).toBe(hashQuery('SELECT ?'));
      expect(hashQuery('SELECT ?')).not.toBe(hashQuery('DELETE FROM t'));
    });
  });

  describe('pg driver wrapper', () => {
    function fakePgModule() {
      // A minimal pg.Client prototype with a promise-returning query().
      const calls: unknown[][] = [];
      const proto = {
        database: 'shop',
        query(this: unknown, ...args: unknown[]) {
          calls.push(args);
          return Promise.resolve({ rowCount: 3 });
        },
      };
      return { module: { Client: { prototype: proto } }, proto, calls };
    }

    it('captures a pg query as a normalized /ingest/v1/db item (no bound values)', async () => {
      const client = installClient();
      const { module, proto } = fakePgModule();
      // Make tryRequire resolve our fake `pg` via a global require shim.
      vi.stubGlobal('require', ((id: string) => (id === 'pg' ? module : undefined)) as unknown as NodeRequire);
      // Node-server runtime gate.
      vi.stubGlobal('process', { ...process, versions: { node: '20' }, env: {} });

      expect(instrumentPgDriver()).toBe(true);

      await (proto.query as (sql: string, params: unknown[]) => Promise<unknown>)(
        `SELECT * FROM users WHERE email = 'secret@example.com' AND id = 42`,
        [],
      );
      await client.flush();

      const item = firstDbItem();
      expect(item).toBeTruthy();
      expect(item.databaseType).toBe('postgresql');
      expect(item.databaseName).toBe('shop');
      expect(item.queryType).toBe('SELECT');
      expect(item.status).toBe('success');
      expect(item.rowsAffected).toBe(3);
      expect(item.environment).toBe('production');
      // Bound values never reach the wire.
      expect(item.normalizedQuery).not.toContain('secret@example.com');
      expect(item.normalizedQuery).not.toContain('42');
      expect(typeof item.queryHash).toBe('string');
    });

    it('records status:error and rethrows when the underlying query rejects', async () => {
      const client = installClient();
      const proto = {
        database: 'shop',
        query(this: unknown) {
          return Promise.reject(new Error('relation does not exist'));
        },
      };
      const module = { Client: { prototype: proto } };
      vi.stubGlobal('require', ((id: string) => (id === 'pg' ? module : undefined)) as unknown as NodeRequire);
      vi.stubGlobal('process', { ...process, versions: { node: '20' }, env: {} });

      instrumentPgDriver();
      await expect((proto.query as () => Promise<unknown>)()).rejects.toThrow('relation does not exist');
      await client.flush();

      const item = firstDbItem();
      expect(item.status).toBe('error');
      expect(item.errorMessage).toContain('relation does not exist');
    });

    it('is a no-op when pg is not installed', () => {
      installClient();
      vi.stubGlobal('require', ((_: string) => undefined) as unknown as NodeRequire);
      vi.stubGlobal('process', { ...process, versions: { node: '20' }, env: {} });
      expect(instrumentPgDriver()).toBe(false);
    });
  });

  describe('Prisma $on(query) hook', () => {
    it('captures Prisma query events to /ingest/v1/db', async () => {
      const client = installClient();
      let handler: ((e: unknown) => void) | undefined;
      const prisma = {
        $on(_event: string, cb: (e: unknown) => void) {
          handler = cb;
        },
        _engine: {},
      };

      expect(instrumentPrisma(prisma, { databaseType: 'postgresql' })).toBe(true);
      expect(handler).toBeTypeOf('function');

      handler!({
        timestamp: new Date(),
        query: `SELECT "id" FROM "User" WHERE "email" = 'x@y.z'`,
        params: '["x@y.z"]',
        duration: 12,
      });
      await client.flush();

      const item = firstDbItem();
      expect(item).toBeTruthy();
      expect(item.queryType).toBe('SELECT');
      expect(item.durationMs).toBe(12);
      expect(item.databaseType).toBe('postgresql');
      expect(item.normalizedQuery).not.toContain('x@y.z');
    });

    it('returns false for a client without $on', () => {
      installClient();
      expect(instrumentPrisma({} as never)).toBe(false);
    });
  });

  describe('Drizzle logger', () => {
    it('emits a normalized /ingest/v1/db item from logQuery and never forwards params', async () => {
      const client = installClient();
      const logger = allstakDrizzleLogger({ databaseType: 'sqlite' });

      logger.logQuery(`UPDATE "t" SET "name" = ? WHERE "id" = ?`, ['Alice', 7]);
      await client.flush();

      const item = firstDbItem();
      expect(item).toBeTruthy();
      expect(item.queryType).toBe('UPDATE');
      expect(item.databaseType).toBe('sqlite');
      // The serialized body must not contain the bound param values.
      const body = dbCalls()[0][1].body as string;
      expect(body).not.toContain('Alice');
    });
  });

  it('captures nothing when no client is registered (safe no-op)', async () => {
    const logger = allstakDrizzleLogger();
    logger.logQuery('SELECT 1', []);
    expect(dbCalls()).toHaveLength(0);
  });
});
