import { describe, expect, it } from 'vitest';
import {
  ASSUMED_KBPS,
  HOST_START_KBPS,
  RateMeter,
  VideoLimits,
  VideoRewriter,
  allocate,
  vp8Info,
} from '../src/video';

/** A VP8 payload: descriptor (optionally with picture id / TL0PICIDX) and one header byte. */
function vp8(opts: {
  start?: boolean;
  pid?: number;
  key?: boolean;
  pic?: { v: number; bits: 7 | 15 };
  tl0?: number;
  tk?: boolean;
}) {
  const b: number[] = [];
  const x = !!(opts.pic || opts.tl0 !== undefined || opts.tk);
  b.push((x ? 0x80 : 0) | (opts.start === false ? 0 : 0x10) | (opts.pid ?? 0));
  if (x)
    b.push(
      (opts.pic ? 0x80 : 0) | (opts.tl0 !== undefined ? 0x40 : 0) | (opts.tk ? 0x20 : 0),
    );
  if (opts.pic?.bits === 15) b.push(0x80 | (opts.pic.v >> 8), opts.pic.v & 0xff);
  else if (opts.pic) b.push(opts.pic.v & 0x7f);
  if (opts.tl0 !== undefined) b.push(opts.tl0);
  if (opts.tk) b.push(0x20);
  b.push(opts.key ? 0x10 : 0x11, 0xaa, 0xbb);
  return Uint8Array.from(b);
}

describe('VP8 payload descriptor', () => {
  it('finds key frames, with or without extensions', () => {
    expect(vp8Info(vp8({ key: true }))).toMatchObject({ start: true, keyframe: true });
    expect(vp8Info(vp8({ key: false }))).toMatchObject({ start: true, keyframe: false });
    const full = vp8Info(vp8({ key: true, pic: { v: 1234, bits: 15 }, tl0: 7, tk: true }))!;
    expect(full.keyframe).toBe(true);
    expect(full.pictureId).toEqual({ at: 2, bits: 15 });
    expect(full.tl0).toBe(4);
    expect(vp8Info(vp8({ key: true, pic: { v: 9, bits: 7 } }))!.pictureId).toEqual({
      at: 2,
      bits: 7,
    });
    // Not the frame's first packet, or not its first partition: no key frame here.
    expect(vp8Info(vp8({ key: true, start: false }))!.keyframe).toBe(false);
    expect(vp8Info(vp8({ key: true, pid: 1 }))!.keyframe).toBe(false);
  });

  it("doesn't read past a short packet", () => {
    expect(vp8Info(new Uint8Array(0))).toBeNull();
    expect(vp8Info(Uint8Array.of(0x90))).toBeNull();
    expect(vp8Info(Uint8Array.of(0x90, 0x80))).toBeNull();
    expect(vp8Info(Uint8Array.of(0x90, 0x80, 0x80))).toBeNull();
    expect(vp8Info(Uint8Array.of(0x10))).toMatchObject({ start: true, keyframe: false });
  });
});

describe('VideoRewriter', () => {
  const pic = (p: Uint8Array) => ((p[2]! & 0x7f) << 8) | p[3]!;

  it('keeps one stream continuous when its source changes', () => {
    const r = new VideoRewriter();
    const outs: { seq: number; ts: number; pic: number; tl0: number }[] = [];
    const send = (source: string, seq: number, ts: number, picture: number, tl0: number, at: number) => {
      const p = vp8({ key: true, pic: { v: picture, bits: 15 }, tl0 });
      const { seq: s, ts: t } = r.rewrite(source, seq, ts, p, at);
      outs.push({ seq: s, ts: t, pic: pic(p), tl0: p[4]! });
    };
    send('a', 100, 9000, 500, 10, 0);
    send('a', 101, 12000, 501, 11, 33);
    // Another camera, with its own numbering, 100 ms later.
    send('b', 7, 50, 20000, 200, 133);
    send('b', 8, 3050, 20001, 201, 166);
    for (let i = 1; i < outs.length; i++) {
      expect(outs[i]!.seq).toBe((outs[i - 1]!.seq + 1) & 0xffff);
      expect(outs[i]!.pic).toBe((outs[i - 1]!.pic + 1) & 0x7fff);
      expect(outs[i]!.tl0).toBe((outs[i - 1]!.tl0 + 1) & 0xff);
      expect(outs[i]!.ts).toBeGreaterThan(outs[i - 1]!.ts);
    }
    // The switch moved the clock on by about the time that passed (90 kHz).
    expect(outs[2]!.ts - outs[1]!.ts).toBe(9000);
  });

  it('lets late packets keep their place', () => {
    const r = new VideoRewriter();
    const a = r.rewrite('a', 10, 0, vp8({}), 0);
    const b = r.rewrite('a', 12, 6000, vp8({}), 10);
    const late = r.rewrite('a', 11, 3000, vp8({}), 20);
    expect(late.seq).toBe((a.seq + 1) & 0xffff);
    // Starting over after a reset begins a new run right after the last.
    r.reset();
    const next = r.rewrite('a', 500, 1, vp8({}), 40);
    expect(next.seq).toBe((b.seq + 1) & 0xffff);
  });
});

