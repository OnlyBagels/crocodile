import {
  SCREEN_AUDIO_SLOTS,
  VIDEO_SLOTS,
  streamIds,
  type ClientToRelay,
  type PeerState,
  type RelayToClient,
  type SignalData,
} from '@crocodile/protocol';
import {
  Emitter,
  type FileLink,
  type FileLinkChannel,
  type FileLinkFactory,
  type HostRelayAdapter,
  type RelayHandle,
  type RelayLinkEvents,
  type RelayTransport,
  type TransportFactory,
} from '@crocodile/client-core';

/**
 * In-memory stand-in for WebRTC + HostRelay with the same routing semantics,
 * so client logic (election following, E2EE, history sync) can be tested in
 * Node. The real relay is covered by its own WebRTC tests.
 */
export class FakeRelayNetwork {
  private relays = new Map<string, FakeRelay>();
  private onFailed = new Map<string, (reason: string) => void>();
  /** Relays started so far. */
  started = 0;

  adapter(): HostRelayAdapter {
    return {
      start: async (opts) => {
        this.started++;
        const relay = new FakeRelay(opts.hostPeer, opts.members, this);
        const key = `${opts.sessionId}|${opts.epoch}|${opts.hostPeer}`;
        this.relays.set(key, relay);
        if (opts.onFailed) this.onFailed.set(key, opts.onFailed);
        return {
          handleSignal: () => {},
          close: async () => {
            if (this.relays.get(key) === relay) this.relays.delete(key);
            relay.close();
          },
        } satisfies RelayHandle;
      },
    };
  }

  transportFactory(): TransportFactory {
    return (opts) =>
      new FakeTransport(
        this,
        `${opts.sessionId}|${opts.epoch}|${opts.host}`,
        opts.self,
        opts.iceServers.some((s) => [s.urls].flat().some((u) => u.startsWith('turn:'))),
        opts.slots,
      );
  }

  /** Hosts (users) whose app is too old to carry video. */
  readonly noVideoHosts = new Set<string>();
  /** Most streams a host sends one member; the rest are paused. */
  videoRoom = VIDEO_SLOTS;
  /** What each device sends now: `<peer>:camera|screen|screenAudio` → track (or null). */
  readonly outgoing = new Map<string, unknown>();

  /** Users whose network allows no direct connections (only a TURN relay gets through). */
  readonly blocked = new Set<string>();
  /**
   * Users behind a symmetric NAT: they can connect out to others, but others
   * can't reach them, so nobody else can connect to a relay they host.
   */
  readonly unreachable = new Set<string>();

  /**
   * Direct connections for files, which only ever get STUN: they work unless
   * one side's network blocks direct connections or both sides are behind
   * symmetric NATs.
   */
  fileLinkFactory(): FileLinkFactory {
    return (opts) => {
      if (opts.iceServers.some((s) => [s.urls].flat().some((u) => !u.startsWith('stun'))))
        throw new Error('file links must not be offered a relay');
      return new FakeFileLink(this, opts.self, opts.remote);
    };
  }

  /** Offers waiting for an answer, by token. */
  readonly pendingFileLinks = new Map<string, FakeFileLink>();
  /** Open file links. */
  readonly fileLinks = new Set<FakeFileLink>();
  /** Every file link that opened: [downloader user, holder user]. */
  readonly fileLinkLog: [string, string][] = [];
  /** Bytes of file blocks carried, by holder user. */
  readonly fileBytesFrom = new Map<string, number>();

  directPossible(a: string, b: string) {
    const user = (p: string) => p.split('.')[0]!;
    const ua = user(a);
    const ub = user(b);
    if (this.blocked.has(ua) || this.blocked.has(ub)) return false;
    return !(this.unreachable.has(ua) && this.unreachable.has(ub));
  }

  /** Cut a holder's file links once this many block bytes have left it (once). */
  cutFileLinksAfter?: { user: string; bytes: number };
  /** Block bytes the holder had sent when that cut happened. */
  bytesAtCut = 0;

  /** Lose the next `count` direct (sealed) session messages a user sends. */
  dropDirectFrom?: { user: string; count: number };

  /** Hold all file link traffic once a holder has sent this many block bytes (once). */
  pauseFileLinksAfter?: { user: string; bytes: number };
  /** Deliveries held while paused, in order. */
  private heldFileTraffic?: (() => void)[];

