/**
 * Video in the host relay: what it reads from VP8 packets (whose frames are
 * end-to-end encrypted except for the codec's payload header), how it keeps
 * a member's video slot one continuous stream while its source changes, and
 * how it shares the host's upload between the members who watch.
 */

// ---------------------------------------------------------------------------
// VP8 (RFC 7741)
// ---------------------------------------------------------------------------

export interface Vp8Info {
  /** First packet of a frame. */
  start: boolean;
  /** First packet of a key frame: a viewer can start decoding here. */
  keyframe: boolean;
  /** Where the picture id is, and its width (7 or 15 bits), if present. */
  pictureId: { at: number; bits: 7 | 15 } | null;
  /** Where TL0PICIDX is, if present. */
  tl0: number | null;
}

/** Reads a VP8 RTP payload descriptor (and the key frame bit after it). */
export function vp8Info(payload: Uint8Array): Vp8Info | null {
  const len = payload.length;
  if (len < 1) return null;
  let i = 0;
  const b0 = payload[i++]!;
  let pictureId: Vp8Info['pictureId'] = null;
  let tl0: number | null = null;
  if (b0 & 0x80) {
    if (i >= len) return null;
    const b1 = payload[i++]!;
    if (b1 & 0x80) {
      if (i >= len) return null;
      if (payload[i]! & 0x80) {
        if (i + 1 >= len) return null;
        pictureId = { at: i, bits: 15 };
        i += 2;
      } else {
        pictureId = { at: i, bits: 7 };
        i += 1;
      }
    }
    if (b1 & 0x40) tl0 = i++;
    if (b1 & 0x30) i++;
  }
  if (i > len) return null;
  const start = (b0 & 0x10) !== 0 && (b0 & 0x07) === 0;
  // The VP8 payload header's P bit: 0 on key frames.
  const keyframe = start && i < len && (payload[i]! & 0x01) === 0;
  return { start, keyframe, pictureId, tl0 };
}

function readPictureId(p: Uint8Array, id: NonNullable<Vp8Info['pictureId']>) {
  return id.bits === 15 ? ((p[id.at]! & 0x7f) << 8) | p[id.at + 1]! : p[id.at]! & 0x7f;
}

function writePictureId(p: Uint8Array, id: NonNullable<Vp8Info['pictureId']>, v: number) {
  if (id.bits === 15) {
    p[id.at] = 0x80 | ((v >> 8) & 0x7f);
    p[id.at + 1] = v & 0xff;
  } else p[id.at] = v & 0x7f;
}

/**
 * Keeps one outgoing video stream continuous while the camera or screen it
 * carries changes: sequence numbers, timestamps (90 kHz) and VP8 picture ids
 * continue from where the previous source left off, so the viewer's decoder
 * sees one stream that starts again at a key frame.
 */
export class VideoRewriter {
  private source: string | null = null;
  private seqOffset = 0;
  private tsOffset = 0;
  private picOffset = 0;
  private tl0Offset = 0;
  private lastSeq = Math.floor(Math.random() * 0xffff);
  private lastTs = Math.floor(Math.random() * 0xffffffff);
  private lastPic = Math.floor(Math.random() * 0x7fff);
  private lastTl0 = Math.floor(Math.random() * 0xff);
  private lastAt = 0;

  /** Rewrites a packet from `source` in place; returns its new seq and timestamp. */
  rewrite(
    source: string,
    seq: number,
    ts: number,
    payload: Uint8Array,
    now: number,
  ): { seq: number; ts: number } {
    const info = vp8Info(payload);
    if (source !== this.source) {
      const ticks = this.lastAt ? Math.max(3000, Math.round((now - this.lastAt) * 90)) : 0;
      this.seqOffset = (this.lastSeq + 1 - seq) & 0xffff;
      this.tsOffset = (this.lastTs + ticks - ts) >>> 0;
      if (info?.pictureId)
        this.picOffset = (this.lastPic + 1 - readPictureId(payload, info.pictureId)) & 0x7fff;
      if (info?.tl0 !== null && info?.tl0 !== undefined)
        this.tl0Offset = (this.lastTl0 + 1 - payload[info.tl0]!) & 0xff;
      this.source = source;
    }
    const outSeq = (seq + this.seqOffset) & 0xffff;
    const outTs = (ts + this.tsOffset) >>> 0;
    if (info?.pictureId) {
      const mask = info.pictureId.bits === 15 ? 0x7fff : 0x7f;
      const pic = (readPictureId(payload, info.pictureId) + this.picOffset) & mask;
      writePictureId(payload, info.pictureId, pic);
      this.lastPic = pic;
    }
    if (info?.tl0 !== null && info?.tl0 !== undefined) {
      payload[info.tl0] = (payload[info.tl0]! + this.tl0Offset) & 0xff;
      this.lastTl0 = payload[info.tl0]!;
    }
    if (((outSeq - this.lastSeq) & 0xffff) < 0x8000) {
      this.lastSeq = outSeq;
      this.lastTs = outTs;
      this.lastAt = now;
    }
    return { seq: outSeq, ts: outTs };
  }

  /** The slot stopped carrying anything; the next source starts afresh. */
  reset() {
    this.source = null;
  }
}

// ---------------------------------------------------------------------------
// Sharing the host's upload
// ---------------------------------------------------------------------------

/** Assumed bitrate of a stream the relay hasn't measured yet. */
export const ASSUMED_KBPS = { camera: 900, screen: 1500 } as const;

