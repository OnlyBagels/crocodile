import { fromB64u, toB64u } from '@crocodile/protocol';
import { aesGcmDecrypt, aesGcmEncrypt, hkdfSha256, randomBytes } from './primitives';
import { pad, unpad } from './padding';

/**
 * Sender keys with symmetric ratchets (as in Signal's group sender keys and
 * SFrame). Each member owns a key identified by `kid` with two hash chains:
 *
 *  - text chain: advances after every message, so a leaked chain key cannot
 *    decrypt earlier messages (per-message forward secrecy);
 *  - audio chain: advances every AUDIO_EPOCH_MS; frames within an epoch use
 *    a counter nonce.
 *
 * New members only ever receive the *current* chain keys, and members
 * replace their whole sender key with fresh randomness periodically and
 * whenever someone leaves, which heals the group after a compromise.
 *
 * Voice frame layout (SFrame-like trailer, authenticated as AAD):
 *   ciphertext ‖ GCM tag(16) ‖ kid u32 ‖ gen u16 ‖ counter u32 ‖ 0xC8
 *
 * Video frames use their own key from the same chain (another HKDF label)
 * and may leave the first bytes of the frame in the clear, for the codec's
 * payload header the receiving app needs before it can decrypt:
 *   clear ‖ ciphertext ‖ GCM tag(16) ‖ kid u32 ‖ gen u16 ‖ counter u32 ‖
 *   clear length u8 ‖ 0xC9
 * The clear bytes and the trailer are authenticated.
 */
export const FRAME_MAGIC = 0xc8;
export const FRAME_TRAILER_BYTES = 11;
export const VIDEO_FRAME_MAGIC = 0xc9;
export const VIDEO_FRAME_TRAILER_BYTES = 12;
/** Most bytes a video frame may leave in the clear. */
export const VIDEO_MAX_CLEAR = 64;
export const AUDIO_EPOCH_MS = 30_000;
const TAG_BYTES = 16;
const MAX_TEXT_SKIP = 2000;
const MAX_SKIPPED_KEYS = 256;
const MAX_AUDIO_SKIP = 16;
/**
 * Frames a receiver remembers having taken, counting back from the newest. The counter is shared
 * by every stream of a sender (the camera and the screen, say), so this is some seconds of video.
 */
const REPLAY_WINDOW = 1024;

export interface ChainState {
  gen: number;
  key: Uint8Array;
}

export interface SenderKey {
  kid: number;
  text: ChainState;
  audio: ChainState;
}

export interface ExportedChains {
  kid: number;
  text: { gen: number; key: string };
  audio: { gen: number; key: string };
}

function kidBytes(kid: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, kid >>> 0);
  return b;
}

export function createSenderKey(): SenderKey {
  const b = randomBytes(4);
  const kid = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const seed = randomBytes(32);
  return {
    kid,
    text: { gen: 0, key: hkdfSha256(seed, kidBytes(kid), 'croc/v2/text-chain', 32) },
    audio: { gen: 0, key: hkdfSha256(seed, kidBytes(kid), 'croc/v2/audio-chain', 32) },
  };
}

export function ratchet(chain: ChainState): ChainState {
  return {
    gen: chain.gen + 1,
    key: hkdfSha256(chain.key, new Uint8Array(0), 'croc/v2/ratchet', 32),
  };
}

interface MessageKey {
  key: Uint8Array;
  salt: Uint8Array;
}

function messageKey(chain: ChainState, kid: number, label: 'text' | 'audio' | 'video'): MessageKey {
  const okm = hkdfSha256(chain.key, kidBytes(kid), `croc/v2/${label}-message`, 44);
  return { key: okm.slice(0, 32), salt: okm.slice(32, 44) };
}

export function exportChains(sk: SenderKey): ExportedChains {
  return {
    kid: sk.kid,
    text: { gen: sk.text.gen, key: toB64u(sk.text.key) },
    audio: { gen: sk.audio.gen, key: toB64u(sk.audio.key) },
  };
}

