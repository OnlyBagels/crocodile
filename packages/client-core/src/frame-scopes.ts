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
 * Receivers are shared the same way, one per sender key of someone else, with
 * the counters they have taken: a host that cuts a listener's connection
 * can't have a recorded frame taken again.
 */
export class FrameScopes {
  readonly scopes = new Map<string, FrameScope>();
  private senders = new Map<number, AudioSender>();
  private videoSenders = new Map<number, VideoSender>();
  private receivers = new Map<number, AudioReceiver>();
  private videoReceivers = new Map<number, VideoReceiver>();
  private idleTimer?: ReturnType<typeof setTimeout>;

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
    // Receivers for keys no scope has any more (replaced, or their sender left) are forgotten.
    const used = new Set([...this.scopes.values()].flatMap((sc) => [...sc.receivers.keys()]));
    for (const kid of this.receivers.keys()) if (!used.has(kid)) this.receivers.delete(kid);
    for (const kid of this.videoReceivers.keys())
      if (!used.has(kid)) this.videoReceivers.delete(kid);
  }

  drop(id: string) {
    this.scopes.delete(id);
    // Forget senders no scope uses any more (their keys have been replaced).
    const inUse = new Set([...this.scopes.values()].flatMap((s) => [s.sender, s.video]));
    for (const [kid, sender] of this.senders) if (!inUse.has(sender)) this.senders.delete(kid);
    for (const [kid, sender] of this.videoSenders)
      if (!inUse.has(sender)) this.videoSenders.delete(kid);
    // The receivers wait for a reconnect, but not long.
    clearTimeout(this.idleTimer);
    if (this.scopes.size === 0) {
      this.idleTimer = setTimeout(() => {
        if (this.scopes.size > 0) return;
        this.receivers.clear();
        this.videoReceivers.clear();
      }, KEEP_IDLE_MS);
      (this.idleTimer as { unref?: () => void }).unref?.();
    }
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
