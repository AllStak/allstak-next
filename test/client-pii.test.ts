import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AllStakNextClient } from '../src/client';
import { setUser } from '../src/index';
import { scopeManager } from '../src/scope';

// End-to-end wire-path coverage for value-pattern PII scrubbing + sendDefaultPii.
// The single chokepoint is client.scrubToBody → sanitize.scrub, so asserting on
// the serialized fetch body proves the layering is wired correctly.

describe('AllStakNextClient — value-pattern PII scrubbing on the wire', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    // Reset the global scope between tests so explicit-user state doesn't leak.
    scopeManager.getCurrentScope().clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    scopeManager.getCurrentScope().clear();
  });

  const base = { apiKey: 'ask_test', host: 'https://api.allstak.sa', environment: 'test', release: '1.0.0' };
  const REDACTED = '[REDACTED]';

  function bodyOf(call = 0) {
    return JSON.parse(fetchSpy.mock.calls[call][1].body);
  }

  it('default (sendDefaultPii unset/false): scrubs email + IPv4 + CC + SSN from the message', async () => {
    const client = new AllStakNextClient(base);
    await client.captureException(
      new Error('user bob@example.com from 192.168.1.10 paid 4111111111111111 ssn 123-45-6789'),
    );
    const body = bodyOf();
    expect(body.message).toBe(`user ${REDACTED} from ${REDACTED} paid ${REDACTED} ssn ${REDACTED}`);
  });

  it('preserves a Luhn-INVALID order id in the message (no over-redaction)', async () => {
    const client = new AllStakNextClient(base);
    await client.captureException(new Error('order 4111111111111112 created'));
    expect(bodyOf().message).toBe('order 4111111111111112 created');
  });

  it('sendDefaultPii=true: email + IPv4 PRESERVED, but CC + SSN STILL scrubbed', async () => {
    const client = new AllStakNextClient({ ...base, sendDefaultPii: true });
    await client.captureException(
      new Error('user bob@example.com 192.168.1.10 cc 4111111111111111 ssn 123-45-6789'),
    );
    expect(bodyOf().message).toBe(`user bob@example.com 192.168.1.10 cc ${REDACTED} ssn ${REDACTED}`);
  });

  it('explicit setUser email/ip is NOT scrubbed (even with sendDefaultPii=false)', async () => {
    const client = new AllStakNextClient(base);
    setUser({ id: 'u1', email: 'owner@corp.com', ip: '203.0.113.7' });
    await client.captureException(new Error('boom'));
    const body = bodyOf();
    expect(body.metadata.user.email).toBe('owner@corp.com');
    expect(body.metadata.user.ip).toBe('203.0.113.7');
    expect(body.metadata.user.id).toBe('u1');
  });

  it('does not corrupt stack frame filenames', async () => {
    const client = new AllStakNextClient(base);
    const err = new Error('crash');
    err.stack = 'Error: crash\n    at handle (/app/u/bob@1.2.3.4/h.ts:10:5)';
    await client.captureException(err);
    const body = bodyOf();
    const joined = JSON.stringify(body.frames) + body.stackTrace.join('\n');
    expect(joined).toContain('/app/u/bob@1.2.3.4/h.ts');
  });

  it('key-name redaction still applies on the wire (metadata secret key)', async () => {
    const client = new AllStakNextClient(base);
    await client.captureException(new Error('x'), { password: 'hunter2', note: 'ip 10.0.0.5' });
    const body = bodyOf();
    expect(body.metadata.password).toBe(REDACTED);
    expect(body.metadata.note).toBe(`ip ${REDACTED}`);
  });
});
