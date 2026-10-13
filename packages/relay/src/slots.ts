/**
 * Speaker-slot allocation ("last-N"). Each listener has a fixed number of
 * downstream audio slots; the relay maps whoever is currently talking onto
 * them. This keeps SDP static (no renegotiation when people join or leave)
 * and bounds per-listener bandwidth no matter how large the room gets.
 */
export const SPEECH_HANGOVER_MS = 1200;

export class SlotTable {
  readonly slots: (string | null)[];
  constructor(count: number) {
    this.slots = new Array<string | null>(count).fill(null);
  }

  indexOf(speaker: string) {
    return this.slots.indexOf(speaker);
  }

  /**
   * Returns the slot for `speaker`, assigning one if possible. `lastLoud`
   * gives each speaker's last loud-packet time so we can evict the speaker
   * that has been quiet the longest. Returns -1 if every slot is busy with
   * someone who spoke more recently than the hangover.
   */
  assign(speaker: string, now: number, lastLoud: (id: string) => number): number {
    const existing = this.slots.indexOf(speaker);
    if (existing >= 0) return existing;
    let victim = -1;
    let victimLoud = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.slots.length; i++) {
      const occupant = this.slots[i] ?? null;
      if (occupant === null) {
        victim = i;
        victimLoud = Number.NEGATIVE_INFINITY;
        break;
      }
      const loud = lastLoud(occupant);
      if (now - loud > SPEECH_HANGOVER_MS && loud < victimLoud) {
        victim = i;
        victimLoud = loud;
      }
    }
    if (victim >= 0) this.slots[victim] = speaker;
    return victim;
  }

  release(speaker: string): boolean {
    const i = this.slots.indexOf(speaker);
    if (i < 0) return false;
    this.slots[i] = null;
    return true;
  }
}

/** Keeps a slot's outgoing RTP stream continuous while its source changes. */
export class StreamRewriter {
  private source: string | null = null;
  private seqOffset = 0;
  private tsOffset = 0;
  private lastSeq = Math.floor(Math.random() * 0xffff);
  private lastTs = Math.floor(Math.random() * 0xffffffff);
  private lastAt = 0;

  constructor(private readonly clockRate = 48_000) {}

  /** Returns rewritten (seq, ts, marker) for a packet from `source`. */
  rewrite(
    source: string,
    seq: number,
    ts: number,
    now: number,
  ): { seq: number; ts: number; marker: boolean } {
    let marker = false;
    if (source !== this.source) {
      const elapsedTicks = this.lastAt
        ? Math.max(960, Math.round(((now - this.lastAt) / 1000) * this.clockRate))
        : 0;
      this.seqOffset = (this.lastSeq + 1 - seq) & 0xffff;
      this.tsOffset = (this.lastTs + elapsedTicks - ts) >>> 0;
      this.source = source;
      marker = true;
    }
    const outSeq = (seq + this.seqOffset) & 0xffff;
    const outTs = (ts + this.tsOffset) >>> 0;
    // Only move forward; late or reordered packets keep their relative position.
    if (((outSeq - this.lastSeq) & 0xffff) < 0x8000) {
      this.lastSeq = outSeq;
      this.lastTs = outTs;
      this.lastAt = now;
    }
    return { seq: outSeq, ts: outTs, marker };
  }

  /** The slot stopped carrying anything; whatever comes next starts afresh. */
  reset() {
    this.source = null;
  }
}