  get fileLinksPaused() {
    return !!this.heldFileTraffic;
  }

  /** @internal Deliver now, or later if file links are paused. */
  deliverFile(fn: () => void) {
    if (this.heldFileTraffic) this.heldFileTraffic.push(fn);
    else setTimeout(fn, 0);
  }

  /** @internal */
  pauseFileLinks() {
    this.heldFileTraffic ??= [];
  }

  resumeFileLinks() {
    const held = this.heldFileTraffic ?? [];
    this.heldFileTraffic = undefined;
    for (const fn of held) setTimeout(fn, 0);
  }

  /** Cuts every open file link of a user, as a network drop would. */
  cutFileLinksOf(userId: string) {
    for (const l of [...this.fileLinks])
      if (l.self.startsWith(`${userId}.`) || l.remote.startsWith(`${userId}.`)) l.close();
  }

  /** Whether `member` can't reach `host`'s relay directly. */
  blocksDirect(member: string, host: string) {
    const user = (p: string) => p.split('.')[0]!;
    if (this.blocked.has(user(member)) || this.blocked.has(user(host))) return true;
    return user(member) !== user(host) && this.unreachable.has(user(host));
  }

  find(key: string) {
    return this.relays.get(key);
  }

  /** The host's relay process dies; the app itself (and its link) carry on. */
  crashRelayProcessOf(userId: string) {
    // The relays running now: those started again from onFailed live on.
    for (const [key, relay] of [...this.relays]) {
      if (key.split('|')[2]!.startsWith(`${userId}.`)) {
        this.relays.delete(key);
        relay.close();
        this.onFailed.get(key)?.('relay process exited');
      }
    }
  }

  /** Simulate the host vanishing without a goodbye (crash, network loss). */
  killRelaysOf(userId: string) {
    for (const [key, relay] of [...this.relays]) {
      if (key.split('|')[2]!.startsWith(`${userId}.`)) {
        this.relays.delete(key);
        relay.close();
      }
    }
  }
}

class FakeRelay {
  peers = new Map<
    string,
    { t: FakeTransport; state: PeerState; media?: boolean; watching?: string[]; sent?: string }
  >();
  constructor(
    readonly host: string,
    private readonly members: () => string[],
    private readonly net: FakeRelayNetwork,
  ) {}

  attach(t: FakeTransport): boolean {
    if (!this.members().includes(t.userId)) return false;
    const others = [...this.peers.values()];
    this.peers.set(t.userId, { t, state: { id: t.userId, muted: false, deafened: false } });
    const video = t.slots > 0 && !this.net.noVideoHosts.has(this.host.split('.')[0]!);
    t.deliver({
      t: 'hello',
      you: t.userId,
      host: this.host,
      peers: others.map((o) => o.state),
      slots: t.slots,
      ...(video ? { media: { video: VIDEO_SLOTS, audio: SCREEN_AUDIO_SLOTS } } : {}),
    });
    for (const o of others) o.t.deliver({ t: 'peer_join', peer: this.peers.get(t.userId)!.state });
    return true;
  }

  detach(t: FakeTransport) {
    const userId = t.userId;
    if (this.peers.get(userId)?.t !== t) return;
    this.peers.delete(userId);
    for (const o of this.peers.values()) o.t.deliver({ t: 'peer_leave', peer: userId });
    this.assign();
  }

  /** Video added to a member's connection. */
  mediaOn(t: FakeTransport) {
    const me = this.peers.get(t.userId);
    if (me?.t === t) me.media = true;
  }

  /** Like the real relay: each member gets the live streams it asked for, up to its room. */
  private assign() {
    const live = (s: string) => {
      const p = this.peers.get(streamIds.peer(s));
      return !!p?.media && (streamIds.kind(s) === 'camera' ? !!p.state.camera : !!p.state.screen);
    };
    for (const [id, p] of this.peers) {
      if (!p.media) continue;
      const asks = (p.watching ?? []).filter((s) => live(s) && streamIds.peer(s) !== id);
      const video = asks.slice(0, this.net.videoRoom);
      const audio = video.filter(
        (s) =>
          streamIds.kind(s) === 'screen' && this.peers.get(streamIds.peer(s))?.state.screen?.audio,
      );
      const msg: RelayToClient = {
        t: 'media',
        video: [...video, ...new Array(VIDEO_SLOTS - video.length).fill(null)],
        audio: [...audio, ...new Array(SCREEN_AUDIO_SLOTS).fill(null)].slice(0, SCREEN_AUDIO_SLOTS),
        paused: asks.slice(this.net.videoRoom),
      };
      const key = JSON.stringify(msg);
      if (key === p.sent) continue;
      p.sent = key;
      p.t.deliver(msg);
    }
  }

