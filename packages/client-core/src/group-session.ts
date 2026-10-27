import { type Identity } from '@crocodile/crypto';
import {
  E2EEnvelope,
  GroupPayload,
  SealedPayload,
  messageSession,
  peerIds,
  streamIds,
  utf8,
  type ChatMessage,
  type HostCaps,
  type PeerState,
  type RelayGrant,
  type RelayToClient,
  type SealedBox,
  type SessionState,
  type SignalData,
} from '@crocodile/protocol';
import type { CoordinatorLink } from './coordinator-link';
import { Emitter } from './emitter';
import { GroupKeyring } from './keyring';
import { messageKey } from './message-key';
import type { MessageStore, PlatformAdapter, RelayHandle } from './platform';
import {
  RelayLink,
  VIDEO_BITRATE,
  type ConnectStep,
  type ConnectionRoute,
  type FailStage,
  type FrameCryptoHooks,
  type LinkStats,
  type OutgoingMedia,
  type RelayLinkEvents,
  type RelayLinkOptions,
} from './relay-link';
import type { OutgoingVideo } from './voice';

/** What a GroupSession needs from the client around it. */
export interface SessionContext {
  identity: Identity;
  /** This device's peer id. */
  peer: string;
  /** The client's current link: it is replaced when the client changes server. */
  link(): CoordinatorLink;
  platform: PlatformAdapter;
  messages: MessageStore;
  iceServers(): { urls: string }[];
  caps(): Promise<HostCaps>;
  /** Seal a payload to one device (hybrid PQ box); null if we lack its prekey. */
  seal(toPeer: string, plaintext: Uint8Array): Promise<SealedBox | null>;
  /** Open a box addressed to this device. */
  open(box: SealedBox): { from: string; plaintext: Uint8Array } | null;
  /** Whether a peer may take part in the session (membership, blocks, revocation). */
  isAllowedPeer(sessionId: string, peer: string): boolean;
  /** Fetch the records needed to judge a peer we know nothing about yet. */
  refreshPeer(sessionId: string, peer: string): Promise<void>;
  /** Channels whose history belongs to the session. */
  historyChannels(sessionId: string): string[];
  /** Verify and store a chat message; resolves true if it was new. */
  /** `history`: it came in a history reply, not live. */
  acceptMessage(sessionId: string, message: ChatMessage, history?: boolean): Promise<boolean>;
  /** Whether `acceptMessage` would take it (a repeat is still taken). */
  admits(sessionId: string, message: ChatMessage, history?: boolean): boolean;
  /** This device's unacknowledged messages. */
  outbox: {
    pending(sessionId: string): ChatMessage[];
    /** Another user confirmed these ids. */
    acked(ids: string[]): void;
  };
  /**
   * Timestamp to sync a channel from: the newest message we did not write
   * offline ourselves (our own unacknowledged messages can be newer than
   * messages others wrote meanwhile).
   */
  syncCursor(channel: string): Promise<number>;
  /** Opt-in server relay (TURN) when no direct path works. */
  relay: {
    allowed(): boolean;
    request(sessionId: string): Promise<RelayGrant>;
  };
  log(msg: string, extra?: Record<string, unknown>): void;
}

export interface VoiceHooks {
  micTrack(): MediaStreamTrack | null;
  frameCrypto(keyring: GroupKeyring): FrameCryptoHooks | undefined;
  /** The camera and shared screen to send (none on devices without video). */
  outgoing?(): OutgoingVideo;
}

/** Why video can't be used in a call right now. */
export type VideoBlock =
  /** Our connection goes through a coordination server's relay: voice only. */
  | 'relayed'
  /** The host's app is too old to carry video. */
  | 'old-host';

/** Transport to the host relay; RelayLink in real clients, fakes in tests. */
export interface RelayTransport extends Emitter<RelayLinkEvents> {
  connect(): Promise<void>;
  handleSignal(data: SignalData): Promise<void>;
  send(msg: Parameters<RelayLink['send']>[0]): boolean;
  close(): void;
  readonly isOpen: boolean;
  setMicTrack?(track: MediaStreamTrack | null): Promise<void>;
  /** Add video to the connection (the host said it carries it). */
  addMedia?(slots: { video: number; audio: number }): Promise<void>;
  /** Send a camera, screen or screen's sound (null stops it). */
  setOutgoing?(
    kind: OutgoingMedia,
    track: MediaStreamTrack | null,
    opts?: { bitrate?: number; hint?: 'text' | 'motion' },
  ): Promise<void>;
  /** How the connection travels once it is up. */
  route?(): Promise<ConnectionRoute | null>;
  /** Frames decoded so far on a video slot (null if it can't tell). */
  videoFrames?(slot: number): Promise<number | null>;
  /** Live WebRTC numbers (debug panel). */
  stats?(): Promise<LinkStats | null>;
}

/** One try at connecting to the host, for showing where connections fail. */
export interface ConnectAttempt {
  startedAt: number;
  /** Host peer id. */
  host: string;
  /** The server relay was offered to ICE for this try. */
  viaRelay: boolean;
  steps: { step: ConnectStep; at: number }[];
  /**
   * How it ended: `ok` once it connected (and replaced by a `lost` failure
   * if it later drops); absent while still trying.
   */
  end?: { at: number; ok: false; stage: FailStage; reason: string } | { at: number; ok: true };
}

/** Attempts kept per session. */
const ATTEMPTS_KEPT = 8;
/** How often a call measures its round trip to the host. */
const PING_INTERVAL_MS = 3000;
/** How often a call checks how its connection travels (direct or server relay). */
const ROUTE_CHECK_MS = 5000;
/** Longest a stream new in a video slot waits for its first frame before showing. */
const FIRST_PICTURE_WAIT_MS = 3000;
/** Renew a relay grant this long before it ends (the server extends grants in their last 10 minutes). */
const RELAY_RENEW_BEFORE_MS = 5 * 60_000;
/** How soon a failed renewal is tried again. */
const RELAY_RENEW_RETRY_MS = 30_000;

export type TransportFactory = (
  opts: Omit<RelayLinkOptions, 'RTCPeerConnection'>,
) => RelayTransport;

