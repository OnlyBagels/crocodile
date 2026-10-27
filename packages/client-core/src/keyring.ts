import {
  AUDIO_EPOCH_MS,
  TextReceiver,
  createSenderKey,
  encryptText,
  exportChains,
  importChain,
  ratchet,
  type ChainState,
  type ExportedChains,
  type SenderKey,
} from '@crocodile/crypto';
import { toB64u } from '@crocodile/protocol';
import { Emitter } from './emitter';

interface PeerKey {
  peer: string;
  kid: number;
  text: TextReceiver;
  /** Audio chain as received; the frame worker ratchets it forward itself. */
  audio: ChainState;
  /** When set, the key is dropped after this time (superseded, or peer left). */
  expiresAt: number | null;
}

/** Snapshot handed to the voice frame worker. */
export interface FrameKeys {
  mine: { kid: number; gen: number; key: string } | null;
  peers: { kid: number; peer: string; gen: number; key: string }[];
}

const GRACE_MS = 10_000;
/** Superseded key ids remembered, so that a replayed old key can't come back. */
const RETIRED_MAX = 1000;
/** Fresh sender key (new randomness) at least this often: post-compromise healing. */
export const SENDER_KEY_ROTATION_MS = 30 * 60_000;

/**
 * Sender keys for one session: our own ratcheting key and the keys other
 * members sealed to us. Our key is replaced whenever a member leaves and
 * every 30 minutes; the audio chain ratchets every 30 s and the text chain
 * after every message.
 */
export class GroupKeyring extends Emitter<{ changed: FrameKeys; rotated: ExportedChains }> {
  private mine: SenderKey;
  private peers = new Map<number, PeerKey>();
  /** Key ids a peer has replaced with a newer one. */
  private retired = new Set<number>();
  /** When the newest key we took from each peer was sealed. */
  private newest = new Map<string, number>();
  private audioTimer?: ReturnType<typeof setInterval>;
  private rotateTimer?: ReturnType<typeof setInterval>;

  constructor(opts: { autoRatchet?: boolean } = {}) {
    super();
    this.mine = createSenderKey();
    if (opts.autoRatchet !== false) {
      this.audioTimer = setInterval(() => this.advanceAudio(), AUDIO_EPOCH_MS);
      this.rotateTimer = setInterval(() => this.rotate(), SENDER_KEY_ROTATION_MS);
      (this.audioTimer as { unref?: () => void }).unref?.();
      (this.rotateTimer as { unref?: () => void }).unref?.();
    }
  }

  dispose() {
    clearInterval(this.audioTimer);
    clearInterval(this.rotateTimer);
    this.removeAll();
  }

  get kid() {
    return this.mine.kid;
  }

  /** Current chain state to hand to a (new) member: never earlier generations. */
  exportMine(): ExportedChains {
    return exportChains(this.mine);
  }

  rotate(): ExportedChains {
    this.mine = createSenderKey();
    const exported = exportChains(this.mine);
    this.emit('rotated', exported);
    this.emitChanged();
    return exported;
  }

  advanceAudio() {
    this.mine.audio = ratchet(this.mine.audio);
    this.emitChanged();
  }

  /**
   * `at` is when the peer sealed the key. A key older than the newest we took from them, or one
   * they have already replaced, is a replay: taking it would bring back keys that had expired.
   */
  addPeerKey(peer: string, chains: ExportedChains, at = Date.now()): boolean {
    const kid = chains.kid >>> 0;
    if (this.retired.has(kid) || at < (this.newest.get(peer) ?? 0)) return false;
    const existing = this.peers.get(kid);
    if (existing && existing.peer !== peer) return false;
    this.newest.set(peer, at);
    // Re-sent current state for a key we already track: keep our (newer) text
    // receiver, but take a newer audio position. Receivers for a new
    // connection start from it, and can only skip a few generations ahead.
    if (existing && existing.text.gen >= chains.text.gen) {
      if (chains.audio.gen > existing.audio.gen) {
        existing.audio = importChain(chains.audio);
        this.emitChanged();
      }
      return true;
    }
    const now = Date.now();
    for (const p of this.peers.values()) {
      if (p.peer === peer && p.kid !== kid && p.expiresAt === null) {
        p.expiresAt = now + GRACE_MS;
        this.retire(p.kid);
      }
    }
    this.peers.set(kid, {
      peer,
      kid,
      text: new TextReceiver(kid, importChain(chains.text)),
      audio: importChain(chains.audio),
      expiresAt: null,
    });
    this.emitChanged();
    return true;
  }

  private retire(kid: number) {
    this.retired.add(kid);
    if (this.retired.size > RETIRED_MAX) this.retired.delete(this.retired.values().next().value!);
  }

  hasKeyFrom(peer: string) {
    for (const p of this.peers.values()) if (p.peer === peer && p.expiresAt === null) return true;
    return false;
  }

  /** Stop accepting a peer's keys at once (they were blocked or removed). */
  forgetPeer(peer: string) {
    for (const [k, p] of this.peers) if (p.peer === peer) this.peers.delete(k);
  }

  peerLeft(peer: string) {
    const at = Date.now() + GRACE_MS;
    for (const p of this.peers.values())
      if (p.peer === peer && p.expiresAt === null) p.expiresAt = at;
  }

  encrypt(plaintext: Uint8Array) {
    return encryptText(this.mine, plaintext);
  }

  decrypt(kid: number, g: number, ct: string): { peer: string; plaintext: Uint8Array } | null {
    this.prune();
    const pk = this.peers.get(kid >>> 0);
    if (!pk) return null;
    const plaintext = pk.text.decrypt(g, ct);
    return plaintext ? { peer: pk.peer, plaintext } : null;
  }

  frameKeys(): FrameKeys {
    this.prune();
    return {
      mine: { kid: this.mine.kid, gen: this.mine.audio.gen, key: toB64u(this.mine.audio.key) },
      peers: [...this.peers.values()].map((p) => ({
        kid: p.kid,
        peer: p.peer,
        gen: p.audio.gen,
        key: toB64u(p.audio.key),
      })),
    };
  }

  private prune() {
    const now = Date.now();
    let changed = false;
    for (const [kid, p] of this.peers) {
      if (p.expiresAt !== null && p.expiresAt < now) {
        this.peers.delete(kid);
        changed = true;
      }
    }
    if (changed) this.emitChanged();
  }

  private emitChanged() {
    this.emit('changed', this.frameKeys());
  }
}