  route(sender: FakeTransport, msg: ClientToRelay) {
    // Like the real relay, a message belongs to the connection it came on:
    // one from a connection since replaced (same device) goes nowhere.
    const from = sender.userId;
    const me = this.peers.get(from);
    if (me?.t !== sender) return;
    if (msg.t === 'state') {
      const { t: _, camera, screen, ...state } = msg;
      me.state = {
        id: from,
        ...state,
        ...(camera && me.media ? { camera } : {}),
        ...(screen && me.media ? { screen } : {}),
      };
      for (const o of this.peers.values()) o.t.deliver({ t: 'peer_state', peer: me.state });
      this.assign();
    } else if (msg.t === 'watch') {
      me.watching = msg.streams;
      this.assign();
    } else if (msg.t === 'ping') {
      this.peers.get(from)?.t.deliver({ t: 'pong', ts: msg.ts });
    } else if (msg.t === 'bcast') {
      for (const [id, o] of this.peers)
        if (id !== from) o.t.deliver({ t: 'msg', from, direct: false, d: msg.d });
    } else if (msg.t === 'direct' && msg.to) {
      const drop = this.net.dropDirectFrom;
      if (drop && drop.count > 0 && from.startsWith(`${drop.user}.`)) {
        drop.count--;
        return;
      }
      this.peers.get(msg.to)?.t.deliver({ t: 'msg', from, direct: true, d: msg.d });
    }
  }

  close() {
    for (const o of this.peers.values()) o.t.drop('host went away');
    this.peers.clear();
  }
}

/** werift's SCTP max-message-size. */
const MAX_MESSAGE_SIZE = 65536;

class FakeTransport extends Emitter<RelayLinkEvents> implements RelayTransport {
  private relay?: FakeRelay;
  private closed = false;

  constructor(
    private readonly net: FakeRelayNetwork,
    private readonly key: string,
    readonly userId: string,
    private readonly viaTurn = false,
    readonly slots = 0,
  ) {
    super();
  }

  async addMedia() {
    if (!this.isOpen) throw new Error('not connected');
    this.relay!.mediaOn(this);
    setTimeout(() => !this.closed && this.emit('media', undefined), 2);
  }

  async setOutgoing(kind: string, track: unknown) {
    this.net.outgoing.set(`${this.userId}:${kind}`, track);
  }

  /** Like ICE: a direct path when one exists, even with the server relay on offer. */
  async route() {
    if (!this.isOpen) return null;
    const direct = !this.net.blocksDirect(this.userId, this.relay!.host);
    return direct ? ('lan' as const) : ('relay' as const);
  }

  get isOpen() {
    return !!this.relay && !this.closed;
  }

  async connect() {
    this.emit('progress', { step: 'offer' });
    // Like a real offer, give the host a moment to learn it was elected.
    for (let i = 0; i < 100 && !this.closed; i++) {
      const relay = this.net.find(this.key);
      if (relay) this.emit('progress', { step: 'answer' });
      if (relay && !this.viaTurn && this.net.blocksDirect(this.userId, relay.host)) {
        // Like ICE with no working candidate pair.
        setTimeout(() => this.drop('connection failed'), 30);
        return;
      }
      if (relay) {
        this.relay = relay;
        setTimeout(() => {
          if (this.closed) return;
          this.emit('progress', { step: 'path' });
          if (!relay.attach(this)) return this.drop('not admitted');
          this.emit('open', undefined);
        }, 5);
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!this.closed) this.drop('host relay not found');
  }

  async handleSignal(_data: SignalData) {}

  deliver(msg: RelayToClient) {
    setTimeout(() => !this.closed && this.emit('message', msg), 1);
  }

  send(msg: { t: string }) {
    if (!this.isOpen) return false;
    // Like werift's data channel, which the host relay uses.
    const size = JSON.stringify(msg).length;
    if (size > MAX_MESSAGE_SIZE)
      throw new Error(`max-message-size exceeded: ${size} > ${MAX_MESSAGE_SIZE}`);
    const relay = this.relay!;
    setTimeout(() => relay.route(this, msg as ClientToRelay), 1);
    return true;
  }

  drop(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.relay?.detach(this);
    this.emit('failed', { reason });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.relay?.detach(this);
    this.emit('closed', undefined);
  }
}

let fileLinkSeq = 0;

class FakeFileLink implements FileLink {
  readonly ready: Promise<FileLinkChannel>;
  private resolve!: (c: FileLinkChannel) => void;
  private reject!: (e: Error) => void;
  channel?: FakeFileChannel;
  private closed = false;

