import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpPacket,
  useAudioLevelIndication,
  type RTCDataChannel,
  type RTCRtpTransceiver,
} from 'werift';
import { signSdp, verifySdp, type Identity } from '@crocodile/crypto';
import {
  ClientToRelay,
  RELAY_CHANNEL_LABEL,
  type PeerState,
  type RelayToClient,
  type SignalData,
} from '@crocodile/protocol';
import { SlotTable, StreamRewriter } from './slots';

export interface RelayLogger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
}

export interface HostRelayOptions {
  sessionId: string;
  epoch: number;
  /** The host's identity: answers are signed with it. */
  identity: Identity;
  /** The host's peer id (`<userId>.<deviceId>`). */
  hostPeer: string;
  slots: number;
  iceServers: { urls: string }[];
  /** Deliver a signal to a member through the coordination server. */
  sendSignal: (to: string, data: SignalData) => void;
  /** Extra admission check (e.g. space membership); defaults to allow. */
  /** Admission check by peer id (e.g. space membership of its user). */
  admit?: (peer: string) => boolean;
  /** Expose loopback candidates so the host's own client can connect locally. */
  includeLoopback?: boolean;
  icePortRange?: [number, number];
  log?: RelayLogger;
  /** Observer for each upstream audio payload (metrics and tests). */
  onUpstreamFrame?: (from: string, payload: Uint8Array) => void;
}

interface Peer {
  /** Peer id `<userId>.<deviceId>`. */
  id: string;
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  ready: boolean;
  state: PeerState;
  slotSenders: RTCRtpTransceiver[];
  slots: SlotTable;
  rewriters: StreamRewriter[];
  audioLevelExtId?: number;
  pendingCandidates: Extract<SignalData, { type: 'candidate' }>['candidate'][];
  remoteSet: boolean;
  closeTimer?: ReturnType<typeof setTimeout>;
}

const MAX_DC_MESSAGE = 256 * 1024;
/** RFC 6464 level is -dBov (0 loud .. 127 silent). Below this counts as speech. */
const SPEECH_LEVEL = 70;
const OPUS = new RTCRtpCodecParameters({
  mimeType: 'audio/opus',
  clockRate: 48000,
  channels: 2,
  // Constant bitrate: VBR packet sizes can leak what is being said even
  // through encryption (known attacks on VBR VoIP).
  parameters: 'minptime=10;useinbandfec=1;cbr=1',
});

/**
 * The host relay: a small SFU the elected host runs inside its app.
 *
 * Each member (the host's own client included) opens one peer connection
 * with: one upstream audio m-line (their microphone), `slots` downstream audio
 * m-lines, and a data channel. Audio payloads are end-to-end encrypted by the
 * clients (see crypto/senderkey), so the relay forwards opaque frames: it
 * uses only the unencrypted RFC 6464 audio-level header to pick speakers.
 * Data channel messages are routed by recipient; their payloads are E2E
 * envelopes the relay cannot read.
 */
export class HostRelay {
  private peers = new Map<string, Peer>();
  private lastLoud = new Map<string, number>();
  private speaking = new Set<string>();
  private speakingTimer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(readonly opts: HostRelayOptions) {
    this.speakingTimer = setInterval(() => this.updateSpeaking(), 200);
    this.speakingTimer.unref?.();
  }

  get sessionId() {
    return this.opts.sessionId;
  }

  get epoch() {
    return this.opts.epoch;
  }

  peerIds() {
    return [...this.peers.keys()];
  }

  connectedPeerIds() {
    return [...this.peers.values()].filter((p) => p.ready).map((p) => p.id);
  }

  async handleSignal(from: string, data: SignalData): Promise<void> {
    if (this.closed || data.epoch !== this.opts.epoch) return;
    switch (data.type) {
      case 'offer':
        await this.onOffer(from, data);
        return;
      case 'candidate': {
        if (data.dir !== 'toRelay') return;
        const peer = this.peers.get(from);
        if (!peer) return;
        if (!peer.remoteSet) peer.pendingCandidates.push(data.candidate);
        else await peer.pc.addIceCandidate(data.candidate as never).catch(() => {});
        return;
      }
      case 'bye':
        if (data.dir === 'toRelay') this.removePeer(from, 'bye');
        return;
      case 'answer':
        return;
    }
  }

