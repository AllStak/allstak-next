import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllStakNextClient, setClient } from '../src/client';
import { getDiagnostics } from '../src/index';
import { setPersistenceAdapter, type PersistedEnvelope, type PersistenceAdapter } from '../src/persistence';
import { resetSanitizerRedactionCountForTest } from '../src/sanitize';

class FakeAdapter implements PersistenceAdapter {
  store: PersistedEnvelope[] = [];
  isAvailable(): boolean {
    return true;
  }
  load(): PersistedEnvelope[] {
    return [...this.store];
  }
  save(envelopes: PersistedEnvelope[]): void {
    this.store = [...envelopes];
  }
  clear(): void {
    this.store = [];
  }
}

describe('SDK diagnostics', () => {
  beforeEach(() => {
    resetSanitizerRedactionCountForTest();
    setClient(null);
  });

  afterEach(() => {
    setPersistenceAdapter(null);
    setClient(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports privacy-safe counters for the registered client', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null } }));
    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      enableAutoSessionTracking: false,
      enableOfflineQueue: false,
    });
    setClient(client);

    client.addBreadcrumb({ type: 'ui', message: 'save button', data: { password: 'secret' } });
    await client.captureMessage('diagnostic event', 'info');
    await client.flush();

    const diagnostics = client.getDiagnostics();
    expect(diagnostics.eventsCaptured).toBe(1);
    expect(diagnostics.eventsSent).toBe(1);
    expect(diagnostics.eventsFailed).toBe(0);
    expect(diagnostics.activeTraceCount).toBe(0);
    expect(diagnostics.activeSpanCount).toBe(0);
    expect(diagnostics.breadcrumbCount).toBe(1);
    expect(diagnostics.sanitizerRedactionCount).toBeGreaterThanOrEqual(1);
    expect(getDiagnostics()?.eventsSent).toBe(1);

    const encoded = JSON.stringify(diagnostics);
    expect(encoded).not.toContain('diagnostic event');
    expect(encoded).not.toContain('save button');
    expect(encoded).not.toContain('secret');
  });

  it('counts retryable persistence without leaking payload data', async () => {
    const adapter = new FakeAdapter();
    setPersistenceAdapter(adapter);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const client = new AllStakNextClient({
      apiKey: 'ask_test',
      host: 'https://api.allstak.sa',
      enableAutoSessionTracking: false,
      enableOfflineQueue: true,
    });
    await client.captureException(new Error('offline diagnostic'), { token: 'secret' });
    await client.flush();

    const diagnostics = client.getDiagnostics();
    expect(diagnostics.eventsCaptured).toBe(1);
    expect(diagnostics.eventsFailed).toBe(1);
    expect(diagnostics.eventsPersisted).toBe(1);
    expect(diagnostics.queueSize).toBe(1);
    expect(JSON.stringify(diagnostics)).not.toContain('offline diagnostic');
    expect(JSON.stringify(diagnostics)).not.toContain('secret');

    expect(adapter.store).toHaveLength(1);
    expect(adapter.store[0].body).not.toContain('secret');
  });
});