/**
 * Which of the streams each member asked for (most wanted first) the host
 * sends them: their asks taken in turn (everyone's first, then everyone's
 * second…), as long as the member's own limit, the host's limit and the
 * member's slots allow. Streams already being sent are kept before new ones.
 */
export function allocate(opts: {
  requests: Map<string, string[]>;
  current: Map<string, Set<string>>;
  kbps: (stream: string) => number;
  viewerCap: (viewer: string) => number;
  hostCap: number;
  slots: number;
}): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const used = new Map<string, number>();
  let total = 0;
  for (const v of opts.requests.keys()) {
    out.set(v, []);
    used.set(v, 0);
  }
  const take = (viewer: string, stream: string) => {
    const list = out.get(viewer)!;
    if (list.includes(stream) || list.length >= opts.slots) return;
    const k = opts.kbps(stream);
    if (used.get(viewer)! + k > opts.viewerCap(viewer) || total + k > opts.hostCap) return;
    list.push(stream);
    used.set(viewer, used.get(viewer)! + k);
    total += k;
  };
  const depth = Math.max(0, ...[...opts.requests.values()].map((r) => r.length));
  // What is already flowing first, so a new ask doesn't take it away.
  for (let rank = 0; rank < depth; rank++)
    for (const [viewer, asks] of opts.requests) {
      const s = asks[rank];
      if (s && opts.current.get(viewer)?.has(s)) take(viewer, s);
    }
  for (let rank = 0; rank < depth; rank++)
    for (const [viewer, asks] of opts.requests) {
      const s = asks[rank];
      if (s) take(viewer, s);
    }
  // Keep each member's order as they asked.
  for (const [viewer, list] of out) {
    const asks = opts.requests.get(viewer)!;
    list.sort((a, b) => asks.indexOf(a) - asks.indexOf(b));
  }
  return out;
}

/** Loss a viewer reports (RTCP fraction lost) above which video backs off. */
export const LOSSY = 0.1;
/** Below this the connection counts as clean. */
export const CLEAN = 0.02;
const BACK_OFF = 0.85;
const GROW = 1.15;
/** How long things must stay clean before limits rise again. */
const CALM_MS = 8000;
const MIN_KBPS = 300;
export const HOST_START_KBPS = 10_000;

/**
 * Limits on video sent to each member and by the host overall, moved by the
 * loss members report: when most watchers lose packets the host's upload is
 * full, when one does it is their own connection. Limits drop to a little
 * under what was flowing and rise again slowly once things are clean.
 */
export class VideoLimits {
  host: number;
  private viewers = new Map<string, number>();
  private loss = new Map<string, number>();
  private lastDrop = 0;
  private lastViewerDrop = new Map<string, number>();

  constructor(startKbps = HOST_START_KBPS) {
    this.host = startKbps;
  }

  viewerCap(viewer: string) {
    return this.viewers.get(viewer) ?? Number.POSITIVE_INFINITY;
  }

  /** A viewer's latest loss on the video the host sends them (0..1). */
  report(viewer: string, fractionLost: number) {
    this.loss.set(viewer, Math.max(this.loss.get(viewer) ?? 0, fractionLost));
  }

  forget(viewer: string) {
    this.viewers.delete(viewer);
    this.loss.delete(viewer);
    this.lastViewerDrop.delete(viewer);
  }

  /**
   * Every couple of seconds: `usage` is the kbps sent to each viewer of
   * video. Returns whether any limit changed.
   */
  tick(usage: Map<string, number>, now: number): boolean {
    const watching = [...usage.entries()].filter(([, k]) => k > 0);
    const lossy = watching.filter(([v]) => (this.loss.get(v) ?? 0) > LOSSY);
    const total = watching.reduce((n, [, k]) => n + k, 0);
    this.loss.clear();
    let changed = false;
    if (watching.length > 0 && lossy.length * 2 >= watching.length && lossy.length > 0) {
      const next = Math.max(MIN_KBPS, Math.floor(total * BACK_OFF));
      if (next < this.host) {
        this.host = next;
        changed = true;
      }
      this.lastDrop = now;
      return changed;
    }
    for (const [v, k] of lossy) {
      const next = Math.max(MIN_KBPS, Math.floor(k * BACK_OFF));
      if (next < this.viewerCap(v)) {
        this.viewers.set(v, next);
        changed = true;
      }
      this.lastViewerDrop.set(v, now);
    }
    if (now - this.lastDrop > CALM_MS && lossy.length === 0) {
      const next = Math.floor(this.host * GROW);
      if (next !== this.host) {
        this.host = next;
        changed = true;
      }
    }
    for (const [v, cap] of this.viewers) {
      if (now - (this.lastViewerDrop.get(v) ?? 0) <= CALM_MS) continue;
      const next = cap * GROW;
      // Far above what they get: no limit at all.
      if (next > 4 * (usage.get(v) ?? 0) + 4 * MIN_KBPS) this.viewers.delete(v);
      else this.viewers.set(v, Math.floor(next));
      changed = true;
    }
    return changed;
  }
}

/** Measures a stream's bitrate over the last couple of seconds. */
export class RateMeter {
  private bytes = 0;
  private since: number;
  kbps = 0;

  constructor(now = Date.now()) {
    this.since = now;
  }

  add(n: number) {
    this.bytes += n;
  }

  /** Closes the current window; returns its kbps. */
  sample(now: number): number {
    const ms = Math.max(1, now - this.since);
    this.kbps = Math.round((this.bytes * 8) / ms);
    this.bytes = 0;
    this.since = now;
    return this.kbps;
  }
}
