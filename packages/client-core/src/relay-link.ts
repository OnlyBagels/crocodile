import { signSdp, verifySdp, type Identity } from '@crocodile/crypto';
import {
  RELAY_CHANNEL_LABEL,
  type ClientToRelay,
  type RelayToClient,
  type SignalData,
} from '@crocodile/protocol';
import { Emitter } from './emitter';

export interface FrameCryptoHooks {
  /** Install end-to-end encryption on the microphone sender. */
  protectSender(sender: RTCRtpSender): void;
  /** Install decryption on a slot receiver. */
  protectReceiver(receiver: RTCRtpReceiver): void;
  /** Extra RTCPeerConnection config needed by the hooks (legacy insertable streams). */
  rtcConfig?: Record<string, unknown>;
}

export interface RelayLinkOptions {
  RTCPeerConnection: typeof RTCPeerConnection;
  identity: Identity;
  /** Our peer id (`<userId>.<deviceId>`). */
  self: string;
  sessionId: string;
  epoch: number;
  /** Host peer id. */
  host: string;
  iceServers: RTCIceServer[];
  /** Set when using the opt-in server relay as a fallback. */
  iceTransportPolicy?: RTCIceTransportPolicy;
  slots: number;
  micTrack?: MediaStreamTrack | null;
  crypto?: FrameCryptoHooks;
  sendSignal: (data: SignalData) => Promise<unknown>;
  connectTimeoutMs?: number;
  /** How long "disconnected" may last before the connection counts as lost (tests). */
  disconnectedGraceMs?: number;
}

/**
 * How far a connection to the host got: we sent our offer through the
 * coordination server (`offer`), the host answered (`answer`), ICE found a
 * working network path (`path`) and the encrypted channel opened (`open`).
 */
export type ConnectStep = 'offer' | 'answer' | 'path' | 'open';

/**
 * Where a connection failed: the host never answered (`no-answer`), no
 * network path worked (`no-path`), a path worked but the channel didn't
 * open (`no-channel`), it worked and was then lost (`lost`), the host closed
 * it (`host-left`), or the host's answer didn't check out (`rejected`).
 */
export type FailStage = 'no-answer' | 'no-path' | 'no-channel' | 'lost' | 'host-left' | 'rejected';

export type RelayLinkEvents = {
  open: void;
  message: RelayToClient;
  /** A slot's remote audio track is available. */
  track: { slot: number; track: MediaStreamTrack; receiver: RTCRtpReceiver };
  /** The connection got one step further. */
  progress: { step: ConnectStep };
  failed: { reason: string; stage?: FailStage };
  closed: void;
};

/** What WebRTC says about a live connection, for the debug panel. */
export interface LinkStats {
  route: ConnectionRoute | null;
  /** Candidate types of the pair in use: host, srflx, prflx or relay. */
  local: { type: string; protocol: string; address: string } | null;
  remote: { type: string; protocol: string; address: string } | null;
  rttMs: number | null;
  bytesSent: number;
  bytesReceived: number;
  /** Incoming audio, summed over the slots. */
  audio: { packetsReceived: number; packetsLost: number; jitterMs: number | null } | null;
}

/** LinkStats from `getStats()`. */
export function linkStatsFrom(stats: RTCStatsReport): LinkStats {
  const all = [...(stats as unknown as Map<string, Record<string, unknown>>).values()];
  const byId = new Map(all.map((s) => [s.id as string, s]));
  const transport = all.find((s) => s.type === 'transport');
  const selectedId = transport?.selectedCandidatePairId as string | undefined;
  const pair =
    (selectedId && byId.get(selectedId)) ||
    all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
  const candidate = (id: unknown) => {
    const c = byId.get(id as string);
    return c
      ? {
          type: String(c.candidateType ?? ''),
          protocol: String(c.protocol ?? ''),
          address: String(c.address ?? c.ip ?? ''),
        }
      : null;
  };
  const inbound = all.filter((s) => s.type === 'inbound-rtp' && s.kind === 'audio');
  const jitters = inbound.map((s) => Number(s.jitter)).filter((j) => Number.isFinite(j));
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    route: routeFromStats(stats),
    local: pair ? candidate(pair.localCandidateId) : null,
    remote: pair ? candidate(pair.remoteCandidateId) : null,
    rttMs:
      pair && Number.isFinite(Number(pair.currentRoundTripTime))
        ? Math.round(Number(pair.currentRoundTripTime) * 1000)
        : null,
    bytesSent: num(transport?.bytesSent ?? pair?.bytesSent),
    bytesReceived: num(transport?.bytesReceived ?? pair?.bytesReceived),
    audio: inbound.length
      ? {
          packetsReceived: inbound.reduce((n, s) => n + num(s.packetsReceived), 0),
          packetsLost: inbound.reduce((n, s) => n + num(s.packetsLost), 0),
          jitterMs: jitters.length ? Math.round(Math.max(...jitters) * 1000) : null,
        }
      : null,
  };
}

