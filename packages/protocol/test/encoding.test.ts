import { describe, expect, it } from 'vitest';
import {
  FedFrameSchema,
  canonicalJson,
  isOperatorContact,
  fromB32,
  fromB64u,
  parseSessionId,
  sessionIds,
  toB32,
  toB64u,
} from '../src';

describe('encoding', () => {
  it('round-trips base64url for all lengths', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const text = toB64u(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64url'));
      expect(fromB64u(text)).toEqual(bytes);
    }
  });

  it('accepts padding and rejects long padding runs in linear time', () => {
    expect(fromB64u('YQ==')).toEqual(new TextEncoder().encode('a'));
    // Signatures and keys from the network reach this decoder before any length
    // check; a run of '=' must not cost quadratic time (it once took ~30 s).
    const hostile = '='.repeat(200_000) + '!';
    const start = performance.now();
    expect(() => fromB64u(hostile)).toThrow();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('round-trips base32', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 91 + 7) & 0xff);
      expect(fromB32(toB32(bytes))).toEqual(bytes);
    }
  });

  it('produces canonical JSON independent of key order', () => {
    const a = canonicalJson({ b: 1, a: [{ y: 2, x: 'z' }], c: undefined });
    const b = canonicalJson({ a: [{ x: 'z', y: 2 }], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[{"x":"z","y":2}],"b":1}');
  });
});

describe('session ids', () => {
  it('parses scopes and normalises dm order', () => {
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const b = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(sessionIds.dm(b, a)).toBe(`dm:${a}:${b}`);
    expect(parseSessionId(sessionIds.dm(b, a))).toEqual({ kind: 'dm', users: [a, b] });
    expect(parseSessionId(`dm:${b}:${a}`)).toBeNull();
    expect(parseSessionId(sessionIds.voice(a, b))).toEqual({
      kind: 'voice',
      spaceId: a,
      channelId: b,
    });
    expect(parseSessionId('space:NOPE')).toBeNull();
  });
});

describe('operator contact', () => {
  it('accepts an email address or an https page, nothing else', () => {
    for (const ok of ['ops@example.org', 'https://example.org/privacy/'])
      expect(isOperatorContact(ok)).toBe(true);
    for (const bad of [
      '',
      'http://example.org',
      'https:example.org',
      'https:/example.org',
      'javascript:alert(1)',
      'mailto:ops@example.org',
      'ops@example',
      'ops @example.org',
      `https://example.org/${'a'.repeat(200)}`,
    ])
      expect(isOperatorContact(bad)).toBe(false);
  });
});

describe('link lookups between servers', () => {
  const peer = `${'a'.repeat(52)}.${'b'.repeat(8)}`;
  const query = {
    t: 'flood',
    id: 'q',
    origin: 's',
    hops: 0,
    f: { t: 'link_query', qid: 'q', code: 'ABCD-EFGH' },
  };

  it('name the claiming device, so a reveal can go only to it', () => {
    expect(FedFrameSchema.safeParse(query).success).toBe(false);
    expect(FedFrameSchema.safeParse({ ...query, f: { ...query.f, by: peer } }).success).toBe(true);
  });
});
