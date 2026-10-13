import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtcpRrPacket,
  RtpPacket,
  useAudioLevelIndication,
  useNACK,
  usePLI,
  useTWCC,
  useTransportWideCC,
  type RTCDataChannel,
  type RTCRtpReceiver,
  type RTCRtpTransceiver,
} from 'werift';
import { signSdp, verifySdp, type Identity } from '@crocodile/crypto';
import {
  ClientToRelay,
  RELAY_CHANNEL_LABEL,
  SCREEN_AUDIO_SLOTS,
  VIDEO_SLOTS,
  streamIds,
  type MediaKind,
  type PeerState,
  type RelayToClient,
  type SignalData,
} from '@crocodile/protocol';
import { SlotTable, StreamRewriter } from './slots';
import { ASSUMED_KBPS, RateMeter, VideoLimits, VideoRewriter, allocate, vp8Info } from './video';

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
  /** Observer for each upstream video packet (tests): `last` marks a frame's last packet. */
  onUpstreamVideo?: (stream: string, payload: Uint8Array, last: boolean) => void;
  /** The host's upload for video at the start, in kbps (it adapts from there). */
  videoKbps?: number;
}

/** A camera or screen coming in from its member. */
interface Upstream {
  receiver: RTCRtpReceiver;
  ssrc: number | null;
  meter: RateMeter;
  lastPli: number;
}

/** One of a member's downstream video slots. */
interface VideoSlot {
  t: RTCRtpTransceiver;
  stream: string | null;
  rewriter: VideoRewriter;
  /** Says nothing until the new source's next key frame. */
  waitingKey: boolean;
}

/** One of a member's downstream slots for a shared screen's sound. */
interface ScreenAudioSlot {
  t: RTCRtpTransceiver;
  stream: string | null;
  rewriter: StreamRewriter;
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
  /** Video added to the connection (`renegotiate`). */
  media: boolean;
  up: Partial<Record<MediaKind, Upstream>> & { screenAudio?: Upstream };
  videoSlots: VideoSlot[];
  screenAudioSlots: ScreenAudioSlot[];
  /** Streams asked for, most wanted first. */
  watching: string[];
  paused: string[];
  /** Video bytes sent to this member since the last tick. */
  videoBytes: number;
  renegotiating: Promise<void>;
  renegotiations: number;
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
/** VP8: its frames are encrypted end to end but for the payload header, which the relay reads. */
const VP8 = new RTCRtpCodecParameters({
  mimeType: 'video/VP8',
  clockRate: 90000,
  rtcpFeedback: [useNACK(), usePLI(), useTWCC()],
});
/** Renegotiations a member may ask for on one connection. */
const MAX_RENEGOTIATIONS = 4;
/** Key frame requests to one camera or screen, at most this often. */
const PLI_EVERY_MS = 300;
const TICK_MS = 2000;

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
  private videoTimer: ReturnType<typeof setInterval>;
  private closed = false;
  readonly limits: VideoLimits;

