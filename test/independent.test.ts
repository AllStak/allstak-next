import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureException, initAllStakNext, processNextSourceMaps } from '../src/index';

describe('@allstak/next standalone package', () => {
  it('captures server errors without another AllStak SDK dependency', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    initAllStakNext({ apiKey: 'ask_dev_test', host: 'https://api.dev.allstak.sa', release: 'tier1-test' });
    await captureException(new Error('next test'));
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.dev.allstak.sa/ingest/v1/errors');
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
      host: 'https://api.dev.allstak.sa',
    });
    expect(result).toEqual({ pairs: 1, uploaded: 1 });
    expect(readFileSync(join(dir, 'app.js'), 'utf8')).toContain('debugId=');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.dev.allstak.sa/api/v1/artifacts/upload');
    rmSync(dir, { recursive: true, force: true });
  });
});
