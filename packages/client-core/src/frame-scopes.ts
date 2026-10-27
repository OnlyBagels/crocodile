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
 * Receivers are shared, one per sender key of someone else, with the
 * counters they have taken: a host that cuts a listener's connection
 * can't have a recorded frame taken again.
 */
export class FrameScopes {
  readonly scopes = new Map<string, FrameScope>();
  private senders = new Map<number, AudioSender>();
  private videoSenders = new Map<number, VideoSender>();
  private receivers = new Map<number, AudioReceiver>();
  private videoReceivers = new Map<number, VideoReceiver>();
  /** When a receiver's key was last in a connection's key list. */
  private lastUsed = new Map<number, number>();
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
        (s = { sender: null, receivers: new Map(), video: null, videoReceivers: new Map() }),
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
    const next = new Map<number, AudioReceiver>();
    const nextVideo = new Map<number, VideoReceiver>();
    for (const p of keys.peers) {
      const kid = p.kid >>> 0;
      const chain = () => importChain({ gen: p.gen, key: p.key });
      // Keep receivers we already have: they may have ratcheted past the given state, and have
      // the counters taken so far. If the key was sent again and is ahead of them, they follow.
      let audio = this.receivers.get(kid);
      if (!audio) this.receivers.set(kid, (audio = new AudioReceiver(kid, chain())));
      else if (p.gen > audio.gen) audio.catchUp(chain());
      let video = this.videoReceivers.get(kid);
      if (!video) this.videoReceivers.set(kid, (video = new VideoReceiver(kid, chain())));
      else if (p.gen > video.gen) video.catchUp(chain());
      next.set(kid, audio);
      nextVideo.set(kid, video);
    }
    s.receivers = next;
    s.videoReceivers = nextVideo;
    this.prune();
  }

  /**
   * Receivers are forgotten once their key has been out of every connection's list for a while:
   * replaced keys, and a call that was left.
   */
  private prune() {
    const now = Date.now();
    const used = new Set([...this.scopes.values()].flatMap((sc) => [...sc.receivers.keys()]));
    for (const kid of used) this.lastUsed.set(kid, now);
    for (const [kid, at] of this.lastUsed) {
      if (used.has(kid) || now - at <= KEEP_IDLE_MS) continue;
      this.lastUsed.delete(kid);
      this.receivers.delete(kid);
      this.videoReceivers.delete(kid);
    }
  }

  drop(id: string) {
    this.scopes.delete(id);
    // Forget senders no scope uses any more (their keys have been replaced).
    const inUse = new Set([...this.scopes.values()].flatMap((s) => [s.sender, s.video]));
    for (const [kid, sender] of this.senders) if (!inUse.has(sender)) this.senders.delete(kid);
    for (const [kid, sender] of this.videoSenders)
      if (!inUse.has(sender)) this.videoSenders.delete(kid);
    // The receivers wait for a reconnect, but not long.
    this.prune();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.prune(), KEEP_IDLE_MS + 1000);
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
