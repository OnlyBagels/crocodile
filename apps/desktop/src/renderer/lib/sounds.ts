/**
 * The app's sounds, synthesised with Web Audio: nothing to download or
 * license, and they follow the volume setting.
 */
export type SoundName =
  'message' | 'mention' | 'ring' | 'ringback' | 'join' | 'leave' | 'hangup' | 'mute' | 'unmute';

/** One tone: frequency (Hz), start and length (s), loudness (0–1). */
export interface Note {
  f: number;
  at: number;
  len: number;
  gain: number;
  wave?: OscillatorType;
}

const n = (f: number, at: number, len: number, gain = 0.5, wave?: OscillatorType): Note => ({
  f,
  at,
  len,
  gain,
  ...(wave ? { wave } : {}),
});

export const SOUNDS: Record<SoundName, Note[]> = {
  // A soft "pop" up a fifth.
  message: [n(660, 0, 0.09, 0.35), n(990, 0.07, 0.12, 0.3)],
  // Brighter, three notes: someone said your name.
  mention: [n(784, 0, 0.09, 0.4), n(988, 0.08, 0.09, 0.4), n(1319, 0.16, 0.16, 0.35)],
  // Incoming call: two trills, like a phone.
  ring: [
    ...[0, 0.1, 0.2, 0.3].map((t) => n(880, t, 0.08, 0.32, 'triangle')),
    ...[0.5, 0.6, 0.7, 0.8].map((t) => n(1047, t, 0.08, 0.32, 'triangle')),
  ],
  // What the caller hears while it rings on the other side.
  ringback: [n(440, 0, 0.9, 0.18), n(480, 0, 0.9, 0.14)],
  // Someone (or you) joined: rising.
  join: [n(523, 0, 0.1, 0.35), n(784, 0.09, 0.16, 0.35)],
  // Someone left: falling.
  leave: [n(784, 0, 0.1, 0.3), n(523, 0.09, 0.16, 0.3)],
  // The call ended for you.
  hangup: [n(659, 0, 0.12, 0.35), n(523, 0.11, 0.12, 0.35), n(392, 0.22, 0.22, 0.35)],
  mute: [n(392, 0, 0.06, 0.25)],
  unmute: [n(587, 0, 0.06, 0.25)],
};

/** How long a sound lasts, in ms. */
export function soundLength(name: SoundName): number {
  return Math.round(Math.max(...SOUNDS[name].map((x) => x.at + x.len)) * 1000);
}

/**
 * Which sound, if any, a new message makes: a mention always does; any
 * other message only when you aren't looking at its conversation. Nothing
 * for your own messages, edits, or while busy.
 */
export function messageSound(m: {
  mine: boolean;
  update: boolean;
  mentionsMe: boolean;
  busy: boolean;
  watching: boolean;
}): SoundName | null {
  if (m.mine || m.update || m.busy) return null;
  if (m.mentionsMe) return 'mention';
  return m.watching ? null : 'message';
}

/** Plays sounds through the default output, at a volume from 0 to 1. */
export class SoundPlayer {
  private ctx: AudioContext | null = null;
  volume = 0.6;

  play(name: SoundName) {
    if (this.volume <= 0) return;
    try {
      this.ctx ??= new AudioContext();
      const ctx = this.ctx;
      if (ctx.state === 'suspended') void ctx.resume();
      const now = ctx.currentTime + 0.01;
      const out = ctx.createGain();
      out.gain.value = this.volume * 0.5;
      out.connect(ctx.destination);
      for (const note of SOUNDS[name]) {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = note.wave ?? 'sine';
        osc.frequency.value = note.f;
        // Quick attack and a smooth fade, so tones don't click.
        const start = now + note.at;
        env.gain.setValueAtTime(0, start);
        env.gain.linearRampToValueAtTime(note.gain, start + 0.012);
        env.gain.exponentialRampToValueAtTime(0.0001, start + note.len);
        osc.connect(env).connect(out);
        osc.start(start);
        osc.stop(start + note.len + 0.02);
      }
    } catch {
      // No audio output (or none allowed): sounds are a nicety.
    }
  }

  /** Play a sound now and every `everyMs` until the returned function is called. */
  loop(name: SoundName, everyMs: number): () => void {
    this.play(name);
    const t = setInterval(() => this.play(name), everyMs);
    return () => clearInterval(t);
  }
}
