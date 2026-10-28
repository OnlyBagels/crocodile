import {
  AUDIO_EPOCH_MS,
  AudioReceiver,
  AudioSender,
  VideoReceiver,
  VideoSender,
  importChain,
} from '@crocodile/crypto';
import type { FrameKeys } from './keyring';

/**
 * How long a listener's counters are kept with no connection left: past a generation of the
 * audio chain, frames recorded earlier are of one that is no longer followed, and a key
 * shouldn't linger once the call is left.
 */
const KEEP_IDLE_MS = AUDIO_EPOCH_MS * 1.5;

export interface FrameScope {
  sender: AudioSender | null;
  receivers: Map<number, AudioReceiver>;
  video: VideoSender | null;
  videoReceivers: Map<number, VideoReceiver>;
  /** Keys (in `FrameScopes.heard`) of the senders this connection listens to. */
  holds: Set<string>;
}

/** What is kept of one sender key of someone else. */
interface Heard {
  audio: AudioReceiver;
  video: VideoReceiver;
  /** When a connection last had the key. */
  lastUsed: number;
}

/**
 * The frame worker's key state, one scope per connection. Scopes share one
 * sender per sender key (one for audio, one for video): a reconnect gets a
 * new scope, and its frames must continue the same counter rather than start
 * over and reuse nonces. Every stream of a kind shares its sender too (the
 * microphone and a shared screen's sound; the camera and the screen).
 *
 * A connection that begins after the last one ended gets a new sender, on a
 * chain that voice.ts has moved on first, so its key and counter are new.
 *
 * Receivers are shared, one per sender key of someone else (by sender and key
 * id: ids are public, and sessions share the worker), with the counters they
 * have taken: a host that cuts a listener's connection can't have a frame the
 * listener took taken again.
 */
export class FrameScopes {
  readonly scopes = new Map<string, FrameScope>();
  private senders = new Map<number, AudioSender>();
  private videoSenders = new Map<number, VideoSender>();
  private heard = new Map<string, Heard>();
  private idleTimer?: ReturnType<typeof setTimeout>;

  get(id: string): FrameScope | undefined {
    return this.scopes.get(id);
  }

  update(id: string, keys: FrameKeys) {
    this.prune();
    let s = this.scopes.get(id);
    if (!s)
      this.scopes.set(
        id,
        (s = {
          sender: null,
          receivers: new Map(),
          video: null,
          videoReceivers: new Map(),
          holds: new Set(),
        }),
      );
    if (keys.mine) {
      const chain = () => importChain({ gen: keys.mine!.gen, key: keys.mine!.key });
      let sender = this.senders.get(keys.mine.kid);
      if (!sender) {
        sender = new AudioSender(keys.mine.kid, chain());
        this.senders.set(keys.mine.kid, sender);
      } else sender.update(chain());
      s.sender = sender;
      let video = this.videoSenders.get(keys.mine.kid);
      if (!video) {
        video = new VideoSender(keys.mine.kid, chain());
        this.videoSenders.set(keys.mine.kid, video);
      } else video.update(chain());
      s.video = video;
    }
    s.receivers = new Map();
    s.videoReceivers = new Map();
    s.holds = new Set();
    const now = Date.now();
    for (const p of keys.peers) {
      const kid = p.kid >>> 0;
      const key = `${p.peer}|${kid}`;
      const chain = () => importChain({ gen: p.gen, key: p.key });
      // Keep receivers we already have: they may have ratcheted past the given state, and have
      // the counters taken so far. If the key was sent again and is ahead of them, they follow.
      let h = this.heard.get(key);
      if (!h)
        this.heard.set(
          key,
          (h = {
            audio: new AudioReceiver(kid, chain()),
            video: new VideoReceiver(kid, chain()),
            lastUsed: now,
          }),
        );
      else if (p.gen > h.audio.gen) {
        h.audio.catchUp(chain());
        h.video.catchUp(chain());
      }
      h.lastUsed = now;
      s.receivers.set(kid, h.audio);
      s.videoReceivers.set(kid, h.video);
      s.holds.add(key);
    }
    this.prune();
  }

  /**
   * Receivers are forgotten once no connection has had their key for a while: replaced keys,
   * and a call that was left.
   */
  private prune() {
    const now = Date.now();
    const held = new Set([...this.scopes.values()].flatMap((sc) => [...sc.holds]));
    for (const [key, h] of this.heard) {
      if (held.has(key)) h.lastUsed = now;
      else if (now - h.lastUsed > KEEP_IDLE_MS) this.heard.delete(key);
    }
  }

  drop(id: string) {
    const gone = this.scopes.get(id);
    this.scopes.delete(id);
    // What it was listening to is kept from now on, whenever its keys were last posted.
    const now = Date.now();
    for (const key of gone?.holds ?? []) {
      const h = this.heard.get(key);
      if (h) h.lastUsed = now;
    }
    // Forget senders no scope uses any more (their keys have been replaced).
    const inUse = new Set([...this.scopes.values()].flatMap((sc) => [sc.sender, sc.video]));
    for (const [kid, sender] of this.senders) if (!inUse.has(sender)) this.senders.delete(kid);
    for (const [kid, sender] of this.videoSenders)
      if (!inUse.has(sender)) this.videoSenders.delete(kid);
    this.prune();
    this.armIdleTimer();
  }

  /** Looks again after the wait, until nothing is left. */
  private armIdleTimer() {
    clearTimeout(this.idleTimer);
    if (this.heard.size === 0) return;
    this.idleTimer = setTimeout(() => {
      this.prune();
      this.armIdleTimer();
    }, KEEP_IDLE_MS + 1000);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }
}

/**
 * How many leading bytes of a VP8 frame stay readable: the payload header
 * the receiving side's depacketizer needs (10 bytes of a key frame, 3 of
 * another frame), as in other end-to-end encrypted VP8 calls.
 */
export function vp8ClearBytes(keyframe: boolean) {
  return keyframe ? 10 : 3;
}