export type RelayStatus =
  'idle' | 'joining' | 'connecting' | 'connected' | 'reconnecting' | 'no-host' | 'left';

export type GroupSessionEvents = {
  update: void;
  track: { slot: number; track: MediaStreamTrack; receiver: RTCRtpReceiver };
  /** A screen-sound slot's track: whoever's screen it carries is in `screenAudioSlots`. */
  screenAudio: { slot: number; track: MediaStreamTrack };
  typing: { userId: string; ch: string };
  call: { userId: string; action: 'ring' | 'accept' | 'decline' | 'end'; video?: boolean };
  error: { message: string };
  /** File transfer messages from a peer allowed in the session (files.ts). */
  file: {
    from: string;
    payload:
      | Extract<SealedPayload, { type: 'file_have' | 'file_link' }>
      | Extract<GroupPayload, { type: 'file_want' }>;
  };
};

/**
 * Plaintext bytes of history in one reply. Sealed and base64-encoded it grows
 * by about half, and must stay under the 64 KiB a data channel message may
 * be (werift's limit, which host relays use).
 */
const HISTORY_CHUNK_BYTES = 32 * 1024;
const PENDING_TTL_MS = 15_000;

/**
 * One live P2P session (a space's text mesh, a voice channel or a DM).
 *
 * Follows the coordinator's session state: hosts the relay when elected,
 * connects to whoever hosts otherwise, reconnects on failover and, if the
 * user opted in, falls back to a coordination server's relay when no direct
 * path to the host exists. On top runs the end-to-end layer: ratcheting
 * sender keys sealed per device with hybrid post-quantum boxes, group-
 * encrypted chat, and history sync between peers.
 */
export class GroupSession extends Emitter<GroupSessionEvents> {
  state: SessionState | null = null;
  status: RelayStatus = 'idle';
  /** Peers connected to the relay, by peer id. */
  peers = new Map<string, PeerState>();
  /** The host said hello on the current connection: `peers` is complete. */
  welcomed = false;
  /** Speaking peers (peer ids). */
  speaking: string[] = [];
  /** Peer id occupying each of our speaker slots. */
  slots: (string | null)[] = [];
  readonly keyring: GroupKeyring;
  /** Negotiate audio with the relay (voice channels, DM calls). */
  isVoice = false;
  /** Active server-relay grant, if we fell back to one. */
  relayGrant: RelayGrant | null = null;

  /** The host can carry video, with this many slots (from its hello); null if not, or unknown yet. */
  hostMedia: { video: number; audio: number } | null = null;
  /** Video was added to the current connection. */
  mediaReady = false;
  /** The camera or screen each of our video slots carries now (stream ids). */
  videoSlots: (string | null)[] = [];
  /** The screen whose sound each of our screen-sound slots carries. */
  screenAudioSlots: (string | null)[] = [];
  /** Streams we asked for that the host can't send at the moment. */
  pausedStreams: string[] = [];
  /** Screens this member chose to watch, first chosen first. */
  watchedScreens: string[] = [];
  private videoTracks: (MediaStreamTrack | undefined)[] = [];
  private videoStreams = new Map<number, MediaStream>();
  /**
   * Video slots whose current stream has shown a picture since it was put
   * there. A slot's track outlives what it carries, so until then it would
   * still show the previous stream's last frame.
   */
  private videoShowing = new Set<number>();
  private sentWatch: string | null = null;

  private hosting?: { epoch: number; handle: Promise<RelayHandle | null> };
  private transport?: { epoch: number; host: string; t: RelayTransport; attempt?: ConnectAttempt };
  private failures = 0;
  /** How the connection to the host travels, once known. */
  route: ConnectionRoute | null = null;

  /** Failed connection attempts since the last one that worked, whoever hosted. */
  private failedInARow = 0;
  /** Recent connection attempts, newest last. */
  attempts: ConnectAttempt[] = [];
  /** When the current connection to the host opened. */
  connectedAt: number | null = null;
  private renewTimer?: ReturnType<typeof setTimeout>;
  /** Peer id of the host we last failed to reach. */
  unreachable: string | null = null;