export function importChain(c: { gen: number; key: string }): ChainState {
  const key = fromB64u(c.key);
  if (key.length !== 32) throw new Error('bad chain key');
  return { gen: c.gen, key };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function textAad(kid: number, gen: number) {
  const aad = new Uint8Array(8);
  const v = new DataView(aad.buffer);
  v.setUint32(0, kid >>> 0);
  v.setUint32(4, gen >>> 0);
  return aad;
}

/** Encrypts and advances the sender's text chain (mutates `sk`). */
export function encryptText(
  sk: SenderKey,
  plaintext: Uint8Array,
): { kid: number; g: number; ct: string } {
  const mk = messageKey(sk.text, sk.kid, 'text');
  const g = sk.text.gen;
  const ct = aesGcmEncrypt(mk.key, mk.salt, pad(plaintext), textAad(sk.kid, g));
  sk.text = ratchet(sk.text);
  return { kid: sk.kid, g, ct: toB64u(ct) };
}

/** Receiving side of one sender's text chain, tolerant of small reordering. */
export class TextReceiver {
  private skipped = new Map<number, MessageKey>();
  constructor(
    readonly kid: number,
    private chain: ChainState,
  ) {}

  get gen() {
    return this.chain.gen;
  }

  decrypt(g: number, ct: string): Uint8Array | null {
    let data: Uint8Array;
    try {
      data = fromB64u(ct);
    } catch {
      return null;
    }
    const aad = textAad(this.kid, g);
    if (g < this.chain.gen) {
      const mk = this.skipped.get(g);
      if (!mk) return null;
      const out = aesGcmDecrypt(mk.key, mk.salt, data, aad);
      if (out) this.skipped.delete(g);
      return out && unpad(out);
    }
    if (g - this.chain.gen > MAX_TEXT_SKIP) return null;
    // Work on a copy; only commit if the message authenticates.
    let chain = this.chain;
    const skipped: [number, MessageKey][] = [];
    while (chain.gen < g) {
      skipped.push([chain.gen, messageKey(chain, this.kid, 'text')]);
      chain = ratchet(chain);
    }
    const mk = messageKey(chain, this.kid, 'text');
    const out = aesGcmDecrypt(mk.key, mk.salt, data, aad);
    if (!out) return null;
    for (const [gen, k] of skipped) this.skipped.set(gen, k);
    while (this.skipped.size > MAX_SKIPPED_KEYS)
      this.skipped.delete(this.skipped.keys().next().value!);
    this.chain = ratchet(chain);
    return unpad(out);
  }
}

// ---------------------------------------------------------------------------
// Audio frames
// ---------------------------------------------------------------------------

function frameNonce(salt: Uint8Array, counter: number) {
  const nonce = salt.slice();
  const v = new DataView(nonce.buffer);
  v.setUint32(8, v.getUint32(8) ^ (counter >>> 0));
  return nonce;
}

/** A random 32-bit start for a frame counter (see AudioSender). */
function randomCounter(): number {
  return new DataView(randomBytes(4).buffer).getUint32(0);
}

/**
 * Encrypts outgoing voice frames with the audio chain's current message key.
 * The AES-GCM nonce is the key's salt XOR a per-frame counter, so a counter
 * must never repeat under one key: callers never build two senders for one
 * chain state, and keep the one they have across connections (listeners that stay refuse a
 * counter they have already passed, as replayed, so a sender that started over would be
 * unheard until the chain moves on). The counter starts at a random point, as a second line of
 * defence.
 */
export class AudioSender {
  private mk: MessageKey;
  private counter = randomCounter();
  constructor(
    readonly kid: number,
    private chain: ChainState,
  ) {
    this.mk = messageKey(chain, kid, 'audio');
  }

  get gen() {
    return this.chain.gen;
  }

  /** Moves to a newer generation of the same chain (sent by the keyring). */
  update(chain: ChainState) {
    if (chain.gen <= this.chain.gen) return;
    this.chain = chain;
    this.mk = messageKey(chain, this.kid, 'audio');
    this.counter = randomCounter();
  }

  encrypt(frame: Uint8Array): Uint8Array {
    const trailer = new Uint8Array(FRAME_TRAILER_BYTES);
    const tv = new DataView(trailer.buffer);
    const counter = this.counter++ >>> 0;
    tv.setUint32(0, this.kid);
    tv.setUint16(4, this.chain.gen & 0xffff);
    tv.setUint32(6, counter);
    trailer[10] = FRAME_MAGIC;
    const ct = aesGcmEncrypt(this.mk.key, frameNonce(this.mk.salt, counter), frame, trailer);
    const out = new Uint8Array(ct.length + FRAME_TRAILER_BYTES);
    out.set(ct, 0);
    out.set(trailer, ct.length);
    return out;
  }
}

/** The sender key id of an encrypted audio or video frame. */
export function peekFrameKid(data: Uint8Array): number | null {
  const magic = data[data.length - 1];
  const trailer =
    magic === FRAME_MAGIC
      ? FRAME_TRAILER_BYTES
      : magic === VIDEO_FRAME_MAGIC
        ? VIDEO_FRAME_TRAILER_BYTES
        : 0;
  if (!trailer || data.length < trailer + TAG_BYTES) return null;
  return new DataView(data.buffer, data.byteOffset + data.length - trailer, 4).getUint32(0);
}

/**
 * Which frame counters of one key have been taken, as in SRTP and SFrame: the newest, and a
 * window of those just before it. A counter is refused if it was taken, or is older than the
 * window. Counters start anywhere and wrap, so they are compared by distance.
 */
class ReplayWindow {
  private newest: number | null = null;
  private seen = new Uint8Array(REPLAY_WINDOW);

  /** Whether a frame with this counter may still be taken (call `take` once it is verified). */
  fresh(counter: number): boolean {
    if (this.newest === null) return true;
    const back = (this.newest - counter) | 0;
    if (back < 0) return true;
    return back < REPLAY_WINDOW && !this.seen[counter % REPLAY_WINDOW];
  }

  take(counter: number) {
    if (this.newest === null) {
      this.newest = counter;
    } else {
      const ahead = (counter - this.newest) | 0;
      if (ahead > 0) {
        for (let i = 1; i <= Math.min(ahead, REPLAY_WINDOW); i++)
          this.seen[(this.newest + i) % REPLAY_WINDOW] = 0;
        this.newest = counter;
      }
    }
    this.seen[counter % REPLAY_WINDOW] = 1;
  }
}

export class AudioReceiver {
  /** Message key and taken counters, for the current generation and the one before it. */
  private keys = new Map<number, { mk: MessageKey; window: ReplayWindow }>();
  constructor(
    readonly kid: number,
    private chain: ChainState,
  ) {
    this.keys.set(chain.gen, { mk: messageKey(chain, kid, 'audio'), window: new ReplayWindow() });
  }

  get gen() {
    return this.chain.gen;
  }

  decrypt(data: Uint8Array): Uint8Array | null {
    if (data.length < FRAME_TRAILER_BYTES + TAG_BYTES || data[data.length - 1] !== FRAME_MAGIC)
      return null;
    const trailer = data.subarray(data.length - FRAME_TRAILER_BYTES);
    const tv = new DataView(trailer.buffer, trailer.byteOffset, FRAME_TRAILER_BYTES);
    if (tv.getUint32(0) !== this.kid) return null;
    const gen16 = tv.getUint16(4);
    const counter = tv.getUint32(6);
    // Map the 16-bit generation onto our chain position.
    const current16 = this.chain.gen & 0xffff;
    const ahead = (gen16 - current16) & 0xffff;
    let target: number;
    if (ahead <= MAX_AUDIO_SKIP) target = this.chain.gen + ahead;
    else if (((current16 - gen16) & 0xffff) <= 1)
      target = this.chain.gen - ((current16 - gen16) & 0xffff);
    else return null;
    let entry = this.keys.get(target);
    let mk = entry?.mk;
    let chain = this.chain;
    if (!mk && target > chain.gen) {
      while (chain.gen < target) chain = ratchet(chain);
      mk = messageKey(chain, this.kid, 'audio');
    }
    if (!mk) return null;
    entry ??= { mk, window: new ReplayWindow() };
    if (!entry.window.fresh(counter)) return null;
    const plain = aesGcmDecrypt(
      mk.key,
      frameNonce(mk.salt, counter),
      data.subarray(0, data.length - FRAME_TRAILER_BYTES),
      trailer,
    );
    if (!plain) return null;
    entry.window.take(counter);
    if (target > this.chain.gen) {
      // Keep only the previous generation for frames reordered across the boundary.
      const prev = this.keys.get(this.chain.gen);
      this.keys.clear();
      if (target - this.chain.gen === 1 && prev) this.keys.set(this.chain.gen, prev);
      this.chain = chain;
    }
    this.keys.set(target, entry);
    return plain;
  }
}

// ---------------------------------------------------------------------------
// Video frames
// ---------------------------------------------------------------------------

/**
 * Encrypts outgoing video frames (camera and screen) under the audio chain's
 * video message key. As with AudioSender, one sender per chain state: every
 * stream of a device shares it, so the counter never repeats.
 */
export class VideoSender {
  private mk: MessageKey;
  private counter = randomCounter();
  constructor(
    readonly kid: number,
    private chain: ChainState,
  ) {
    this.mk = messageKey(chain, kid, 'video');
  }

  get gen() {
    return this.chain.gen;
  }

  update(chain: ChainState) {
    if (chain.gen <= this.chain.gen) return;
    this.chain = chain;
    this.mk = messageKey(chain, this.kid, 'video');
    this.counter = randomCounter();
  }

  /** `clear`: how many leading bytes stay readable (the codec's payload header). */
  encrypt(frame: Uint8Array, clear = 0): Uint8Array {
    const n = Math.max(0, Math.min(clear, VIDEO_MAX_CLEAR, frame.length));
    const trailer = new Uint8Array(VIDEO_FRAME_TRAILER_BYTES);
    const tv = new DataView(trailer.buffer);
    const counter = this.counter++ >>> 0;
    tv.setUint32(0, this.kid);
    tv.setUint16(4, this.chain.gen & 0xffff);
    tv.setUint32(6, counter);
    trailer[10] = n;
    trailer[11] = VIDEO_FRAME_MAGIC;
    const head = frame.subarray(0, n);
    const aad = new Uint8Array(n + VIDEO_FRAME_TRAILER_BYTES);
    aad.set(head, 0);
    aad.set(trailer, n);
    const ct = aesGcmEncrypt(
      this.mk.key,
      frameNonce(this.mk.salt, counter),
      frame.subarray(n),
      aad,
    );
    const out = new Uint8Array(n + ct.length + VIDEO_FRAME_TRAILER_BYTES);
    out.set(head, 0);
    out.set(ct, n);
    out.set(trailer, n + ct.length);
    return out;
  }
}

export class VideoReceiver {
  /** Message key and taken counters, for the current generation and the one before it. */
  private keys = new Map<number, { mk: MessageKey; window: ReplayWindow }>();
  constructor(
    readonly kid: number,
    private chain: ChainState,
  ) {
    this.keys.set(chain.gen, { mk: messageKey(chain, kid, 'video'), window: new ReplayWindow() });
  }

  get gen() {
    return this.chain.gen;
  }

  decrypt(data: Uint8Array): Uint8Array | null {
    if (
      data.length < VIDEO_FRAME_TRAILER_BYTES + TAG_BYTES ||
      data[data.length - 1] !== VIDEO_FRAME_MAGIC
    )
      return null;
    const trailer = data.subarray(data.length - VIDEO_FRAME_TRAILER_BYTES);
    const tv = new DataView(trailer.buffer, trailer.byteOffset, VIDEO_FRAME_TRAILER_BYTES);
    if (tv.getUint32(0) !== this.kid) return null;
    const gen16 = tv.getUint16(4);
    const counter = tv.getUint32(6);
    const n = trailer[10]!;
    if (n > VIDEO_MAX_CLEAR || n + TAG_BYTES + VIDEO_FRAME_TRAILER_BYTES > data.length) return null;
    const current16 = this.chain.gen & 0xffff;
    const ahead = (gen16 - current16) & 0xffff;
    let target: number;
    if (ahead <= MAX_AUDIO_SKIP) target = this.chain.gen + ahead;
    else if (((current16 - gen16) & 0xffff) <= 1)
      target = this.chain.gen - ((current16 - gen16) & 0xffff);
    else return null;
    let entry = this.keys.get(target);
    let mk = entry?.mk;
    let chain = this.chain;
    if (!mk && target > chain.gen) {
      while (chain.gen < target) chain = ratchet(chain);
      mk = messageKey(chain, this.kid, 'video');
    }
    if (!mk) return null;
    entry ??= { mk, window: new ReplayWindow() };
    if (!entry.window.fresh(counter)) return null;
    const head = data.subarray(0, n);
    const aad = new Uint8Array(n + VIDEO_FRAME_TRAILER_BYTES);
    aad.set(head, 0);
    aad.set(trailer, n);
    const body = aesGcmDecrypt(
      mk.key,
      frameNonce(mk.salt, counter),
      data.subarray(n, data.length - VIDEO_FRAME_TRAILER_BYTES),
      aad,
    );
    if (!body) return null;
    entry.window.take(counter);
    if (target > this.chain.gen) {
      const prev = this.keys.get(this.chain.gen);
      this.keys.clear();
      if (target - this.chain.gen === 1 && prev) this.keys.set(this.chain.gen, prev);
      this.chain = chain;
    }
    this.keys.set(target, entry);
    const out = new Uint8Array(n + body.length);
    out.set(head, 0);
    out.set(body, n);
    return out;
  }
}
