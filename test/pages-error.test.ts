import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { captureUnderscoreErrorException } from '../src/pages-error';
import { AllStakNextClient, setClient } from '../src/client';

describe('captureUnderscoreErrorException', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    setClient(null);
    vi.restoreAllMocks();
  });

  it('captures error from Next.js error context', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    const captureSpy = vi.spyOn(client, 'captureException');
    setClient(client);

    const error = new Error('page error');
    await captureUnderscoreErrorException({
      err: error,
      res: { statusCode: 500 },
      asPath: '/broken-page',
      pathname: '/broken-page',
    });

    expect(captureSpy).toHaveBeenCalledWith(error, {
      mechanism: 'pages-error',
      statusCode: 500,
      asPath: '/broken-page',
      pathname: '/broken-page',
    });
  });

  it('does nothing when err is null', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    const captureSpy = vi.spyOn(client, 'captureException');
    setClient(client);

    await captureUnderscoreErrorException({ err: null });
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('does nothing when no client is set', async () => {
    await expect(
      captureUnderscoreErrorException({ err: new Error('no client') }),
    ).resolves.toBeUndefined();
  });

  it('fails open if capture throws', async () => {
    const client = new AllStakNextClient({ apiKey: 'ask_test' });
    vi.spyOn(client, 'captureException').mockRejectedValue(new Error('internal'));
    setClient(client);

    await expect(
      captureUnderscoreErrorException({ err: new Error('test') }),
    ).resolves.toBeUndefined();
  });
});
