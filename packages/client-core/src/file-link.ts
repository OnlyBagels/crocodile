import { FILE_CHANNEL_LABEL } from '@crocodile/protocol';
import { Emitter } from './emitter';

/**
 * A direct connection between two members for one file (files.ts). It is
 * negotiated with sealed messages through the session and offered only STUN
 * servers, never a TURN relay: file bytes go from one member's device to
 * another's or not at all.
 */
export interface FileLinkChannel extends Emitter<{
  message: string | Uint8Array;
  close: void;
  drained: void;
}> {
  send(data: string | Uint8Array): boolean;
  /** Bytes queued and not yet sent. */
  readonly bufferedAmount: number;
  close(): void;
}

export interface FileLink {
  /** Downloader: the offer to send. */
  createOffer(): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  /** Holder: answer an offer. */
  acceptOffer(sdp: string): Promise<string>;
  /** Resolves once the data channel is open; rejects if no direct path is found. */
  readonly ready: Promise<FileLinkChannel>;
  close(): void;
}

export type FileLinkFactory = (opts: {
  /** Our peer id and theirs (fakes use them; WebRTC doesn't need them). */
  self: string;
  remote: string;
  /** STUN servers only. */
  iceServers: { urls: string }[];
}) => FileLink;

/** How long gathering local addresses may take before the offer goes out without the rest. */
const GATHER_TIMEOUT_MS = 3000;
/** How long the two sides get to find a working path. */
const CONNECT_TIMEOUT_MS = 20_000;
/** The channel says it has room again below this many queued bytes. */
const LOW_WATER = 256 * 1024;

/** WebRTC implementation, for any RTCPeerConnection (Chromium, werift). */
export function webrtcFileLinks(Impl: typeof RTCPeerConnection): FileLinkFactory {
  return ({ iceServers }) => new WebRtcFileLink(Impl, iceServers);
}

class WebRtcFileLink implements FileLink {
  private pc: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private closed = false;
  readonly ready: Promise<FileLinkChannel>;
  private resolve!: (c: FileLinkChannel) => void;
  private reject!: (e: Error) => void;
  private timer: ReturnType<typeof setTimeout>;

  constructor(Impl: typeof RTCPeerConnection, iceServers: { urls: string }[]) {
    // Only STUN: a TURN server would carry the file's bytes.
    const stun = iceServers.filter((s) => [s.urls].flat().every((u) => /^stuns?:/.test(u)));
    this.pc = new Impl({ iceServers: stun, bundlePolicy: 'max-bundle' } as RTCConfiguration);
    this.ready = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    // Callers that never wait on it shouldn't see an unhandled rejection.
    this.ready.catch(() => {});
    this.timer = setTimeout(() => this.fail('no direct path'), CONNECT_TIMEOUT_MS);
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.fail('no direct path');
    };
    this.pc.ondatachannel = (ev) => this.adopt(ev.channel);
  }

  private adopt(dc: RTCDataChannel) {
    if (this.dc || dc.label !== FILE_CHANNEL_LABEL) return;
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    const channel = new WebRtcFileChannel(dc, () => this.close());
    dc.onopen = () => {
      clearTimeout(this.timer);
      this.resolve(channel);
    };
    if (dc.readyState === 'open') dc.onopen(new Event('open'));
  }

  private async gathered(): Promise<string> {
    const pc = this.pc;
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((res) => {
        const t = setTimeout(res, GATHER_TIMEOUT_MS);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(t);
            res();
          }
        };
      });
    }
    return pc.localDescription!.sdp;
  }

  async createOffer() {
    this.adopt(this.pc.createDataChannel(FILE_CHANNEL_LABEL, { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.gathered();
  }

  async acceptAnswer(sdp: string) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  async acceptOffer(sdp: string) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return this.gathered();
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.reject(new Error(reason));
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.reject(new Error('closed'));
    try {
      this.dc?.close();
      this.pc.close();
    } catch {
      /* already gone */
    }
  }
}

class WebRtcFileChannel
  extends Emitter<{ message: string | Uint8Array; close: void; drained: void }>
  implements FileLinkChannel
{
  constructor(
    private readonly dc: RTCDataChannel,
    private readonly onClose: () => void,
  ) {
    super();
    dc.onmessage = (ev) =>
      this.emit(
        'message',
        typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer),
      );
    dc.onbufferedamountlow = () => this.emit('drained', undefined);
    dc.onclose = () => {
      this.emit('close', undefined);
      this.onClose();
    };
  }

  get bufferedAmount() {
    return this.dc.bufferedAmount;
  }

  send(data: string | Uint8Array) {
    if (this.dc.readyState !== 'open') return false;
    if (typeof data === 'string') this.dc.send(data);
    else this.dc.send(new Uint8Array(data));
    return true;
  }

  close() {
    this.dc.close();
  }
}