  private async onOffer(from: string, offer: Extract<SignalData, { type: 'offer' }>) {
    const { sessionId, identity } = this.opts;
    if (!verifySdp(offer, { sessionId, from, to: this.opts.hostPeer })) {
      this.opts.log?.warn('rejected offer with bad signature', { from });
      return;
    }
    if (this.opts.admit && !this.opts.admit(from)) {
      this.opts.log?.warn('rejected offer from non-member', { from });
      return;
    }
    // A new offer from the same member replaces its previous connection.
    this.removePeer(from, 'renegotiate');

    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers,
      codecs: { audio: [OPUS] },
      headerExtensions: { audio: [useAudioLevelIndication()] },
      ...(this.opts.includeLoopback ? { iceAdditionalHostAddresses: ['127.0.0.1'] } : {}),
      ...(this.opts.icePortRange ? { icePortRange: this.opts.icePortRange } : {}),
    });
    const peer: Peer = {
      id: from,
      pc,
      ready: false,
      state: { id: from, muted: false, deafened: false },
      slotSenders: [],
      slots: new SlotTable(this.opts.slots),
      rewriters: Array.from({ length: this.opts.slots }, () => new StreamRewriter()),
      pendingCandidates: [],
      remoteSet: false,
    };
    this.peers.set(from, peer);
    peer.audioLevelExtId = parseExtId(offer.sdp, 'urn:ietf:params:rtp-hdrext:ssrc-audio-level');

    pc.onIceCandidate.subscribe((c) => {
      if (!c || !c.candidate) return;
      this.opts.sendSignal(from, {
        type: 'candidate',
        epoch: this.opts.epoch,
        dir: 'toClient',
        candidate: {
          candidate: c.candidate,
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
        },
      });
    });
    // This connection's events only ever end this connection: once a newer
    // offer from the same member replaced it, they must leave that one alone.
    const end = (reason: string) => {
      if (this.peers.get(from) === peer) this.removePeer(from, reason);
    };
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed') end(state);
      else if (state === 'disconnected') {
        peer.closeTimer = setTimeout(() => end('disconnected'), 8000);
      } else if (state === 'connected' && peer.closeTimer) {
        clearTimeout(peer.closeTimer);
        peer.closeTimer = undefined;
      }
    });
    pc.onDataChannel.subscribe((dc) => {
      if (dc.label !== RELAY_CHANNEL_LABEL) return;
      peer.dc = dc;
      const onOpen = () => this.onPeerReady(peer);
      if (dc.readyState === 'open') onOpen();
      dc.stateChanged.subscribe((s) => {
        if (s === 'open') onOpen();
        // A closed control channel means the member hung up.
        else if (s === 'closed') end('channel closed');
      });
      dc.onMessage.subscribe((raw) => this.onDataMessage(peer, raw));
    });

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      peer.remoteSet = true;
      const audio = pc.getTransceivers().filter((t) => t.kind === 'audio');
      const upstream = audio[0];
      peer.slotSenders = audio.slice(1, 1 + this.opts.slots);
      if (upstream) {
        upstream.setDirection('recvonly');
        // The track may already exist (created during setRemoteDescription).
        const seen = new Set<unknown>();
        const attach = (track: (typeof upstream.receiver.tracks)[number]) => {
          if (seen.has(track)) return;
          seen.add(track);
          track.onReceiveRtp.subscribe((rtp) => this.onUpstreamRtp(peer, rtp));
        };
        upstream.receiver.tracks.forEach(attach);
        upstream.onTrack.subscribe(attach);
      }
      for (const t of peer.slotSenders) t.setDirection('sendonly');
      for (const t of audio.slice(1 + this.opts.slots)) t.setDirection('inactive');
      const answer = await pc.createAnswer();
      // Send the answer before gathering finishes; candidates trickle after it.
      // (Gathering can stall for seconds when a STUN server is unreachable.)
      this.opts.sendSignal(
        from,
        signSdp(
          identity,
          'answer',
          { sessionId, epoch: this.opts.epoch, from: this.opts.hostPeer, to: from },
          answer.sdp,
        ),
      );
      await pc.setLocalDescription(answer);
      for (const c of peer.pendingCandidates.splice(0))
        await pc.addIceCandidate(c as never).catch(() => {});
    } catch (err) {
      this.opts.log?.warn('failed to answer offer', { from, err: String(err) });
      end('error');
    }
  }

  private onPeerReady(peer: Peer) {
    if (peer.ready || this.peers.get(peer.id) !== peer) return;
    peer.ready = true;
    const others = [...this.peers.values()].filter((p) => p.ready && p !== peer);
    this.send(peer, {
      t: 'hello',
      you: peer.id,
      host: this.opts.hostPeer,
      peers: others.map((p) => p.state),
      slots: this.opts.slots,
    });
    for (const o of others) this.send(o, { t: 'peer_join', peer: peer.state });
    this.opts.log?.info('peer joined relay', { peer: peer.id, peers: others.length + 1 });
  }

  private onDataMessage(peer: Peer, raw: string | Buffer) {
    if (raw.length > MAX_DC_MESSAGE) return;
    let parsed;
    try {
      parsed = ClientToRelay.safeParse(JSON.parse(raw.toString()));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.t) {
      case 'bcast': {
        const out: RelayToClient = { t: 'msg', from: peer.id, direct: false, d: msg.d };
        const text = JSON.stringify(out);
        for (const p of this.peers.values()) if (p !== peer && p.ready) this.sendRaw(p, text);
        return;
      }
      case 'direct': {
        const target = this.peers.get(msg.to);
        if (target?.ready) this.send(target, { t: 'msg', from: peer.id, direct: true, d: msg.d });
        return;
      }
      case 'ping':
        this.send(peer, { t: 'pong', ts: msg.ts });
        return;
      case 'state': {
        peer.state = {
          id: peer.id,
          muted: msg.muted,
          deafened: msg.deafened,
          ...(msg.voice !== undefined ? { voice: msg.voice } : {}),
          ...(msg.rtt !== undefined ? { rtt: msg.rtt } : {}),
        };
        if (msg.muted) this.lastLoud.delete(peer.id);
        for (const p of this.peers.values())
          if (p.ready) this.send(p, { t: 'peer_state', peer: peer.state });
        return;
      }
    }
  }

  private onUpstreamRtp(speaker: Peer, rtp: RtpPacket) {
    if (speaker.state.muted) return;
    this.opts.onUpstreamFrame?.(speaker.id, rtp.payload);
    const now = Date.now();
    let level = 127;
    if (speaker.audioLevelExtId !== undefined) {
      const ext = rtp.header.extensions.find((e) => e.id === speaker.audioLevelExtId);
      if (ext && ext.payload.length > 0) level = ext.payload[0]! & 0x7f;
    } else if (rtp.payload.length > 40) {
      level = 0;
    }
    const loud = level < SPEECH_LEVEL;
    if (loud) this.lastLoud.set(speaker.id, now);
    const lastLoud = (id: string) => this.lastLoud.get(id) ?? 0;
    const recentlyLoud = now - lastLoud(speaker.id) < 1200;

    let raw: Buffer | undefined;
    for (const listener of this.peers.values()) {
      if (listener === speaker || !listener.ready || listener.state.deafened) continue;
      let slot = listener.slots.indexOf(speaker.id);
      if (slot < 0) {
        if (!recentlyLoud) continue;
        slot = listener.slots.assign(speaker.id, now, lastLoud);
        if (slot < 0) continue;
        this.send(listener, { t: 'slots', map: [...listener.slots.slots] });
      }
      const sender = listener.slotSenders[slot];
      if (!sender) continue;
      raw ??= rtp.serialize();
      const pkt = RtpPacket.deSerialize(raw);
      const { seq, ts, marker } = listener.rewriters[slot]!.rewrite(
        speaker.id,
        pkt.header.sequenceNumber,
        pkt.header.timestamp,
        now,
      );
      pkt.header.sequenceNumber = seq;
      pkt.header.timestamp = ts;
      pkt.header.marker = pkt.header.marker || marker;
      pkt.header.extensions = [];
      void sender.sender.sendRtp(pkt).catch(() => {});
    }
  }

  private updateSpeaking() {
    const now = Date.now();
    const current = new Set<string>();
    for (const [id, t] of this.lastLoud) {
      if (now - t < 400) current.add(id);
      else if (now - t > 60_000) this.lastLoud.delete(id);
    }
    const same =
      current.size === this.speaking.size && [...current].every((id) => this.speaking.has(id));
    if (same) return;
    this.speaking = current;
    const msg: RelayToClient = { t: 'speaking', users: [...current] };
    const text = JSON.stringify(msg);
    for (const p of this.peers.values()) if (p.ready) this.sendRaw(p, text);
  }

  private send(peer: Peer, msg: RelayToClient) {
    this.sendRaw(peer, JSON.stringify(msg));
  }

  private sendRaw(peer: Peer, text: string) {
    try {
      if (peer.dc?.readyState === 'open') peer.dc.send(text);
    } catch {
      /* peer is going away */
    }
  }

  removePeer(id: string, reason: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (peer.closeTimer) clearTimeout(peer.closeTimer);
    void peer.pc.close().catch(() => {});
    this.lastLoud.delete(id);
    for (const p of this.peers.values()) {
      if (p.slots.release(id) && p.ready) this.send(p, { t: 'slots', map: [...p.slots.slots] });
      if (peer.ready && p.ready) this.send(p, { t: 'peer_leave', peer: id });
    }
    this.opts.log?.info('peer left relay', { peer: id, reason });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.speakingTimer);
    for (const id of [...this.peers.keys()]) this.removePeer(id, 'relay closed');
  }
}

function parseExtId(sdp: string, uri: string): number | undefined {
  const m = sdp.match(
    new RegExp(`a=extmap:(\\d+)(?:/\\w+)? ${uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  return m ? Number(m[1]) : undefined;
}