  constructor(
    private readonly net: FakeRelayNetwork,
    readonly self: string,
    readonly remote: string,
  ) {
    this.ready = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    this.ready.catch(() => {});
  }

  async createOffer() {
    const token = `offer-${++fileLinkSeq}`;
    this.net.pendingFileLinks.set(token, this);
    return token;
  }

  async acceptOffer(sdp: string) {
    const offerer = this.net.pendingFileLinks.get(sdp);
    if (!offerer) throw new Error('unknown offer');
    this.net.pendingFileLinks.delete(sdp);
    setTimeout(() => {
      if (this.closed || offerer.closed) return;
      if (!this.net.directPossible(this.self, offerer.self)) {
        setTimeout(() => {
          offerer.fail('no direct path');
          this.fail('no direct path');
        }, 30);
        return;
      }
      const a = new FakeFileChannel(this.net, offerer.self, this.self);
      const b = new FakeFileChannel(this.net, this.self, offerer.self);
      a.peer = b;
      b.peer = a;
      offerer.channel = a;
      this.channel = b;
      this.net.fileLinks.add(offerer);
      this.net.fileLinks.add(this);
      this.net.fileLinkLog.push([offerer.self.split('.')[0]!, this.self.split('.')[0]!]);
      offerer.resolve(a);
      this.resolve(b);
    }, 20);
    return `answer-${sdp}`;
  }

  async acceptAnswer(_sdp: string) {}

  private fail(reason: string) {
    this.reject(new Error(reason));
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.net.fileLinks.delete(this);
    this.reject(new Error('closed'));
    this.channel?.close();
  }
}

class FakeFileChannel
  extends Emitter<{ message: string | Uint8Array; close: void; drained: void }>
  implements FileLinkChannel
{
  peer?: FakeFileChannel;
  bufferedAmount = 0;
  private closed = false;

  constructor(
    private readonly net: FakeRelayNetwork,
    readonly self: string,
    readonly remote: string,
  ) {
    super();
  }

  send(data: string | Uint8Array) {
    if (this.closed || !this.peer) return false;
    const size = typeof data === 'string' ? data.length : data.length;
    // Like werift's data channel.
    if (size > MAX_MESSAGE_SIZE)
      throw new Error(`max-message-size exceeded: ${size} > ${MAX_MESSAGE_SIZE}`);
    const copy = typeof data === 'string' ? data : data.slice();
    if (typeof copy !== 'string' && copy[0] === 2) {
      const holder = this.self.split('.')[0]!;
      const sent = (this.net.fileBytesFrom.get(holder) ?? 0) + size - 9;
      this.net.fileBytesFrom.set(holder, sent);
      const cut = this.net.cutFileLinksAfter;
      if (cut?.user === holder && sent >= cut.bytes) {
        this.net.cutFileLinksAfter = undefined;
        this.net.bytesAtCut = sent;
        setTimeout(() => this.net.cutFileLinksOf(holder), 0);
      }
      const pause = this.net.pauseFileLinksAfter;
      if (pause?.user === holder && sent >= pause.bytes) {
        this.net.pauseFileLinksAfter = undefined;
        this.net.pauseFileLinks();
      }
    }
    this.bufferedAmount += size;
    const peer = this.peer;
    this.net.deliverFile(() => {
      this.bufferedAmount -= size;
      if (this.bufferedAmount === 0) this.emit('drained', undefined);
      if (!this.closed && !peer.closed) peer.emit('message', copy);
    });
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', undefined);
    this.peer?.close();
  }
}
