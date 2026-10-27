import {
  AudioReceiver,
  AudioSender,
  VideoReceiver,
  VideoSender,
  importChain,
} from '@crocodile/crypto';
import type { FrameKeys } from './keyring';

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
 */
export class FrameScopes {
  readonly scopes = new Map<string, FrameScope>();
  private senders = new Map<number, AudioSender>();
  private videoSenders = new Map<number, VideoSender>();
  /** Our sender key as of the last update: its senders outlive the connections using them. */
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
      // Keep receivers we already have: they may have ratcheted past the given state.
      next.set(kid, s.receivers.get(kid) ?? new AudioReceiver(kid, chain()));
      nextVideo.set(kid, s.videoReceivers.get(kid) ?? new VideoReceiver(kid, chain()));
    }
    s.receivers = next;
    s.videoReceivers = nextVideo;
  }

  drop(id: string) {
    this.scopes.delete(id);
    // Forget senders for keys that have been replaced. The current key's stay even with no
    // connection: a new one must continue their counters, as listeners that stayed refuse
    // counters they have already passed.
    const inUse = new Set([...this.scopes.values()].flatMap((s) => [s.sender, s.video]));
    for (const [kid, sender] of this.senders)
      if (!inUse.has(sender) && kid !== this.mineKid) this.senders.delete(kid);
    for (const [kid, sender] of this.videoSenders)
      if (!inUse.has(sender) && kid !== this.mineKid) this.videoSenders.delete(kid);
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