/**
 * How long a connection may stay "disconnected" before it counts as lost.
 * The host's relay gives up on a member after the same time, so waiting for
 * WebRTC's own "failed" (about 30 s) would only delay the reconnect.
 */
export const DISCONNECTED_GRACE_MS = 8000;

/**
 * How a connection's packets travel: `local` on this computer, `lan` on the
 * same network, `internet` directly across networks, `relay` through a
 * coordination server's relay.
 */
export type ConnectionRoute = 'local' | 'lan' | 'internet' | 'relay';

/** The route of the candidate pair ICE selected, from `getStats()`. */
export function routeFromStats(stats: RTCStatsReport): ConnectionRoute | null {
  const all = [...(stats as unknown as Map<string, Record<string, unknown>>).values()];
  const byId = new Map(all.map((s) => [s.id as string, s]));
  const selectedId = all.find((s) => s.type === 'transport' && s.selectedCandidatePairId)
    ?.selectedCandidatePairId as string | undefined;
  const pair =
    (selectedId && byId.get(selectedId)) ||
    all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
  if (!pair) return null;
  const local = byId.get(pair.localCandidateId as string);
  const remote = byId.get(pair.remoteCandidateId as string);
  if (!local || !remote) return null;
  if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'relay';
  // By the other end's address rather than candidate types: a pair found
  // during checks is "peer-reflexive" even between two local addresses.
  const ip = String(remote.address ?? remote.ip ?? '').toLowerCase();
  const own = String(local.address ?? local.ip ?? '').toLowerCase();
  // Browsers hide some addresses (peer-reflexive ones): not known yet.
  if (!ip) return null;
  if (ip.startsWith('127.') || ip === '::1') return 'local';
  // The same address at both ends: the same device, or behind the same router.
  if (ip && ip === own) return local.candidateType === 'host' ? 'local' : 'lan';
  return isLocalAddress(ip) ? 'lan' : 'internet';
}

/** Private, link-local and mDNS (.local) addresses: only reachable on the same network. */
function isLocalAddress(ip: string): boolean {
  if (ip.endsWith('.local')) return true;
  const v4 = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return /^(fc|fd|fe[89ab])/.test(ip);
}

/**
 * The member side of a connection to the host relay: one RTCPeerConnection
 * with the microphone upstream, `slots` downstream audio tracks and the
 * control/data channel. Trickle ICE both ways; SDP is identity-signed.
 */
