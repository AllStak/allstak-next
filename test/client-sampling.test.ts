import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AllStakNextClient } from '../src/client';

describe('AllStakNextClient beforeSend + sampleRate', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const base = { apiKey: 'ask_test', host: 'https://api.allstak.sa', environment: 'test', release: '1.0.0' };

  describe('beforeSend', () => {
    it('mutates the event before it is sent', async () => {
      const client = new AllStakNextClient({
        ...base,
        beforeSend: (event) => ({ ...event, message: 'rewritten' }),
      });
      await client.captureException(new Error('original'));

      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.message).toBe('rewritten');
    });

    it('drops the event when beforeSend returns null', async () => {
      const client = new AllStakNextClient({
        ...base,
        beforeSend: () => null,
      });
      await client.captureException(new Error('boom'));
      await client.captureMessage('hi');

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fails open: a throwing beforeSend still sends the original event', async () => {
      const client = new AllStakNextClient({
        ...base,
        beforeSend: () => {
          throw new Error('callback blew up');
        },
      });
      await client.captureException(new Error('payload survives'));

      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.message).toBe('payload survives');
    });

    it('runs beforeSend once per captured event', async () => {
      const beforeSend = vi.fn((event) => event);
      const client = new AllStakNextClient({ ...base, beforeSend });
      await client.captureException(new Error('a'));
      await client.captureMessage('b');
      expect(beforeSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('sampleRate', () => {
    it('sampleRate 0 drops every event', async () => {
      const client = new AllStakNextClient({ ...base, sampleRate: 0, random: () => 0 });
      await client.captureException(new Error('drop me'));
      await client.captureMessage('drop me too');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sampleRate 1 keeps every event', async () => {
      const client = new AllStakNextClient({ ...base, sampleRate: 1, random: () => 0.999999 });
      await client.captureException(new Error('keep me'));
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('keeps the event when random < sampleRate, drops when random >= sampleRate', async () => {
      const kept = new AllStakNextClient({ ...base, sampleRate: 0.5, random: () => 0.4 });
      await kept.captureException(new Error('kept'));
      expect(fetchSpy).toHaveBeenCalledOnce();

      fetchSpy.mockClear();
      const dropped = new AllStakNextClient({ ...base, sampleRate: 0.5, random: () => 0.5 });
      await dropped.captureException(new Error('dropped'));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sampling drops happen BEFORE beforeSend — beforeSend is not called for dropped events', async () => {
      const beforeSend = vi.fn((event) => event);
      const client = new AllStakNextClient({ ...base, sampleRate: 0, random: () => 0, beforeSend });
      await client.captureException(new Error('dropped pre-beforeSend'));
      expect(beforeSend).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
