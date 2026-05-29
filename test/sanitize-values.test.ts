import { describe, expect, it } from 'vitest';
import { scrub, scrubStringValue, luhnValid, REDACTED } from '../src/sanitize';

// Value-pattern PII scrubbing of free-text string values. Layer (A) is
// always on; layer (B) is gated by sendDefaultPii.
const ON = { scrubValues: true } as const; // sendDefaultPii defaults to false
const PII_OK = { scrubValues: true, sendDefaultPii: true } as const;

describe('luhnValid', () => {
  it('accepts known-good card numbers', () => {
    expect(luhnValid('4111111111111111')).toBe(true); // Visa test
    expect(luhnValid('5500005555555559')).toBe(true); // Mastercard test
    expect(luhnValid('378282246310005')).toBe(true); // Amex test (15 digits)
  });

  it('rejects Luhn-invalid runs and out-of-range lengths', () => {
    expect(luhnValid('4111111111111112')).toBe(false); // one digit off
    expect(luhnValid('1234567890123')).toBe(false); // 13 digits, fails Luhn
    expect(luhnValid('123456789012')).toBe(false); // 12 digits (too short)
    expect(luhnValid('12345678901234567890')).toBe(false); // 20 digits (too long)
  });
});

describe('scrubStringValue — (A) always-on', () => {
  it('redacts a Luhn-valid credit card (plain, spaced, hyphenated)', () => {
    expect(scrubStringValue('card 4111111111111111 ok', false)).toBe(`card ${REDACTED} ok`);
    expect(scrubStringValue('card 4111 1111 1111 1111 ok', false)).toBe(`card ${REDACTED} ok`);
    expect(scrubStringValue('card 4111-1111-1111-1111 ok', false)).toBe(`card ${REDACTED} ok`);
  });

  it('PRESERVES a Luhn-INVALID digit run (order id / timestamp)', () => {
    // 16 digits that fail Luhn — must not be nuked.
    expect(scrubStringValue('order 4111111111111112 shipped', false))
      .toBe('order 4111111111111112 shipped');
    // A long order id / epoch-ish number that fails Luhn stays intact.
    expect(scrubStringValue('id 1234567890123456', false)).toBe('id 1234567890123456');
  });

  it('does NOT match short or long digit runs as cards', () => {
    expect(scrubStringValue('phone 1234567890', false)).toBe('phone 1234567890'); // 10 digits
    expect(scrubStringValue('big 12345678901234567890', false)).toBe('big 12345678901234567890'); // 20 digits
  });

  it('redacts hyphenated US SSN but NOT a bare 9-digit number', () => {
    expect(scrubStringValue('ssn 123-45-6789 here', false)).toBe(`ssn ${REDACTED} here`);
    expect(scrubStringValue('num 123456789 here', false)).toBe('num 123456789 here');
  });

  it('CC + SSN are scrubbed even when sendDefaultPii=true', () => {
    expect(scrubStringValue('cc 4111111111111111 ssn 123-45-6789', true))
      .toBe(`cc ${REDACTED} ssn ${REDACTED}`);
  });
});

describe('scrubStringValue — (B) gated by sendDefaultPii', () => {
  it('redacts email + IPv4 when sendDefaultPii=false', () => {
    expect(scrubStringValue('mail bob@example.com from 192.168.1.10', false))
      .toBe(`mail ${REDACTED} from ${REDACTED}`);
  });

  it('PRESERVES email + IPv4 when sendDefaultPii=true', () => {
    expect(scrubStringValue('mail bob@example.com from 192.168.1.10', true))
      .toBe('mail bob@example.com from 192.168.1.10');
  });

  it('IPv4 octet validation: leaves a non-address dotted number alone', () => {
    // 999.1.1.1 is not a valid IPv4 (octet > 255) → preserved.
    expect(scrubStringValue('version 999.1.1.1 build', false)).toBe('version 999.1.1.1 build');
    // 1.2.3 (only 3 octets) is not IPv4 → preserved.
    expect(scrubStringValue('semver 1.2.3', false)).toBe('semver 1.2.3');
  });

  it('redacts IPv6 (best effort) when sendDefaultPii=false', () => {
    const out = scrubStringValue('addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334 end', false);
    expect(out).toBe(`addr ${REDACTED} end`);
  });
});