export class RelayLink extends Emitter<RelayLinkEvents> {
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  private micSender?: RTCRtpSender;
  private remoteSet = false;
  private early: RTCIceCandidateInit[] = [];
  private closed = false;
  private opened = false;
  private answered = false;
  private pathFound = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lostTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: RelayLinkOptions) {
    super();
    this.pc = new opts.RTCPeerConnection({
      iceServers: opts.iceServers,
      iceTransportPolicy: opts.iceTransportPolicy ?? 'all',
      bundlePolicy: 'max-bundle',
      ...(opts.crypto?.rtcConfig ?? {}),
    } as RTCConfiguration);
    this.dc = this.pc.createDataChannel(RELAY_CHANNEL_LABEL, { ordered: true });
    this.dc.onopen = () => {
      this.opened = true;
      clearTimeout(this.timer);
      this.emit('progress', { step: 'open' });
      this.emit('open', undefined);
    };
    this.dc.onclose = () => this.fail('control channel closed');
    this.dc.onmessage = (ev) => {
      try {
        this.emit('message', JSON.parse(String(ev.data)) as RelayToClient);
      } catch {
        /* ignore malformed */
      }
    };
    this.pc.onicecandidate = (ev) => {
      if (!ev.candidate || !ev.candidate.candidate) return;
      void opts
        .sendSignal({
          type: 'candidate',
          epoch: opts.epoch,
          dir: 'toRelay',
          candidate: {
            candidate: ev.candidate.candidate,
            sdpMid: ev.candidate.sdpMid ?? null,
            sdpMLineIndex: ev.candidate.sdpMLineIndex ?? null,
          },
        })
        .catch(() => {});
    };
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      if ((s === 'connected' || s === 'completed') && !this.pathFound) {
        this.pathFound = true;
        this.emit('progress', { step: 'path' });
      }
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this.fail('connection failed');
      else if (s === 'disconnected') {
        this.lostTimer ??= setTimeout(
          () => this.fail('no answer from the host for a few seconds', 'lost'),
          opts.disconnectedGraceMs ?? DISCONNECTED_GRACE_MS,
        );
      } else if (s === 'connected') {
        clearTimeout(this.lostTimer);
        this.lostTimer = undefined;
      }
    };
    this.pc.ontrack = (ev) => {
      const transceivers = this.pc.getTransceivers();
      const index = transceivers.indexOf(ev.transceiver);
      // Transceiver 0 is our microphone; slots follow.
      if (index >= 1)
        this.emit('track', { slot: index - 1, track: ev.track, receiver: ev.receiver });
    };
  }

  /** How this connection travels, once it is up. */
  async route(): Promise<ConnectionRoute | null> {
    if (this.closed) return null;
    return routeFromStats(await this.pc.getStats());
  }

  /** Live numbers about the connection (debug panel). */
  async stats(): Promise<LinkStats | null> {
    if (this.closed) return null;
    return linkStatsFrom(await this.pc.getStats());
  }

  async connect() {
    const { opts } = this;
    if (opts.slots > 0) {
      const mic = this.pc.addTransceiver(opts.micTrack ?? 'audio', { direction: 'sendonly' });
      this.micSender = mic.sender;
      opts.crypto?.protectSender(mic.sender);
      for (let i = 0; i < opts.slots; i++) {
        const t = this.pc.addTransceiver('audio', { direction: 'recvonly' });
        opts.crypto?.protectReceiver(t.receiver);
      }
    }
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.timer = setTimeout(
      () => this.fail('timed out connecting to host'),
      opts.connectTimeoutMs ?? 15_000,
    );
    await opts.sendSignal(
      signSdp(
        opts.identity,
        'offer',
        { sessionId: opts.sessionId, epoch: opts.epoch, from: opts.self, to: opts.host },
        this.pc.localDescription!.sdp,
      ),
    );
    if (!this.closed) this.emit('progress', { step: 'offer' });
  }

  async handleSignal(data: SignalData) {
    if (this.closed || data.epoch !== this.opts.epoch) return;
    if (data.type === 'answer') {
      if (
        !verifySdp(data, {
          sessionId: this.opts.sessionId,
          from: this.opts.host,
          to: this.opts.self,
        })
      ) {
        this.fail('host answer failed signature check', 'rejected');
        return;
      }
      await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      this.remoteSet = true;
      if (!this.answered) {
        this.answered = true;
        this.emit('progress', { step: 'answer' });
      }
      for (const c of this.early.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
    } else if (data.type === 'candidate' && data.dir === 'toClient') {
      const c: RTCIceCandidateInit = {
        candidate: data.candidate.candidate,
        sdpMid: data.candidate.sdpMid ?? undefined,
        sdpMLineIndex: data.candidate.sdpMLineIndex ?? undefined,
      };
      if (!this.remoteSet) this.early.push(c);
      else await this.pc.addIceCandidate(c).catch(() => {});
    } else if (data.type === 'bye' && data.dir === 'toClient') {
      this.fail('host closed the relay', 'host-left');
    }
  }

  get isOpen() {
    return this.opened && !this.closed && this.dc.readyState === 'open';
  }

  send(msg: ClientToRelay): boolean {
    if (!this.isOpen) return false;
    this.dc.send(JSON.stringify(msg));
    return true;
  }

  async setMicTrack(track: MediaStreamTrack | null) {
    await this.micSender?.replaceTrack(track);
  }

  private fail(reason: string, stage?: FailStage) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.lostTimer);
    this.pc.close();
    this.emit('failed', { reason, stage: stage ?? this.stage() });
  }

  /** Where a connection that fails now got stuck. */
  private stage(): FailStage {
    if (this.opened) return 'lost';
    if (this.pathFound) return 'no-channel';
    return this.answered ? 'no-path' : 'no-answer';
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.lostTimer);
    void this.opts
      .sendSignal({ type: 'bye', epoch: this.opts.epoch, dir: 'toRelay' })
      .catch(() => {});
    try {
      this.dc.close();
    } catch {
      /* ignore */
    }
    this.pc.close();
    this.emit('closed', undefined);
  }
}