  constructor(readonly opts: HostRelayOptions) {
    this.speakingTimer = setInterval(() => this.updateSpeaking(), 200);
    this.speakingTimer.unref?.();
    this.limits = new VideoLimits(opts.videoKbps);
    this.videoTimer = setInterval(() => this.videoTick(), TICK_MS);
    this.videoTimer.unref?.();
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
      codecs: { audio: [OPUS], video: [VP8] },
      headerExtensions: { audio: [useAudioLevelIndication()], video: [useTransportWideCC()] },
      ...(this.opts.includeLoopback ? { iceAdditionalHostAddresses: ['127.0.0.1'] } : {}),
      ...(this.opts.icePortRange ? { icePortRange: this.opts.icePortRange } : {}),
    });
    routeKeyframeRequestsByMedia(pc);
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
      media: false,
      up: {},
      videoSlots: [],
      screenAudioSlots: [],
      watching: [],
      paused: [],
      videoBytes: 0,
      renegotiating: Promise.resolve(),
      renegotiations: 0,
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
      // Members add video to the connection when they see this.
      ...(this.opts.slots > 0 ? { media: { video: VIDEO_SLOTS, audio: SCREEN_AUDIO_SLOTS } } : {}),
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
        const before = peer.state;
        peer.state = {
          id: peer.id,
          muted: msg.muted,
          deafened: msg.deafened,
          ...(msg.voice !== undefined ? { voice: msg.voice } : {}),
          ...(msg.rtt !== undefined ? { rtt: msg.rtt } : {}),
          ...(msg.camera && peer.media ? { camera: true } : {}),
          ...(msg.screen && peer.media ? { screen: { audio: msg.screen.audio } } : {}),
        };
        if (msg.muted) this.lastLoud.delete(peer.id);
        for (const p of this.peers.values())
          if (p.ready) this.send(p, { t: 'peer_state', peer: peer.state });
        if (
          !!before.camera !== !!peer.state.camera ||
          !!before.screen !== !!peer.state.screen ||
          before.screen?.audio !== peer.state.screen?.audio
        )
          this.reassign();
        return;
      }
      case 'renegotiate':
        peer.renegotiating = peer.renegotiating
          .then(() => this.renegotiate(peer, msg.sdp))
          .catch((err) => {
            this.opts.log?.warn('renegotiation failed', { peer: peer.id, err: String(err) });
          });
        return;
      case 'watch': {
        const asks = [...new Set(msg.streams)].filter((s) => streamIds.peer(s) !== peer.id);
        peer.watching = asks;
        this.reassign();
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Video
  // -------------------------------------------------------------------------

  /**
   * The member added video to its connection: after its microphone and
   * speaker slots come its screen's sound (up) and screen-sound slots (down);
   * its video m-lines are its camera, its screen, then its video slots.
   */
  private async renegotiate(peer: Peer, sdp: string) {
    if (this.peers.get(peer.id) !== peer || this.opts.slots === 0) return;
    if (++peer.renegotiations > MAX_RENEGOTIATIONS) return;
    await peer.pc.setRemoteDescription({ type: 'offer', sdp });
    const audio = peer.pc.getTransceivers().filter((t) => t.kind === 'audio');
    const video = peer.pc.getTransceivers().filter((t) => t.kind === 'video');
    const first = !peer.media;
    const screenAudio = audio[1 + this.opts.slots];
    const audioSlots = audio.slice(2 + this.opts.slots, 2 + this.opts.slots + SCREEN_AUDIO_SLOTS);
    const camera = video[0];
    const screen = video[1];
    const videoSlots = video.slice(2, 2 + VIDEO_SLOTS);
    for (const t of [screenAudio, camera, screen]) t?.setDirection('recvonly');
    for (const t of [...audioSlots, ...videoSlots]) t.setDirection('sendonly');
    for (const t of [
      ...audio.slice(2 + this.opts.slots + SCREEN_AUDIO_SLOTS),
      ...video.slice(2 + VIDEO_SLOTS),
    ])
      t.setDirection('inactive');
    if (first) {
      if (camera) peer.up.camera = this.upstream(peer, camera, 'camera');
      if (screen) peer.up.screen = this.upstream(peer, screen, 'screen');
      if (screenAudio) peer.up.screenAudio = this.upstream(peer, screenAudio, 'screenAudio');
      peer.videoSlots = videoSlots.map((t) => {
        const slot: VideoSlot = {
          t,
          stream: null,
          rewriter: new VideoRewriter(),
          waitingKey: false,
        };
        // The viewer lost the picture: ask its source for a key frame.
        t.sender.onPictureLossIndication.subscribe(() => {
          if (slot.stream) this.requestKeyframe(slot.stream);
        });
        t.sender.onRtcp.subscribe((rtcp) => {
          if (rtcp instanceof RtcpRrPacket)
            for (const r of rtcp.reports) this.limits.report(peer.id, r.fractionLost / 256);
        });
        return slot;
      });
      peer.screenAudioSlots = audioSlots.map((t) => ({
        t,
        stream: null,
        rewriter: new StreamRewriter(),
      }));
    }
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    if (this.peers.get(peer.id) !== peer) return;
    peer.media = videoSlots.length > 0;
    this.send(peer, { t: 'answer', sdp: peer.pc.localDescription!.sdp });
    this.opts.log?.info('video added', { peer: peer.id });
    this.reassign();
  }

  private upstream(peer: Peer, t: RTCRtpTransceiver, kind: MediaKind | 'screenAudio'): Upstream {
    const up: Upstream = { receiver: t.receiver, ssrc: null, meter: new RateMeter(), lastPli: 0 };
    const seen = new Set<unknown>();
    const attach = (track: (typeof t.receiver.tracks)[number]) => {
      if (seen.has(track)) return;
      seen.add(track);
      track.onReceiveRtp.subscribe((rtp) => {
        up.ssrc = rtp.header.ssrc;
        up.meter.add(rtp.payload.length);
        if (kind === 'screenAudio') this.onScreenAudio(peer, rtp);
        else this.onVideo(peer, kind, rtp);
      });
    };
    t.receiver.tracks.forEach(attach);
    t.onTrack.subscribe(attach);
    return up;
  }

  private onVideo(publisher: Peer, kind: MediaKind, rtp: RtpPacket) {
    if (this.peers.get(publisher.id) !== publisher) return;
    const stream = streamIds.make(publisher.id, kind);
    this.opts.onUpstreamVideo?.(stream, rtp.payload, rtp.header.marker);
    const info = vp8Info(rtp.payload);
    const now = Date.now();
    let raw: Buffer | undefined;
    for (const viewer of this.peers.values()) {
      if (viewer === publisher || !viewer.ready || !viewer.media) continue;
      const slot = viewer.videoSlots.find((s) => s.stream === stream);
      if (!slot) continue;
      if (slot.waitingKey) {
        if (!info?.keyframe) {
          this.requestKeyframe(stream);
          continue;
        }
        slot.waitingKey = false;
      }
      raw ??= rtp.serialize();
      // Each viewer gets its own copy: the rewriter changes the payload descriptor.
      const pkt = RtpPacket.deSerialize(Buffer.from(raw));
      const { seq, ts } = slot.rewriter.rewrite(
        stream,
        pkt.header.sequenceNumber,
        pkt.header.timestamp,
        pkt.payload,
        now,
      );
      pkt.header.sequenceNumber = seq;
      pkt.header.timestamp = ts;
      pkt.header.extensions = [];
      viewer.videoBytes += pkt.payload.length;
      void slot.t.sender.sendRtp(pkt).catch(() => {});
    }
  }

  private onScreenAudio(publisher: Peer, rtp: RtpPacket) {
    if (this.peers.get(publisher.id) !== publisher || !publisher.state.screen?.audio) return;
    const stream = streamIds.make(publisher.id, 'screen');
    const now = Date.now();
    let raw: Buffer | undefined;
    for (const viewer of this.peers.values()) {
      if (viewer === publisher || !viewer.ready || viewer.state.deafened) continue;
      const slot = viewer.screenAudioSlots.find((s) => s.stream === stream);
      if (!slot) continue;
      raw ??= rtp.serialize();
      const pkt = RtpPacket.deSerialize(raw);
      const { seq, ts, marker } = slot.rewriter.rewrite(
        stream,
        pkt.header.sequenceNumber,
        pkt.header.timestamp,
        now,
      );
      pkt.header.sequenceNumber = seq;
      pkt.header.timestamp = ts;
      pkt.header.marker = pkt.header.marker || marker;
      pkt.header.extensions = [];
      void slot.t.sender.sendRtp(pkt).catch(() => {});
    }
  }

  private requestKeyframe(stream: string) {
    const publisher = this.peers.get(streamIds.peer(stream));
    const up = publisher?.up[streamIds.kind(stream)];
    if (!up?.ssrc) return;
    const now = Date.now();
    if (now - up.lastPli < PLI_EVERY_MS) return;
    up.lastPli = now;
    void up.receiver.sendRtcpPLI(up.ssrc).catch(() => {});
  }

  /** Whether a stream is being shown now by a member who is here. */
  private live(stream: string) {
    const p = this.peers.get(streamIds.peer(stream));
    if (!p?.ready || !p.media) return false;
    return streamIds.kind(stream) === 'camera' ? !!p.state.camera : !!p.state.screen;
  }

  private kbps(stream: string) {
    const up = this.peers.get(streamIds.peer(stream))?.up[streamIds.kind(stream)];
    return up?.meter.kbps || ASSUMED_KBPS[streamIds.kind(stream)];
  }

  /** Gives every member the streams they asked for that fit, and tells them what changed. */
  private reassign() {
    const viewers = [...this.peers.values()].filter((p) => p.ready && p.media);
    const requests = new Map(viewers.map((v) => [v.id, v.watching.filter((s) => this.live(s))]));
    const current = new Map(
      viewers.map((v) => [
        v.id,
        new Set(v.videoSlots.map((s) => s.stream).filter((s): s is string => !!s)),
      ]),
    );
    const allowed = allocate({
      requests,
      current,
      kbps: (s) => this.kbps(s),
      viewerCap: (v) => this.limits.viewerCap(v),
      hostCap: this.limits.host,
      slots: VIDEO_SLOTS,
    });
    for (const viewer of viewers) {
      const want = allowed.get(viewer.id) ?? [];
      let changed = false;
      for (const slot of viewer.videoSlots) {
        if (slot.stream && !want.includes(slot.stream)) {
          slot.stream = null;
          slot.waitingKey = false;
          // The same stream may come back to this slot later: continue from
          // here then, not across the gap.
          slot.rewriter.reset();
          changed = true;
        }
      }
      for (const stream of want) {
        if (viewer.videoSlots.some((s) => s.stream === stream)) continue;
        const free = viewer.videoSlots.find((s) => !s.stream);
        if (!free) break;
        free.stream = stream;
        free.waitingKey = true;
        changed = true;
        this.requestKeyframe(stream);
      }
      // A watched screen's sound comes with it.
      const sounds = want.filter(
        (s) =>
          streamIds.kind(s) === 'screen' && this.peers.get(streamIds.peer(s))?.state.screen?.audio,
      );
      for (const slot of viewer.screenAudioSlots) {
        if (slot.stream && !sounds.includes(slot.stream)) {
          slot.stream = null;
          slot.rewriter.reset();
          changed = true;
        }
      }
      for (const stream of sounds) {
        if (viewer.screenAudioSlots.some((s) => s.stream === stream)) continue;
        const free = viewer.screenAudioSlots.find((s) => !s.stream);
        if (!free) break;
        free.stream = stream;
        changed = true;
      }
      const paused = (requests.get(viewer.id) ?? []).filter((s) => !want.includes(s));
      if (paused.join() !== viewer.paused.join()) {
        viewer.paused = paused;
        changed = true;
      }
      if (changed)
        this.send(viewer, {
          t: 'media',
          video: viewer.videoSlots.map((s) => s.stream),
          audio: viewer.screenAudioSlots.map((s) => s.stream),
          paused,
        });
    }
  }

  private videoTick() {
    const now = Date.now();
    for (const p of this.peers.values())
      for (const up of Object.values(p.up)) up?.meter.sample(now);
    const usage = new Map<string, number>();
    for (const p of this.peers.values()) {
      if (!p.media) continue;
      usage.set(p.id, Math.round((p.videoBytes * 8) / TICK_MS));
      p.videoBytes = 0;
    }
    this.limits.tick(usage, now);
    // Measured rates replace guesses, and limits move: what fits may change.
    this.reassign();
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
    this.limits.forget(id);
    for (const p of this.peers.values()) {
      if (p.slots.release(id) && p.ready) this.send(p, { t: 'slots', map: [...p.slots.slots] });
      if (peer.ready && p.ready) this.send(p, { t: 'peer_leave', peer: id });
    }
    if (peer.media) this.reassign();
    this.opts.log?.info('peer left relay', { peer: id, reason });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.speakingTimer);
    clearInterval(this.videoTimer);
    for (const id of [...this.peers.keys()]) this.removePeer(id, 'relay closed');
  }
}