describe('sharing the host upload', () => {
  const kbps = () => 1000;

  it('takes everyone’s first choice before anyone’s second', () => {
    const out = allocate({
      requests: new Map([
        ['v1', ['s1', 's2', 's3']],
        ['v2', ['s3', 's1']],
      ]),
      current: new Map(),
      kbps,
      viewerCap: () => Number.POSITIVE_INFINITY,
      hostCap: 3000,
      slots: 9,
    });
    expect(out.get('v1')).toEqual(['s1', 's2']);
    expect(out.get('v2')).toEqual(['s3']);
  });

  it('keeps what is already flowing, within each viewer’s limit and slots', () => {
    const out = allocate({
      requests: new Map([
        ['v1', ['new', 'old']],
        ['v2', ['a', 'b', 'c']],
      ]),
      current: new Map([['v1', new Set(['old'])]]),
      kbps,
      viewerCap: (v) => (v === 'v2' ? 2000 : Number.POSITIVE_INFINITY),
      hostCap: 10_000,
      slots: 1,
    });
    // One slot: the stream already flowing stays rather than flickering over.
    expect(out.get('v1')).toEqual(['old']);
    expect(out.get('v2')).toEqual(['a']);
    const roomy = allocate({
      requests: new Map([['v2', ['a', 'b', 'c']]]),
      current: new Map(),
      kbps,
      viewerCap: () => 2000,
      hostCap: 10_000,
      slots: 9,
    });
    expect(roomy.get('v2')).toEqual(['a', 'b']);
  });

  it('assumes a bitrate for streams it hasn’t measured', () => {
    expect(ASSUMED_KBPS.screen).toBeGreaterThan(ASSUMED_KBPS.camera);
  });
});

describe('VideoLimits', () => {
  it("backs the host off when most watchers lose packets, and grows back slowly", () => {
    const l = new VideoLimits(8000);
    l.report('v1', 0.3);
    l.report('v2', 0.2);
    expect(l.tick(new Map([['v1', 3000], ['v2', 3000]]), 1000)).toBe(true);
    expect(l.host).toBe(Math.floor(6000 * 0.85));
    // Calm for a while: it rises again.
    const low = l.host;
    expect(l.tick(new Map([['v1', 2000], ['v2', 2000]]), 5000)).toBe(false);
    l.tick(new Map([['v1', 2000], ['v2', 2000]]), 10_000);
    expect(l.host).toBeGreaterThan(low);
  });

  it("limits only the one watcher whose own connection is lossy", () => {
    const l = new VideoLimits();
    l.report('slow', 0.4);
    l.tick(
      new Map([
        ['slow', 2000],
        ['fine1', 2000],
        ['fine2', 2000],
      ]),
      1000,
    );
    expect(l.host).toBe(HOST_START_KBPS);
    expect(l.viewerCap('slow')).toBe(1700);
    expect(l.viewerCap('fine1')).toBe(Number.POSITIVE_INFINITY);
    // Clean again for long enough: the limit lifts.
    for (let t = 10_000; t < 60_000; t += 2000) l.tick(new Map([['slow', 1700]]), t);
    expect(l.viewerCap('slow')).toBe(Number.POSITIVE_INFINITY);
    l.forget('slow');
  });

  it('never goes below a floor', () => {
    const l = new VideoLimits(400);
    l.report('v', 1);
    l.tick(new Map([['v', 10]]), 1);
    expect(l.host).toBe(300);
  });
});

describe('RateMeter', () => {
  it('measures kbps over each window', () => {
    const m = new RateMeter(0);
    m.add(25_000);
    expect(m.sample(2000)).toBe(100);
    expect(m.sample(4000)).toBe(0);
  });
});
