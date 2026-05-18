import { describe, expect, it } from 'vitest';
import { scrub, REDACTED, DEFAULT_DENYLIST } from '../src/sanitize';

describe('scrub', () => {
  it('redacts top-level sensitive keys', () => {
    const out = scrub({ Authorization: 'Bearer abc', safe: 'ok' });
    expect(out).toEqual({ Authorization: REDACTED, safe: 'ok' });
  });

  it('case-insensitive key match', () => {
    const out = scrub({ 'X-Api-Key': 'k', PASSWORD: 'p', safe: 'v' });
    expect(out).toEqual({ 'X-Api-Key': REDACTED, PASSWORD: REDACTED, safe: 'v' });
  });

  it('recurses into nested objects', () => {
    const out = scrub({
      deep: { deeper: { token: 'leaked' }, ok: 'fine' },
    }) as any;
    expect(out.deep.deeper.token).toBe(REDACTED);
    expect(out.deep.ok).toBe('fine');
  });

  it('recurses into arrays', () => {
    const out = scrub([{ password: 'x' }, { name: 'ok' }]) as any[];
    expect(out[0].password).toBe(REDACTED);
    expect(out[1].name).toBe('ok');
  });

  it('does not mutate caller', () => {
    const input = { password: 'secret', a: 1 };
    scrub(input);
    expect(input).toEqual({ password: 'secret', a: 1 });
  });

  it('cycle protection', () => {
    const input: any = { password: 'p', a: {} };
    input.a.self = input;
    expect(() => scrub(input)).not.toThrow();
  });

  it('canary should_not_leak_next is scrubbed', () => {
    const canary = 'should_not_leak_next';
    const out = scrub({
      password: canary,
      authorization: `Bearer ${canary}`,
      api_key: canary,
      jwt: canary,
      bearer: canary,
      pwd: canary,
      credit_card: '4111-1111-1111-1111',
      ssn: '123-45-6789',
      cvv: '123',
      nested: { deep: { deeper: { token: canary } } },
      benign: 'pass through',
    });
    const wire = JSON.stringify(out);
    expect(wire.includes(canary)).toBe(false);
    expect(wire.includes(REDACTED)).toBe(true);
    expect(wire.includes('pass through')).toBe(true);
  });

  it('covers all 25 canonical denylist terms', () => {
    for (const term of DEFAULT_DENYLIST) {
      const out = scrub({ [term]: 'sensitive' }) as Record<string, string>;
      expect(out[term]).toBe(REDACTED);
    }
  });

  it('primitive passthrough', () => {
    expect(scrub('hello')).toBe('hello');
    expect(scrub(42)).toBe(42);
    expect(scrub(true)).toBe(true);
    expect(scrub(null)).toBe(null);
  });
});