/**
 * werift hands a picture loss report (PLI, FIR) to whatever owns its *sender*
 * SSRC first. A member's RTCP sender SSRC is often that of one of its own
 * outgoing streams (its microphone or camera), so in a relay the report
 * would reach that stream's receiver instead of the video slot it is about.
 * Route these by the media SSRC they name.
 */
function routeKeyframeRequestsByMedia(pc: RTCPeerConnection) {
  type Recipient = { handleRtcpPacket(p: unknown): void };
  const router = (
    pc as unknown as {
      router?: { routeRtcp: (p: unknown) => void; ssrcTable: Record<number, Recipient> };
    }
  ).router;
  if (!router) return;
  const route = router.routeRtcp;
  router.routeRtcp = (packet) => {
    const p = packet as { type?: number; feedback?: { count?: number; mediaSsrc?: number } };
    // Payload-specific feedback: 1 is PLI, 4 is FIR.
    if (p.type === 206 && (p.feedback?.count === 1 || p.feedback?.count === 4)) {
      const target = router.ssrcTable[p.feedback.mediaSsrc ?? -1];
      if (target) return target.handleRtcpPacket(packet);
    }
    route(packet);
  };
}

function parseExtId(sdp: string, uri: string): number | undefined {
  const m = sdp.match(
    new RegExp(`a=extmap:(\\d+)(?:/\\w+)? ${uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  return m ? Number(m[1]) : undefined;
}