describe('scrubStringValue — guards', () => {
  it('skips very large strings gracefully (returns input unchanged)', () => {
    const big = 'bob@example.com '.repeat(2000); // > 16KB
    expect(big.length).toBeGreaterThan(16_384);
    expect(scrubStringValue(big, false)).toBe(big); // skipped, not scanned
  });

  it('empty string passes through', () => {
    expect(scrubStringValue('', false)).toBe('');
  });
});

describe('scrub — value scrubbing wired into recursion', () => {
  it('scrubs free-text values in messages/metadata/breadcrumbs', () => {
    const out = scrub(
      {
        message: 'failed for bob@example.com card 4111111111111111',
        metadata: { note: 'client ip 10.0.0.5, ssn 123-45-6789' },
        breadcrumbs: [{ message: 'login from carol@test.io' }],
      },
      ON,
    ) as any;
    expect(out.message).toBe(`failed for ${REDACTED} card ${REDACTED}`);
    expect(out.metadata.note).toBe(`client ip ${REDACTED}, ssn ${REDACTED}`);
    expect(out.breadcrumbs[0].message).toBe(`login from ${REDACTED}`);
  });

  it('does NOT scrub explicit user subtree (id/email/ip ship as-is)', () => {
    const out = scrub(
      { metadata: { user: { id: 'u1', email: 'owner@corp.com', ip: '203.0.113.7' } } },
      ON,
    ) as any;
    expect(out.metadata.user.email).toBe('owner@corp.com');
    expect(out.metadata.user.ip).toBe('203.0.113.7');
    expect(out.metadata.user.id).toBe('u1');
  });

  it('does NOT corrupt stack frame paths / release / sdk fields', () => {
    const out = scrub(
      {
        release: '1.2.3',
        sdkVersion: '0.2.0',
        // A filename that incidentally contains an email-like token must survive.
        frames: [{ filename: '/app/user@2x/handler.ts', function: 'handle' }],
        // host/path/url are routing identity and have their own redactor.
        host: '192.168.0.1',
        path: '/orders/4111111111111111',
        url: 'https://app/u/bob@example.com',
      },
      ON,
    ) as any;
    expect(out.release).toBe('1.2.3');
    expect(out.sdkVersion).toBe('0.2.0');
    expect(out.frames[0].filename).toBe('/app/user@2x/handler.ts');
    expect(out.frames[0].function).toBe('handle');
    expect(out.host).toBe('192.168.0.1');
    expect(out.path).toBe('/orders/4111111111111111');
    expect(out.url).toBe('https://app/u/bob@example.com');
  });

  it('email/IP in metadata PRESERVED when sendDefaultPii=true (but CC/SSN still gone)', () => {
    const out = scrub(
      { metadata: { note: 'bob@example.com 10.0.0.5 cc 4111111111111111 ssn 123-45-6789' } },
      PII_OK,
    ) as any;
    expect(out.metadata.note).toBe(`bob@example.com 10.0.0.5 cc ${REDACTED} ssn ${REDACTED}`);
  });

  it('value scrubbing is OFF by default (no scrubValues flag)', () => {
    const out = scrub({ message: 'bob@example.com cc 4111111111111111' }) as any;
    // Without scrubValues, only key-name redaction applies — values pass through.
    expect(out.message).toBe('bob@example.com cc 4111111111111111');
  });

  it('key-name redaction still works alongside value scrubbing', () => {
    const out = scrub(
      { password: 'hunter2', authorization: 'Bearer abc', note: 'ip 10.0.0.5' },
      ON,
    ) as any;
    expect(out.password).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out.note).toBe(`ip ${REDACTED}`);
  });

  it('back-compat: array second arg is still treated as extraDenylist', () => {
    const out = scrub({ custom_secret_field: 'x', safe: 'ok' }, ['custom_secret_field']) as any;
    expect(out.custom_secret_field).toBe(REDACTED);
    expect(out.safe).toBe('ok');
  });

  it('fail-open on pathological/cyclic input — never throws', () => {
    const input: any = { message: 'bob@example.com', a: {} };
    input.a.self = input; // cycle
    expect(() => scrub(input, ON)).not.toThrow();
    const out = scrub(input, ON) as any;
    expect(out.message).toBe(REDACTED); // email scrubbed
  });
});
