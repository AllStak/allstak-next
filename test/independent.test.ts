import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureException, initAllStakNext, processNextSourceMaps, withAllStak } from '../src/index';

describe('@allstak/next standalone package', () => {
  it('captures server errors without another AllStak SDK dependency', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    initAllStakNext({ apiKey: 'ask_dev_test', host: 'https://api.allstak.sa', release: 'tier1-test' });
    await captureException(new Error('next test'));
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.allstak.sa/ingest/v1/errors');
  });

  it('injects and uploads Next source maps through the artifact endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'allstak-next-'));
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    writeFileSync(join(dir, 'app.js'), 'console.log("x");\n//# sourceMappingURL=app.js.map\n');
    writeFileSync(join(dir, 'app.js.map'), JSON.stringify({ version: 3, sources: [], mappings: '' }));
    const result = await processNextSourceMaps({
      dir,
      release: 'tier1-test',
      uploadToken: 'aspk_dev_test',
      host: 'https://api.allstak.sa',
    });
    expect(result).toEqual({ pairs: 1, uploaded: 1 });
    expect(readFileSync(join(dir, 'app.js'), 'utf8')).toContain('debugId=');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.allstak.sa/api/v1/artifacts/upload');
    rmSync(dir, { recursive: true, force: true });
  });

  it('can delete source maps after upload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'allstak-next-'));
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    writeFileSync(join(dir, 'app.js'), 'console.log("x");\n//# sourceMappingURL=app.js.map\n');
    writeFileSync(join(dir, 'app.js.map'), JSON.stringify({ version: 3, sources: [], mappings: '' }));
    await processNextSourceMaps({
      dir,
      release: 'tier1-test',
      uploadToken: 'aspk_dev_test',
      host: 'https://api.allstak.sa',
      deleteAfterUpload: true,
    });
    expect(existsSync(join(dir, 'app.js.map'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('withAllStak preserves user webpack and adds tunnel rewrites', async () => {
    const userWebpack = vi.fn((config) => ({ ...config, userTouched: true }));
    const config = withAllStak(
      {
        release: 'tier1-test',
        uploadToken: 'aspk_dev_test',
        host: 'https://api.allstak.sa',
        tunnelRoute: '/allstak-tunnel/:path*',
      },
      {
        webpack: userWebpack,
        rewrites: async () => [{ source: '/old', destination: '/new' }],
      },
    );

    expect(config.productionBrowserSourceMaps).toBe(true);
    const rewritten = await (config.rewrites as () => Promise<unknown>)();
    expect(rewritten).toEqual([
      {
        source: '/allstak-tunnel/:path*',
        destination: 'https://api.allstak.sa/ingest/v1/:path*',
      },
      { source: '/old', destination: '/new' },
    ]);

    const webpackResult = (config.webpack as any)({ plugins: [] }, { isServer: true, dev: false });
    expect(userWebpack).toHaveBeenCalled();
    expect(webpackResult.userTouched).toBe(true);
  });
});
