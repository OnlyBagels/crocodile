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
 * How long our senders and the listeners' counters are kept with no connection left: past a
 * generation of the audio chain they are no use (the chain has moved on), and a key shouldn't
 * linger once the call is left.
 */
const KEEP_IDLE_MS = AUDIO_EPOCH_MS * 1.5;

export interface FrameScope {
  sender: AudioSender | null;
  receivers: Map<number, AudioReceiver>;
  video: VideoSender | null;
  videoReceivers: Map<number, VideoReceiver>;
}

/**
 * The frame worker's key state, one scope per connection. A reconnect gets a new scope, and what
 * the scopes use outlives them:
 *
 * - One sender per sender key of ours (one for audio, one for video): its frames must continue
 *   the same counter rather than start over, both to not reuse nonces and because listeners
 *   that stayed refuse a counter they have passed. Every stream of a kind shares its sender too
 *   (the microphone and a shared screen's sound; the camera and the screen).
 * - One receiver per sender key of someone else, with the counters it has taken: a host that
 *   cuts a listener's connection can't have recorded frames taken again.
 */
export class FrameScopes {
  readonly scopes = new Map<string, FrameScope>();
  private senders = new Map<number, AudioSender>();
  private videoSenders = new Map<number, VideoSender>();
  private receivers = new Map<number, AudioReceiver>();
  private videoReceivers = new Map<number, VideoReceiver>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  /** Our sender key as of the last update. */
  private mineKid?: number;

  get(id: string): FrameScope | undefined {
    return this.scopes.get(id);
  }

  update(id: string, keys: FrameKeys) {
    let s = this.scopes.get(id);
    if (!s)
      this.scopes.set(
        id,
        (s = { sender: null, receivers: new Map(), video: null, videoReceivers: new Map() }),
      );
    clearTimeout(this.idleTimer);
    if (keys.mine) {
      this.mineKid = keys.mine.kid;
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
    const next = new Map<number, AudioReceiver>();
    const nextVideo = new Map<number, VideoReceiver>();
    for (const p of keys.peers) {
      const kid = p.kid >>> 0;
      const chain = () => importChain({ gen: p.gen, key: p.key });
      // Keep receivers we already have: they may have ratcheted past the given state, and have
      // the counters taken so far. If the key was sent again and is ahead of them, they follow.
      const audio = this.receivers.get(kid) ?? new AudioReceiver(kid, chain());
      const video = this.videoReceivers.get(kid) ?? new VideoReceiver(kid, chain());
      audio.catchUp(chain());
      video.catchUp(chain());
      this.receivers.set(kid, audio);
      this.videoReceivers.set(kid, video);
      next.set(kid, audio);
      nextVideo.set(kid, video);
    }
    s.receivers = next;
    s.videoReceivers = nextVideo;
    // Keys that are gone (replaced, or their sender left) are forgotten.
    for (const kid of this.receivers.keys()) if (!next.has(kid)) this.receivers.delete(kid);
    for (const kid of this.videoReceivers.keys())
      if (!nextVideo.has(kid)) this.videoReceivers.delete(kid);
    this.pruneSenders();
  }

  drop(id: string) {
    this.scopes.delete(id);
    this.pruneSenders();
    clearTimeout(this.idleTimer);
    if (this.scopes.size === 0) {
      this.idleTimer = setTimeout(() => this.forgetAll(), KEEP_IDLE_MS);
      (this.idleTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Senders for keys that have been replaced go; the current key's stay while a reconnect may come. */
  private pruneSenders() {
    const inUse = new Set([...this.scopes.values()].flatMap((s) => [s.sender, s.video]));
    for (const [kid, sender] of this.senders)
      if (!inUse.has(sender) && kid !== this.mineKid) this.senders.delete(kid);
    for (const [kid, sender] of this.videoSenders)
      if (!inUse.has(sender) && kid !== this.mineKid) this.videoSenders.delete(kid);
  }

  private forgetAll() {
    if (this.scopes.size > 0) return;
    this.senders.clear();
    this.videoSenders.clear();
    this.receivers.clear();
    this.videoReceivers.clear();
    this.mineKid = undefined;
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