  /** Connecting to the host keeps failing: a direct path may not exist. */
  get trouble() {
    return this.failedInARow >= 2 && this.status !== 'connected' && !this.isHost;
  }
  private reportedEpoch = -1;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private left = false;
  private pendingGroup: { from: string; env: Extract<E2EEnvelope, { k: 'group' }>; at: number }[] =
    [];
  private historyServedAt = new Map<string, number[]>();
  private historyAsked = new Set<string>();
  private relayRequested = false;
  /** Peers we already offered our outbox to on this connection. */
  private outboxOffered = new Set<string>();
  /** Delivery confirmations to send, batched per peer. */
  private ackQueue = new Map<string, Set<string>>();
  private ackTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly sessionId: string,
    private readonly ctx: SessionContext,
    private readonly transportFactory: TransportFactory,
    private readonly voice?: VoiceHooks,
    keyringOpts?: { autoRatchet?: boolean },
  ) {
    super();
    this.keyring = new GroupKeyring(keyringOpts);
    this.keyring.on('rotated', () => this.distributeKey());
  }

  get me() {
    return this.ctx.peer;
  }

  get isHost() {
    return this.state?.host === this.me;
  }

  get connected() {
    return this.status === 'connected';
  }

  get isDm() {
    return this.sessionId.startsWith('dm:');
  }

  async join() {
    this.left = false;
    if (this.status === 'idle' || this.status === 'left') this.setStatus('joining');
    const caps = await this.ctx.caps();
    const { state } = await this.ctx.link().request('session.join', {
      sessionId: this.sessionId,
      caps,
    });
    this.applyState(state);
  }

  async updateCaps() {
    if (this.left) return;
    const caps = await this.ctx.caps();
    await this.ctx
      .link()
      .request('session.update', { sessionId: this.sessionId, caps })
      .catch(() => {});
  }

  async leave() {
    if (this.left) return;
    this.left = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.renewTimer);
    clearTimeout(this.expiryTimer);
    clearInterval(this.pingTimer);
    this.closeTransport();
    this.stopHosting();
    this.keyring.dispose();
    this.setStatus('left');
    await this.ctx
      .link()
      .request('session.leave', { sessionId: this.sessionId })
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Session state from the coordinator
  // -------------------------------------------------------------------------

  applyState(state: SessionState) {
    if (this.left || state.id !== this.sessionId) return;
    if (this.state && state.epoch < this.state.epoch) return;
    this.state = state;
    if (state.host === this.me) {
      if (!this.hosting || this.hosting.epoch !== state.epoch) this.startHosting(state);
    } else if (this.hosting) {
      this.stopHosting();
    }
    if (!state.host) {
      this.closeTransport();
      this.setStatus('no-host');
    } else if (
      !this.transport ||
      this.transport.epoch !== state.epoch ||
      this.transport.host !== state.host
    ) {
      // Failures count against one host at one epoch: other changes (members
      // coming and going) mustn't reset them, or the host is never reported
      // and the relay never tried.
      const target = this.attempted;
      if (!target || target.epoch !== state.epoch || target.host !== state.host) this.failures = 0;
      this.connectTransport();
    }
    this.emit('update', undefined);
  }

  /** When our relay last had to be started again, to give up on one that keeps dying. */
  private relayRestarts: number[] = [];

  private startHosting(state: SessionState) {
    this.stopHosting();
    const adapter = this.ctx.platform.relay;
    if (!adapter) return;
    const sessionId = this.sessionId;
    const handle = adapter
      .start({
        sessionId,
        epoch: state.epoch,
        identity: this.ctx.identity,
        hostPeer: this.me,
        slots: state.relaySlots,
        iceServers: this.ctx.iceServers(),
        members: () =>
          (this.state?.members ?? [])
            .map((m) => m.peer)
            .filter((p) => this.ctx.isAllowedPeer(sessionId, p)),
        sendSignal: (to, data) => {
          void this.ctx
            .link()
            .request('signal.send', { to, sessionId, data })
            .catch(() => {});
        },
        onFailed: (reason) => {
          // Members reconnect to a fresh relay at the same epoch; a host whose
          // relay keeps dying stops, and they report it to get another host.
          if (this.left || this.hosting?.handle !== handle || this.state?.host !== this.me) return;
          const now = Date.now();
          this.relayRestarts = this.relayRestarts.filter((t) => now - t < 60_000);
          this.ctx.log('relay stopped', { sessionId, reason, restarts: this.relayRestarts.length });
          if (this.relayRestarts.length >= 3) return this.stopHosting();
          this.relayRestarts.push(now);
          this.startHosting(this.state);
        },
      })
      .catch((err) => {
        this.ctx.log('failed to start relay', { err: String(err) });
        return null;
      });
    this.hosting = { epoch: state.epoch, handle };
    this.ctx.log('hosting relay', { sessionId, epoch: state.epoch });
    const early = this.earlyRelaySignals.filter((s) => s.data.epoch === state.epoch);
    this.earlyRelaySignals = [];
    for (const s of early) void handle.then((r) => r?.handleSignal(s.from, s.data));
  }

  private stopHosting() {
    const h = this.hosting;
    this.hosting = undefined;
    void h?.handle.then((r) => r?.close());
  }

  /** Offers can beat our own copy of the session state that makes us host. */
  private earlyRelaySignals: { from: string; data: SignalData; at: number }[] = [];

  handleSignal(from: string, data: SignalData) {
    const toRelay =
      data.type === 'offer' ||
      ((data.type === 'candidate' || data.type === 'bye') && data.dir === 'toRelay');
    if (toRelay) {
      const h = this.hosting;
      if (h && h.epoch === data.epoch) void h.handle.then((r) => r?.handleSignal(from, data));
      else if (!h || h.epoch < data.epoch) {
        const now = Date.now();
        this.earlyRelaySignals = this.earlyRelaySignals
          .filter((s) => now - s.at < 5000)
          .slice(-200);
        this.earlyRelaySignals.push({ from, data, at: now });
      }
      return;
    }
    const t = this.transport;
    if (t && t.host === from && t.epoch === data.epoch) void t.t.handleSignal(data);
  }

  // -------------------------------------------------------------------------
  // Connection to the host relay
  // -------------------------------------------------------------------------

  /** The host and epoch of the latest connection attempt. */
  private attempted?: { epoch: number; host: string };

  private connectTransport() {
    // A retry scheduled for an earlier attempt must not tear this one down.
    clearTimeout(this.retryTimer);
    this.closeTransport();
    const state = this.state;
    if (!state?.host || this.left) return;
    this.attempted = { epoch: state.epoch, host: state.host };
    const slots = this.voice && this.isVoice ? state.relaySlots : 0;
    const grant =
      this.relayGrant && this.relayGrant.expiresAt > Date.now() ? this.relayGrant : null;
    const iceServers: RTCIceServer[] = [
      ...this.ctx.iceServers(),
      ...(grant
        ? [{ urls: grant.urls, username: grant.username, credential: grant.credential }]
        : []),
    ];
    const t = this.transportFactory({
      identity: this.ctx.identity,
      self: this.me,
      sessionId: this.sessionId,
      epoch: state.epoch,
      host: state.host,
      iceServers,
      slots,
      micTrack: this.voice?.micTrack() ?? null,
      crypto: slots > 0 ? this.voice?.frameCrypto(this.keyring) : undefined,
      sendSignal: (data) =>
        this.ctx
          .link()
          .request('signal.send', { to: state.host!, sessionId: this.sessionId, data }),
    });
    const attempt: ConnectAttempt = {
      startedAt: Date.now(),
      host: state.host,
      viaRelay: !!grant,
      steps: [],
    };
    const entry = { epoch: state.epoch, host: state.host, t, attempt };
    this.transport = entry;
    this.attempts = [...this.attempts, attempt].slice(-ATTEMPTS_KEPT);
    this.connectedAt = null;
    t.on('progress', ({ step }) => {
      if (this.transport !== entry || attempt.steps.some((s) => s.step === step)) return;
      attempt.steps.push({ step, at: Date.now() });
      this.emit('update', undefined);
    });
    this.peers.clear();
    this.welcomed = false;
    this.slots = [];
    this.speaking = [];
    this.hostMedia = null;
    this.mediaReady = false;
    this.videoSlots = [];
    this.screenAudioSlots = [];
    this.pausedStreams = [];
    this.videoTracks = [];
    this.videoStreams.clear();
    this.videoShowing.clear();
    this.sentWatch = null;
    this.setStatus(this.failures > 0 ? 'reconnecting' : 'connecting');

    this.route = null;
    t.on('open', () => {
      if (this.transport !== entry) return;
      if (!attempt.steps.some((s) => s.step === 'open'))
        attempt.steps.push({ step: 'open', at: Date.now() });
      attempt.end = { at: Date.now(), ok: true };
      this.connectedAt = Date.now();
      this.failures = 0;
      this.failedInARow = 0;
      this.unreachable = null;
      this.setStatus('connected');
      // ICE may still switch pairs just after connecting: read it again a few times.
      const readRoute = () =>
        void t
          .route?.()
          .then((route) => {
            if (this.transport !== entry || !route || route === this.route) return;
            this.route = route;
            // Through the server relay: no video (and back again if ICE moves).
            this.refreshVideo();
            this.emit('update', undefined);
          })
          .catch(() => {});
      for (const ms of [0, 1000, 3000]) setTimeout(readRoute, ms);
      // And keep watching it: ICE can move to the server relay at any time.
      const routeTimer = setInterval(() => {
        if (this.transport !== entry || this.left) return clearInterval(routeTimer);
        readRoute();
      }, ROUTE_CHECK_MS);
      routeTimer.unref?.();
      this.rttMs = null;
      this.sendState();
      this.startPings(entry);
    });
    t.on('message', (msg) => {
      if (this.transport === entry) this.onRelayMessage(msg);
    });
    t.on('track', (ev) => this.emit('track', ev));
    t.on('video', ({ slot, track }) => {
      if (this.transport !== entry) return;
      this.videoTracks[slot] = track;
      this.videoStreams.delete(slot);
      this.emit('update', undefined);
    });
    t.on('screenAudio', (ev) => {
      if (this.transport === entry) this.emit('screenAudio', ev);
    });
    t.on('media', () => {
      if (this.transport !== entry) return;
      this.mediaReady = true;
      this.refreshVideo();
      this.emit('update', undefined);
    });
    t.on('failed', ({ reason, stage }) => {
      if (this.transport !== entry) return;
      this.transport = undefined;
      const reached = (step: ConnectStep) => attempt.steps.some((s) => s.step === step);
      const where: FailStage =
        stage ??
        (this.connectedAt || reached('open')
          ? 'lost'
          : reached('path')
            ? 'no-channel'
            : reached('answer')
              ? 'no-path'
              : 'no-answer');
      // An attempt that connected and was then lost keeps its steps: "open" at
      // one time, "lost" at another says how long it lasted.
      attempt.end = { at: Date.now(), ok: false, stage: where, reason };
      const connectedFor = this.connectedAt ? Date.now() - this.connectedAt : 0;
      this.connectedAt = null;
      this.ctx.log('relay connection failed', {
        sessionId: this.sessionId,
        reason,
        stage: where,
        ...(connectedFor ? { connectedForS: Math.round(connectedFor / 1000) } : {}),
        viaRelay: attempt.viaRelay,
      });
      this.failures += 1;
      this.failedInARow += 1;
      this.unreachable = entry.host;
      this.route = null;
      this.setStatus('reconnecting');
      this.emit('update', undefined);
      // Two failures, or one direct attempt where the host answered but no
      // network path worked: that won't change by trying again, so say so at
      // once and let the coordinator pick another host. Not when our own
      // network is the limited one (symmetric, or UDP blocked): then the
      // fault may well be ours, and a report would move the host to us.
      const myNat = this.state?.members.find((m) => m.peer === this.me)?.caps.nat;
      const hopeless = where === 'no-path' && !attempt.viaRelay && !!myNat && myNat !== 'symmetric';
      const report = this.failures >= 2 || hopeless;
      if (report && this.reportedEpoch !== entry.epoch && entry.host !== this.me) {
        this.reportedEpoch = entry.epoch;
        void this.ctx
          .link()
          .request('session.report', {
            sessionId: this.sessionId,
            epoch: entry.epoch,
            issue: 'host_unreachable',
          })
          .catch(() => {});
      }
      if (
        this.failures >= 2 &&
        !this.relayGrant &&
        !this.relayRequested &&
        this.ctx.relay.allowed()
      ) {
        void this.useServerRelay();
      }
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(
        () => {
          if (!this.left && !this.transport && this.state?.epoch === entry.epoch)
            this.connectTransport();
        },
        Math.min(10_000, 500 * 2 ** this.failures),
      );
    });
    t.connect().catch((err) => {
      this.ctx.log('relay connect error', { err: String(err) });
      t.emit('failed', { reason: String(err) });
    });
  }

  /** Ask our coordination server for a relay grant and reconnect through it. */
  async useServerRelay() {
    this.relayRequested = true;
    try {
      this.relayGrant = await this.ctx.relay.request(this.sessionId);
      this.ctx.log('using server relay', {
        server: this.relayGrant.server,
        until: this.relayGrant.expiresAt,
      });
      this.scheduleRelayRenewal();
      this.emit('update', undefined);
      this.failures = 1;
      this.connectTransport();
    } catch (err) {
      this.ctx.log('server relay unavailable', { err: String(err) });
      this.emit('error', { message: `Relay unavailable: ${(err as Error).message}` });
    } finally {
      this.relayRequested = false;
    }
  }

  /** Whether the connection we have depends on the server relay. */
  get dependsOnRelay() {
    return this.status !== 'connected' || this.route === 'relay' || this.route === null;
  }

  /**
   * Shortly before the grant ends: extend it if the connection still goes
   * through the relay (the server keeps the relayed connection running), or
   * let it go if ICE found a direct path after all.
   */
  private scheduleRelayRenewal() {
    clearTimeout(this.renewTimer);
    clearTimeout(this.expiryTimer);
    const grant = this.relayGrant;
    if (!grant) return;
    const left = grant.expiresAt - Date.now();
    this.renewTimer = setTimeout(
      () => void this.renewRelay(grant),
      Math.max(0, left - Math.min(RELAY_RENEW_BEFORE_MS, left / 2)),
    );
    // At its end the grant goes, whether or not the server's notice reaches
    // us (it doesn't while our link is down): a stale grant would keep its
    // dead credentials in every reconnect and block asking for a new one.
    this.expiryTimer = setTimeout(
      () => {
        if (this.left || this.relayGrant !== grant) return;
        this.ctx.log('relay grant ran out', { at: grant.expiresAt });
        this.dropServerRelay();
      },
      Math.max(0, left),
    );
  }

  private expiryTimer?: ReturnType<typeof setTimeout>;

  private async renewRelay(grant: RelayGrant) {
    if (this.left || this.relayGrant !== grant) return;
    if (!this.dependsOnRelay) {
      this.ctx.log('relay not needed any more: connected directly', { route: this.route });
      clearTimeout(this.expiryTimer);
      this.relayGrant = null;
      this.emit('update', undefined);
      return;
    }
    try {
      const renewed = await this.ctx.relay.request(this.sessionId);
      if (this.left || this.relayGrant !== grant) return;
      this.relayGrant = renewed;
      this.ctx.log('relay renewed', { until: renewed.expiresAt });
      this.scheduleRelayRenewal();
      this.emit('update', undefined);
    } catch (err) {
      // Try again while the grant lasts (the link may be down for a moment);
      // if it runs out first, the expiry timer drops it.
      const left = grant.expiresAt - Date.now();
      this.ctx.log('relay renewal failed', { err: String(err), leftS: Math.round(left / 1000) });
      if (this.left || this.relayGrant !== grant || left <= 0) return;
      clearTimeout(this.renewTimer);
      this.renewTimer = setTimeout(
        () => void this.renewRelay(grant),
        Math.min(RELAY_RENEW_RETRY_MS, left / 2),
      );
    }
  }

  /**
   * The grant ended: go back to direct connections only. A connection that
   * found a direct path keeps running; one that went through the relay is
   * set up again. Returns whether the connection had to be interrupted.
   */
  dropServerRelay(): boolean {
    if (!this.relayGrant) return false;
    clearTimeout(this.renewTimer);
    clearTimeout(this.expiryTimer);
    const interrupted = !!this.transport && this.dependsOnRelay;
    this.relayGrant = null;
    this.emit('update', undefined);
    if (interrupted) this.connectTransport();
    return interrupted;
  }

  /** Live WebRTC numbers for the connection to the host, if any. */
  async stats(): Promise<LinkStats | null> {
    return (await this.transport?.t.stats?.().catch(() => null)) ?? null;
  }

  private closeTransport() {
    const t = this.transport;
    this.transport = undefined;
    // An attempt still under way when we move on (another host, a new epoch,
    // leaving) ends here; it must not show as "trying" forever.
    if (t?.attempt && !t.attempt.end)
      t.attempt.end = {
        at: Date.now(),
        ok: false,
        stage: 'superseded',
        reason: 'stopped: the session moved on (another host, or the session closed)',
      };
    t?.t.close();
  }

  voiceState = { muted: false, deafened: false };
  /** Our round trip to the host, measured over the relay's data channel (ms). */
  rttMs: number | null = null;
  private sentRtt: number | null = null;
  private pingTimer?: ReturnType<typeof setInterval>;

  setVoiceState(muted: boolean, deafened: boolean) {
    this.voiceState = { muted, deafened };
    this.sendState();
  }

  /** Tell the relay (and through it, everyone) our mute state, call presence and latency. */
  private sendState() {
    this.sentRtt = this.rttMs;
    const out = this.sending();
    this.transport?.t.send({
      t: 'state',
      ...this.voiceState,
      voice: this.isVoice,
      ...(this.rttMs !== null ? { rtt: this.rttMs } : {}),
      ...(out.camera ? { camera: true } : {}),
      ...(out.screen ? { screen: { audio: !!out.screen.audio } } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Video
  // -------------------------------------------------------------------------

  /** Why video can't be used on this connection, if it can't. */
  get videoBlocked(): VideoBlock | null {
    if (this.route === 'relay') return 'relayed';
    if (this.welcomed && !this.hostMedia) return 'old-host';
    return null;
  }

  /**
   * Video is on the connection and may be used: the host carries it and the
   * connection is known to go directly to it, not through a server relay.
   */
  get videoUsable(): boolean {
    return this.mediaReady && this.route !== null && !this.videoBlocked;
  }

  /** What we send now: nothing until video can be used. */
  private sending(): OutgoingVideo {
    if (!this.videoUsable || !this.voice?.outgoing) return { camera: null, screen: null };
    return this.voice.outgoing();
  }

  /** The camera or screen changed, or whether video can be used: send and ask accordingly. */
  refreshVideo() {
    const t = this.transport?.t;
    if (t?.setOutgoing && this.mediaReady) {
      const out = this.sending();
      const screen = out.screen;
      void t.setOutgoing('camera', out.camera, { bitrate: VIDEO_BITRATE.camera }).catch(() => {});
      void t
        .setOutgoing('screen', screen?.video ?? null, {
          bitrate: VIDEO_BITRATE[screen?.quality ?? 'text'],
          hint: screen?.quality ?? 'text',
        })
        .catch(() => {});
      void t.setOutgoing('screenAudio', screen?.audio ?? null).catch(() => {});
    }
    this.sendState();
    this.updateWatch();
  }

  /**
   * Ask the host for what we want to see: the screens we chose, then
   * everyone's camera. It sends what fits and says what it held back.
   */
  private updateWatch() {
    if (!this.mediaReady) return;
    const live = (stream: string) => {
      const p = this.peers.get(streamIds.peer(stream));
      return streamIds.kind(stream) === 'camera' ? !!p?.camera : !!p?.screen;
    };
    const cameras = [...this.peers.values()]
      .filter((p) => p.camera && p.id !== this.me)
      .map((p) => streamIds.make(p.id, 'camera'));
    const streams = !this.videoUsable
      ? []
      : [...new Set([...this.watchedScreens.filter(live), ...cameras])].slice(0, 32);
    const key = streams.join();
    if (key === this.sentWatch) return;
    if (this.transport?.t.send({ t: 'watch', streams })) this.sentWatch = key;
  }

  /** Start or stop watching a member's shared screen. */
  watchScreen(stream: string, on: boolean) {
    this.watchedScreens = on
      ? [...this.watchedScreens.filter((s) => s !== stream), stream]
      : this.watchedScreens.filter((s) => s !== stream);
    this.updateWatch();
    this.emit('update', undefined);
  }

  /**
   * A stream was put in a slot: it shows once a frame decodes there (the
   * host starts it at a key frame), or after a while in any case.
   */
  private async awaitPicture(slot: number, stream: string) {
    const entry = this.transport;
    const still = () => this.transport === entry && this.videoSlots[slot] === stream;
    const frames = () => entry?.t.videoFrames?.(slot).catch(() => null) ?? Promise.resolve(null);
    const start = await frames();
    const until = Date.now() + FIRST_PICTURE_WAIT_MS;
    while (start !== null && still() && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 150));
      const now = await frames();
      if (now === null || now > start) break;
    }
    if (!still()) return;
    this.videoShowing.add(slot);
    this.emit('update', undefined);
  }

  /** Whether a stream we get shows its own picture yet. */
  videoShowingNow(stream: string): boolean {
    const slot = this.videoSlots.indexOf(stream);
    return slot >= 0 && this.videoShowing.has(slot);
  }

  /** The picture of a camera or screen the host sends us, while it does. */
  videoStream(stream: string): MediaStream | null {
    const slot = this.videoSlots.indexOf(stream);
    const track = slot >= 0 ? this.videoTracks[slot] : undefined;
    if (!track || typeof MediaStream === 'undefined') return null;
    let out = this.videoStreams.get(slot);
    if (!out) {
      out = new MediaStream([track]);
      this.videoStreams.set(slot, out);
    }
    return out;
  }

  /** In calls, measure the round trip to the host every few seconds. */
  private startPings(entry: NonNullable<GroupSession['transport']>) {
    clearInterval(this.pingTimer);
    if (!this.isVoice) return;
    const ping = () => {
      if (this.transport !== entry || this.left) return clearInterval(this.pingTimer);
      entry.t.send({ t: 'ping', ts: Date.now() });
    };
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private onPong(ts: number) {
    const rtt = Math.max(0, Date.now() - ts);
    if (rtt > 60_000) return;
    this.rttMs = rtt;
    // Others only need to hear about a change they would notice.
    if (this.sentRtt === null || Math.abs(rtt - this.sentRtt) >= Math.max(3, this.sentRtt * 0.1))
      this.sendState();
    this.emit('update', undefined);
  }

  async setMicTrack(track: MediaStreamTrack | null) {
    await this.transport?.t.setMicTrack?.(track);
  }

  // -------------------------------------------------------------------------
  // Relay messages and the end-to-end layer
  // -------------------------------------------------------------------------

  private onRelayMessage(msg: RelayToClient) {
    switch (msg.t) {
      case 'hello': {
        this.welcomed = true;
        this.peers = new Map(msg.peers.map((p) => [p.id, p]));
        this.slots = new Array(msg.slots).fill(null);
        this.hostMedia = msg.media ?? null;
        // In a call, with a host that carries video: add it to the connection.
        const t = this.transport?.t;
        if (msg.media && msg.slots > 0 && this.isVoice && this.voice?.outgoing && t?.addMedia)
          t.addMedia(msg.media).catch((err: unknown) =>
            this.ctx.log('could not add video to the call', { err: String(err) }),
          );
        this.historyAsked.clear();
        this.outboxOffered.clear();
        for (const p of msg.peers) this.onPeerPresent(p.id);
        this.requestHistory([...this.peers.keys()]);
        break;
      }
      case 'peer_join':
        this.peers.set(msg.peer.id, msg.peer);
        this.onPeerPresent(msg.peer.id);
        this.updateWatch();
        // DMs and our own other devices sync history from each newcomer.
        if (this.isDm || peerIds.user(msg.peer.id) === peerIds.user(this.me))
          this.requestHistory([msg.peer.id]);
        break;
      case 'peer_leave':
        this.peers.delete(msg.peer);
        this.outboxOffered.delete(msg.peer);
        this.updateWatch();
        this.keyring.peerLeft(msg.peer);
        this.keyring.rotate();
        break;
      case 'peer_state':
        if (this.peers.has(msg.peer.id)) this.peers.set(msg.peer.id, msg.peer);
        this.updateWatch();
        break;
      case 'media': {
        const before = this.videoSlots;
        this.videoSlots = msg.video;
        this.screenAudioSlots = msg.audio;
        this.pausedStreams = msg.paused;
        msg.video.forEach((stream, slot) => {
          if (stream === before[slot]) return;
          this.videoShowing.delete(slot);
          this.videoStreams.delete(slot);
          if (stream) void this.awaitPicture(slot, stream);
        });
        break;
      }
      case 'slots':
        this.slots = msg.map;
        break;
      case 'speaking':
        this.speaking = msg.users;
        break;
      case 'msg':
        void this.onEnvelope(msg.from, msg.d);
        return;
      case 'pong':
        this.onPong(msg.ts);
        return;
    }
    this.emit('update', undefined);
  }

  private async onPeerPresent(peer: string) {
    if (!this.ctx.isAllowedPeer(this.sessionId, peer)) {
      // Their membership may simply not have reached us yet.
      await this.ctx.refreshPeer(this.sessionId, peer).catch(() => {});
      if (!this.ctx.isAllowedPeer(this.sessionId, peer)) {
        this.ctx.log('ignoring peer that is not allowed in this session', { peer });
        return;
      }
    }
    await this.sendKeyTo(peer);
    await this.processParkedKeys();
    await this.offerOutbox(peer);
  }

  /**
   * Hand our unacknowledged messages to someone who will keep and spread
   * them: the other side of a DM, or the host/backup of a space.
   */
  private async offerOutbox(peer: string) {
    if (this.outboxOffered.has(peer) || peerIds.user(peer) === peerIds.user(this.me)) return;
    const st = this.state;
    const worthy = this.isDm || peer === st?.host || peer === st?.backup || this.isHost;
    if (!worthy) return;
    const pending = this.ctx.outbox.pending(this.sessionId);
    if (pending.length === 0) return;
    this.outboxOffered.add(peer);
    await this.sendMessages(peer, pending);
  }

  /**
   * Messages to one peer as 'history' replies, each small enough for one
   * data channel message; the last one says it's done.
   */
  private async sendMessages(to: string, messages: ChatMessage[]) {
    let chunk: ChatMessage[] = [];
    let size = 0;
    for (const m of messages) {
      const bytes = utf8.encode(JSON.stringify(m)).length + 1;
      if (size + bytes > HISTORY_CHUNK_BYTES && chunk.length) {
        await this.sendSealed(to, { type: 'history', messages: chunk, done: false });
        chunk = [];
        size = 0;
      }
      chunk.push(m);
      size += bytes;
    }
    await this.sendSealed(to, { type: 'history', messages: chunk, done: true });
  }

  /**
   * Hands messages to the client; returns those it took in or already had.
   * Only those are confirmed: a sender must not take a message nobody kept
   * for delivered.
   */
  private async take(messages: ChatMessage[], history: boolean) {
    const taken: ChatMessage[] = [];
    for (const m of messages) {
      await this.ctx.acceptMessage(this.sessionId, m, history);
      if (this.ctx.admits(this.sessionId, m, history)) taken.push(m);
    }
    return taken;
  }

  /** Confirm receipt of messages authored by `from`'s user, batched. */
  private queueAck(from: string, messages: ChatMessage[]) {
    const author = peerIds.user(from);
    if (author === peerIds.user(this.me)) return;
    const ids = messages.filter((m) => m.author === author).map((m) => m.id);
    if (ids.length === 0) return;
    let set = this.ackQueue.get(from);
    if (!set) this.ackQueue.set(from, (set = new Set()));
    for (const id of ids) set.add(id);
    this.ackTimer ??= setTimeout(() => {
      this.ackTimer = undefined;
      const queue = this.ackQueue;
      this.ackQueue = new Map();
      for (const [to, idSet] of queue) {
        const all = [...idSet];
        for (let i = 0; i < all.length; i += 500)
          void this.sendSealed(to, { type: 'ack', ids: all.slice(i, i + 500) });
      }
    }, 250);
  }

  /** Live group messages: DMs always confirm; in spaces the host (or backup) does. */
  private shouldAckLive(from: string) {
    if (this.isDm) return true;
    const st = this.state;
    if (this.isHost) return true;
    return st?.host === from && (st.backup === this.me || !st.backup);
  }

  /**
   * Called when records or blocks change: admit peers that became allowed,
   * and cut off those that no longer are (blocked, banned, removed device):
   * their keys are dropped and ours is replaced, so neither side can read
   * the other any more.
   */
  recheckPeers() {
    let revoked = false;
    for (const peer of this.peers.keys()) {
      if (this.ctx.isAllowedPeer(this.sessionId, peer)) {
        if (this.keySentTo.get(peer) !== this.keyring.kid) void this.sendKeyTo(peer);
      } else if (this.keySentTo.has(peer) || this.keyring.hasKeyFrom(peer)) {
        this.keySentTo.delete(peer);
        this.keyring.forgetPeer(peer);
        revoked = true;
      }
    }
    // The new key only goes to peers still allowed.
    if (revoked) this.keyring.rotate();
    void this.processParkedKeys();
  }

  /** Whether a peer may be heard, after fetching their records once if not. */
  private async mayHear(peer: string) {
    if (this.ctx.isAllowedPeer(this.sessionId, peer)) return true;
    await this.ctx.refreshPeer(this.sessionId, peer).catch(() => {});
    return this.ctx.isAllowedPeer(this.sessionId, peer);
  }

  private keySentTo = new Map<string, number>();
  /** Sender keys from peers we could not verify yet (bounded, short-lived). */
  private parkedKeys: {
    from: string;
    payload: Extract<SealedPayload, { type: 'sender_key' }>;
    at: number;
  }[] = [];

  private async processParkedKeys() {
    const now = Date.now();
    const parked = this.parkedKeys.filter((p) => now - p.at < 30_000);
    this.parkedKeys = [];
    for (const p of parked) {
      if (this.ctx.isAllowedPeer(this.sessionId, p.from)) await this.acceptKey(p.from, p.payload);
      else this.parkedKeys.push(p);
    }
  }

  private async acceptKey(from: string, payload: Extract<SealedPayload, { type: 'sender_key' }>) {
    // The first key from someone means they (re)joined, or we did: ours may
    // not have reached them (sent while their side was still connecting, or
    // to an earlier run of their app), so it goes again, once.
    const first = !this.keyring.hasKeyFrom(from);
    this.keyring.addPeerKey(from, { kid: payload.kid, text: payload.text, audio: payload.audio });
    await this.flushPending();
    if (first) await this.sendKeyTo(from);
  }

  private distributeKey() {
    for (const peer of this.peers.keys()) {
      if (this.ctx.isAllowedPeer(this.sessionId, peer)) void this.sendKeyTo(peer);
    }
  }

  private async sendKeyTo(peer: string) {
    const chains = this.keyring.exportMine();
    if (await this.sendSealed(peer, { type: 'sender_key', sessionId: this.sessionId, ...chains })) {
      this.keySentTo.set(peer, chains.kid);
    }
  }

  /** A sealed payload to one peer connected to the session. */
  sendSealedTo(to: string, payload: SealedPayload): Promise<boolean> {
    return this.sendSealed(to, payload);
  }

  private async sendSealed(to: string, payload: SealedPayload): Promise<boolean> {
    const box = await this.ctx.seal(to, utf8.encode(JSON.stringify(payload)));
    if (!box || !this.transport) {
      this.ctx.log('could not seal to peer', { to, type: payload.type, noBox: !box });
      return false;
    }
    return this.transport.t.send({ t: 'direct', to, d: { k: 'sealed', box } });
  }

  sendGroup(payload: GroupPayload): boolean {
    if (!this.transport?.t.isOpen) return false;
    const env = this.keyring.encrypt(utf8.encode(JSON.stringify(payload)));
    return this.transport.t.send({ t: 'bcast', d: { k: 'group', ...env } });
  }

  private async onEnvelope(from: string, raw: unknown) {
    const parsed = E2EEnvelope.safeParse(raw);
    if (!parsed.success) return;
    const env = parsed.data;
    if (env.k === 'sealed') {
      const opened = this.ctx.open(env.box);
      if (!opened || opened.from !== from) {
        this.ctx.log('dropped sealed box', { from, opened: !!opened, claimed: opened?.from });
        return;
      }
      let payload: SealedPayload;
      try {
        payload = SealedPayload.parse(JSON.parse(utf8.decode(opened.plaintext)));
      } catch {
        return;
      }
      await this.onSealed(from, payload);
      return;
    }
    const result = this.keyring.decrypt(env.kid, env.g, env.ct);
    if (!result) {
      this.pendingGroup.push({ from, env, at: Date.now() });
      if (this.pendingGroup.length > 500) this.pendingGroup.shift();
      return;
    }
    if (result.peer !== from) return;
    await this.onGroupPlaintext(from, result.plaintext);
  }

  private async onSealed(from: string, payload: SealedPayload) {
    switch (payload.type) {
      case 'sender_key':
        if (payload.sessionId !== this.sessionId) return;
        if (!this.ctx.isAllowedPeer(this.sessionId, from)) {
          this.parkedKeys.push({ from, payload, at: Date.now() });
          if (this.parkedKeys.length > 100) this.parkedKeys.shift();
          await this.ctx.refreshPeer(this.sessionId, from).catch(() => {});
          await this.processParkedKeys();
          return;
        }
        await this.acceptKey(from, payload);
        return;
      case 'history_req':
        if (!(await this.mayHear(from))) return;
        await this.serveHistory(from, payload.since);
        return;
      case 'history':
        if (!(await this.mayHear(from))) return;
        this.queueAck(from, await this.take(payload.messages, true));
        return;
      case 'message':
        if (!(await this.mayHear(from))) return;
        this.queueAck(from, await this.take([payload.message], false));
        return;
      case 'ack':
        // Only another person's confirmation counts, not our own other devices.
        if (
          peerIds.user(from) !== peerIds.user(this.me) &&
          this.ctx.isAllowedPeer(this.sessionId, from)
        )
          this.ctx.outbox.acked(payload.ids);
        return;
      case 'mail':
        return;
      case 'file_have':
      case 'file_link':
        if (!(await this.mayHear(from))) return;
        this.emit('file', { from, payload });
        return;
    }
  }

  private async onGroupPlaintext(from: string, plaintext: Uint8Array) {
    let payload: GroupPayload;
    try {
      payload = GroupPayload.parse(JSON.parse(utf8.decode(plaintext)));
    } catch {
      return;
    }
    // Keys from someone since blocked or removed may still be in flight.
    if (!this.ctx.isAllowedPeer(this.sessionId, from)) return;
    const fromUser = peerIds.user(from);
    if (payload.type === 'message') {
      if (payload.message.author !== fromUser) return;
      const taken = await this.take([payload.message], false);
      if (this.shouldAckLive(from)) this.queueAck(from, taken);
    } else if (payload.type === 'typing') {
      this.emit('typing', { userId: fromUser, ch: payload.ch });
    } else if (payload.type === 'call' && this.isDm) {
      this.emit('call', {
        userId: fromUser,
        action: payload.action,
        ...(payload.video ? { video: true } : {}),
      });
    } else if (payload.type === 'file_want') {
      this.emit('file', { from, payload });
    }
  }

  private async flushPending() {
    const now = Date.now();
    const queue = this.pendingGroup.filter((p) => now - p.at < PENDING_TTL_MS);
    this.pendingGroup = [];
    for (const p of queue) {
      const result = this.keyring.decrypt(p.env.kid, p.env.g, p.env.ct);
      if (!result) this.pendingGroup.push(p);
      else if (result.peer === p.from) await this.onGroupPlaintext(p.from, result.plaintext);
    }
  }

  // -------------------------------------------------------------------------
  // History sync
  // -------------------------------------------------------------------------

  private requestHistory(candidates: string[]) {
    const channels = this.ctx.historyChannels(this.sessionId);
    if (channels.length === 0) return;
    const st = this.state;
    const preferred = [st?.host, st?.backup, ...candidates].filter(
      (u): u is string => !!u && u !== this.me && this.peers.has(u) && !this.historyAsked.has(u),
    );
    const targets = [...new Set(preferred)].slice(0, 2);
    if (targets.length === 0) return;
    void (async () => {
      const since: Record<string, number> = {};
      for (const ch of channels) since[ch] = await this.ctx.syncCursor(ch);
      for (const t of targets) {
        this.historyAsked.add(t);
        await this.sendSealed(t, { type: 'history_req', since });
      }
    })();
  }

  private async serveHistory(to: string, since: Record<string, number>) {
    if (!this.ctx.isAllowedPeer(this.sessionId, to)) return;
    // Throttle: at most 5 history replies per peer per 10 seconds.
    const now = Date.now();
    const recent = (this.historyServedAt.get(to) ?? []).filter((t) => now - t < 10_000);
    if (recent.length >= 5) return;
    this.historyServedAt.set(to, [...recent, now]);
    const allowed = new Set(this.ctx.historyChannels(this.sessionId));
    const out: ChatMessage[] = [];
    for (const [ch, after] of Object.entries(since)) {
      if (!allowed.has(ch)) continue;
      // The store is keyed by channel id and may hold another space's messages
      // under it: take only this session's, reading on while 500 aren't found.
      const seen = new Set<string>();
      let from = after;
      for (let round = 0; round < 10; round++) {
        const held = await this.ctx.messages.since(ch, from, 500);
        for (const m of held)
          if (messageSession(m) === this.sessionId && !seen.has(messageKey(m))) {
            seen.add(messageKey(m));
            out.push(m);
          }
        if (held.length < 500 || seen.size >= 500) break;
        from = held[held.length - 1]!.ts;
      }
    }
    await this.sendMessages(to, out);
  }

  private setStatus(status: RelayStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emit('update', undefined);
  }
}

export function defaultTransportFactory(platform: PlatformAdapter): TransportFactory | undefined {
  const rtc = platform.rtc;
  if (!rtc) return undefined;
  return (opts) => new RelayLink({ ...opts, RTCPeerConnection: rtc.RTCPeerConnection });
}
