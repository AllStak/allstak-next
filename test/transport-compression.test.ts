import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AllStakNextClient } from '../src/client';

describe('transport compression', () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];

  afterEach(() => {
    sent.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubFetch(): void {
    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('process', {
      ...process,
      getBuiltinModule: () => ({ gzipSync }),
      versions: process.versions,
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), init });
      return new Response('{}', { status: 202 });
    }));
  }

  it('does not compress tiny payloads', async () => {
    stubFetch();
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      enableAutoSessionTracking: false,
      enableOfflineQueue: false,
    });

    await client.captureLog({ level: 'info', message: 'tiny' });
    await client.flush();

    const req = ingestRequest('/ingest/v1/logs');
    expect(header(req.init.headers, 'Content-Encoding')).toBeUndefined();
    expect(req.init.body).toBe(JSON.stringify({
      level: 'info',
      message: 'tiny',
      environment: '',
      release: '0.3.0',
    }));
    expect(client.getDiagnostics().uncompressedPayloads).toBe(1);
    expect(client.getDiagnostics().compressedPayloads).toBe(0);
  });

  it('gzip-compresses large payloads and exposes compression stats', async () => {
    stubFetch();
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      enableAutoSessionTracking: false,
      enableOfflineQueue: false,
    });

    await client.captureMessage('x'.repeat(50_000), 'info');
    await client.flush();

    const req = ingestRequest('/ingest/v1/errors');
    expect(header(req.init.headers, 'Content-Encoding')).toBe('gzip');
    expect(gunzipSync(bodyBuffer(req.init.body)).toString('utf8')).toContain('x'.repeat(500));
    const diagnostics = client.getDiagnostics();
    expect(diagnostics.compressedPayloads).toBe(1);
    expect(diagnostics.uncompressedPayloads).toBe(0);
    expect(diagnostics.compressionBytesSaved).toBeGreaterThan(0);
  });

  function ingestRequest(path: string): { url: string; init: RequestInit } {
    const req = [...sent].reverse().find((item) => item.url.endsWith(path));
    expect(req).toBeTruthy();
    return req!;
  }
});

function header(headers: HeadersInit | undefined, name: string): string | undefined {
  const value = new Headers(headers).get(name);
  return value ?? undefined;
}

function bodyBuffer(body: BodyInit | null | undefined): Buffer {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  throw new Error(`Unsupported body type: ${Object.prototype.toString.call(body)}`);
}
