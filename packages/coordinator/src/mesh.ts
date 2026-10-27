import { WebSocket } from 'ws';
import {
  acceptChannel,
  answerChannel,
  createChannelKeys,
  keyMatchesUserId,
  randomId,
  SecureChannel,
  sign,
  verifyPayload,
  type ChannelKeys,
} from '@crocodile/crypto';
import {
  concatBytes,
  FedFrameSchema,
  LIMITS,
  PROTOCOL_VERSION,
  ServerInfo,
  SIG_DOMAIN,
  type FedFlood,
  type FedFrame,
  type FedRequest,
  type SignedRecord,
} from '@crocodile/protocol';
import type { Coordinator } from './coordinator';
import { fnv1a } from './election';
import { RateLimiter, RpcFailure, chunkByBytes, sendJson, toWsUrl } from './util';

interface Link {
  ws: WebSocket;
  initiator: boolean;
  url?: string;
  challenge: string;
  /** What the peer claimed in its hello; not trusted until `authed`. */
  peer?: ServerInfo;
  /** Who the peer proved to be. Set once, when the link authenticates. */
  peerId?: string;
  peerProtocol?: number;
  authed: boolean;
  replaced: boolean;
  /** We closed it because it had nothing to do. */
  idle: boolean;
  syncing: boolean;
  syncDone: boolean;
  sentUpTo: number;
  alive: boolean;
  /** Last frame that was more than overlay chatter. */
  lastUsed: number;
  /** Our fresh key-exchange offer for this link. */
  channelKeys: ChannelKeys;
  peerOffer?: { x25519: string; mlkem: string };
  /** Secret from answering the peer's offer. */
  answeredSecret?: Uint8Array;
  channel?: SecureChannel;
  /** Incoming record batches, applied one after another. */
  inbox: Promise<void>;
  /** Requests this peer may make of us. */
  limiter: RateLimiter;
}

export interface MeshConfig {
  /** Up to this many known servers, every server links to every other. */
  fullMeshMax: number;
  /** A direct link with nothing to do is closed after this long. */
  idleMs: number;
  /** How often the overlay is checked. */
  maintainMs: number;
}

export const defaultMeshConfig: MeshConfig = {
  fullMeshMax: 16,
  idleMs: 5 * 60_000,
  maintainMs: 5_000,
};

const SYNC_BATCH = 500;
const PING_INTERVAL_MS = 20_000;
/** Frames waiting for a direct link to come up. */
const QUEUE_MAX = 2000;
const QUEUE_MS = 15_000;
const FLOOD_HOPS = 16;
/** Close code for a link closed for idleness, so the other side doesn't think we died. */
const IDLE_CLOSE = 4000;
/** Servers we keep track of, so made-up identities can't fill our memory. */
const KNOWN_MAX = 20_000;
/** A server we failed to reach three times is skipped for this long, then tried again. */
const UNREACHABLE_COOLDOWN_MS = 5 * 60_000;

/** Frames that keep a direct link in use (overlay chatter doesn't). */
const USEFUL = new Set([
  'req',
  'res',
  'records',
  'rec_push',
  'route',
  'session_op',
  'session_op_res',
  'link_answer',
]);

/**
 * Links between coordination servers (docs/MESH.md). Every link is mutually
 * authenticated with server identity keys and encrypted. A server keeps a few
 * overlay links (all servers in a small network; ring neighbours and fingers
 * in a large one) and opens direct links to whichever server it needs to talk
 * to. Owners of a record copy it to each other; when a link comes up each
 * side streams what the other owns and hasn't seen (per-peer seq cursor).
 */
export class Mesh {
  private links = new Map<string, Link>();
  private pendingLinks = new Set<Link>();
  private known = new Map<string, ServerInfo>();
  private dialing = new Map<
    string,
    { timer?: ReturnType<typeof setTimeout>; attempts: number; failedAt?: number }
  >();
  private queued = new Map<string, { frame: FedFrame; at: number }[]>();
  private requests = new Map<
    string,
    {
      server: string;
      /** The link it went out on; unset while it waits for one. */
      link?: Link;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private floodSeen = new Map<string, number>();
  private pingTimer?: ReturnType<typeof setInterval>;
  private maintainTimer?: ReturnType<typeof setInterval>;
  private maintainSoon?: ReturnType<typeof setTimeout>;
  private staticUrls: string[] = [];
  private closed = false;

  constructor(
    private readonly hub: Coordinator,
    readonly config: MeshConfig = defaultMeshConfig,
  ) {}

  private get selfId() {
    return this.hub.info.id;
  }

  start(staticPeers: string[]) {
    this.staticUrls = staticPeers.filter((u) => u !== this.hub.info.url);
    for (const url of this.staticUrls) this.ensureDial(url);
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    this.maintainTimer = setInterval(() => this.maintain(), this.config.maintainMs);
    this.maintainTimer.unref?.();
  }

  peerIds() {
    return [...this.links.keys()];
  }

  peers(): ServerInfo[] {
    return [...this.links.values()].map((l) => l.peer!);
  }

  knownServers(): ServerInfo[] {
    return [...this.known.values()];
  }

  /** Learn about servers (from the directory, gossip or beacons). */
  addKnown(servers: ServerInfo[]) {
    let added = false;
    for (const s of servers) {
      const parsed = ServerInfo.safeParse(s);
      if (!parsed.success || s.id === this.selfId || !keyMatchesUserId(s.key, s.id)) continue;
      const before = this.known.get(s.id);
      if (!before && this.known.size >= KNOWN_MAX) continue;
      if (!before || before.url !== s.url) added = true;
      this.known.set(s.id, parsed.data);
    }
    if (added) this.scheduleMaintain();
  }

  // -------------------------------------------------------------------------
  // Overlay
  // -------------------------------------------------------------------------

  /** Servers we keep a link to. */
  desired(): Set<string> {
    const out = new Set<string>();
    for (const url of this.staticUrls) {
      for (const s of this.known.values()) if (s.url === url) out.add(s.id);
    }
    const ids = [...this.known.keys()].filter((id) => this.links.has(id) || !this.unreachable(id));
    if (ids.length + 1 <= this.config.fullMeshMax) {
      for (const id of ids) out.add(id);
      return out;
    }
    // A ring of server ids: neighbours on both sides plus fingers at halving
    // distances, so every server is a few hops from every other and no group
    // of servers can drift apart while the ring holds.
    const ring = [...ids, this.selfId].sort((a, b) => fnv1a(a) - fnv1a(b) || (a < b ? -1 : 1));
    const n = ring.length;
    const i = ring.indexOf(this.selfId);
    for (const d of [1, 2]) {
      out.add(ring[(i + d) % n]!);
      out.add(ring[(i - d + n) % n]!);
    }
    for (let step = Math.floor(n / 2); step > 2; step = Math.floor(step / 2))
      out.add(ring[(i + step) % n]!);
    out.delete(this.selfId);
    return out;
  }

  private unreachable(id: string) {
    const url = this.known.get(id)?.url;
    const d = url ? this.dialing.get(url) : undefined;
    return !!d && d.attempts >= 3 && Date.now() - (d.failedAt ?? 0) < UNREACHABLE_COOLDOWN_MS;
  }

  private scheduleMaintain() {
    if (this.maintainSoon || this.closed) return;
    this.maintainSoon = setTimeout(() => {
      this.maintainSoon = undefined;
      this.maintain();
    }, 50);
    this.maintainSoon.unref?.();
  }

  /** Dial missing overlay links; close direct links that have gone quiet. */
  maintain() {
    if (this.closed) return;
    const desired = this.desired();
    for (const id of desired) {
      const s = this.known.get(id);
      if (s && !this.links.has(id)) this.ensureDial(s.url);
    }
    const now = Date.now();
    for (const [id, link] of this.links) {
      if (
        link.initiator &&
        !desired.has(id) &&
        !this.staticUrls.includes(link.url ?? '') &&
        now - link.lastUsed > this.config.idleMs &&
        ![...this.requests.values()].some((r) => r.server === id)
      ) {
        link.idle = true;
        link.ws.close(IDLE_CLOSE, 'idle');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private send(link: Link, frame: FedFrame): boolean {
    if (!link.channel) return false;
    if (USEFUL.has(frame.t)) link.lastUsed = Date.now();
    return sendJson(link.ws, link.channel.seal(frame));
  }

  /**
   * Send to one server, opening a direct link if there is none. Returns false
   * only for a server we don't know how to reach.
   */
  sendTo(serverId: string, frame: FedFrame): boolean {
    if (serverId === this.selfId) return false;
    const link = this.links.get(serverId);
    // A link that is closing (idle, or the other side went) loses what we
    // write to it: queue instead, and dial again once it has closed.
    if (link?.channel && link.ws.readyState === link.ws.OPEN) return this.send(link, frame);
    const s = this.known.get(serverId);
    if (!s) return false;
    const now = Date.now();
    const q = (this.queued.get(serverId) ?? []).filter((e) => now - e.at < QUEUE_MS);
    if (q.length >= QUEUE_MAX) q.shift();
    q.push({ frame, at: now });
    this.queued.set(serverId, q);
    this.ensureDial(s.url);
    return true;
  }

  /** Ask one server something; rejects if it doesn't answer in time. */
  request<T = unknown>(
    serverId: string,
    m: FedRequest['m'],
    p: unknown,
    timeoutMs = 6000,
  ): Promise<T> {
    const rid = randomId(8);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(rid);
        reject(new RpcFailure('unavailable', `server ${serverId} did not answer`));
      }, timeoutMs);
      timer.unref?.();
      const link = this.links.get(serverId);
      const open = !!link?.channel && link.ws.readyState === link.ws.OPEN;
      this.requests.set(rid, {
        server: serverId,
        ...(open ? { link } : {}),
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      if (!this.sendTo(serverId, { t: 'req', rid, m, p })) {
        clearTimeout(timer);
        this.requests.delete(rid);
        reject(new RpcFailure('unavailable', `server ${serverId} is unknown`));
      }
    });
  }

  /** Ask the first of several servers that answers. */
  async requestAny<T = unknown>(servers: string[], m: FedRequest['m'], p: unknown): Promise<T> {
    let last: unknown = new RpcFailure('unavailable', 'no server to ask');
    for (const id of servers) {
      try {
        return await this.request<T>(id, m, p);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }

  /**
   * Ask several servers at once. Resolves with every answer, once all have
   * answered or `graceMs` after the first; empty if none could answer.
   */
  gather<T = unknown>(
    servers: string[],
    m: FedRequest['m'],
    p: unknown,
    graceMs = 250,
  ): Promise<T[]> {
    if (servers.length === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      const got: T[] = [];
      let left = servers.length;
      let done = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        resolve(got);
      };
      for (const id of servers) {
        this.request<T>(id, m, p)
          .then((v) => {
            got.push(v);
            if (!grace && !done) grace = setTimeout(finish, graceMs);
          })
          .catch(() => {})
          .finally(() => {
            if (--left === 0) finish();
          });
      }
    });
  }

  /** Pass a frame to every link (except the one it came from). */
  forward(frame: FedFrame, except?: string) {
    for (const [id, link] of this.links) {
      if (id !== except && link.ws.readyState === link.ws.OPEN) this.send(link, frame);
    }
  }

  /** Send a frame to every server, through the overlay. */
  flood(f: FedFlood['f']) {
    const frame: FedFlood = { t: 'flood', id: randomId(10), origin: this.selfId, hops: 0, f };
    this.floodSeen.set(frame.id, Date.now());
    this.forward(frame);
  }

  private linkQueries = new Map<
    string,
    {
      resolve: (v: { peer: string; key: string; encKey: string } | undefined) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * Ask every other server whether it holds a device-link code. Only the one
   * that does answers (through the overlay, which is already connected), so
   * an unknown code takes the full wait to come back empty.
   */
  queryLink(code: string): Promise<{ peer: string; key: string; encKey: string } | undefined> {
    if (this.hub.membership.liveIds().length <= 1) return Promise.resolve(undefined);
    const qid = randomId(8);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.linkQueries.delete(qid);
        resolve(undefined);
      }, 5000);
      this.linkQueries.set(qid, { resolve, timer });
      this.flood({ t: 'link_query', qid, code });
    });
  }

  private onLinkAnswer(qid: string, found?: { peer: string; key: string; encKey: string }) {
    const q = this.linkQueries.get(qid);
    if (!q || !found) return;
    this.linkQueries.delete(qid);
    clearTimeout(q.timer);
    q.resolve(found);
  }

  // -------------------------------------------------------------------------
  // Link lifecycle
  // -------------------------------------------------------------------------

  private ensureDial(url: string) {
    if (this.closed || url === this.hub.info.url) return;
    for (const l of [...this.links.values(), ...this.pendingLinks]) {
      if (l.url === url || l.peer?.url === url) return;
    }
    const d = this.dialing.get(url);
    if (d?.timer) return;
    this.dial(url);
  }

  private dial(url: string) {
    const state = this.dialing.get(url) ?? { attempts: 0 };
    state.timer = undefined;
    this.dialing.set(url, state);
    let ws: WebSocket;
    try {
      ws = new WebSocket(toWsUrl(url, '/v1/federation'), {
        maxPayload: LIMITS.wsMessageMaxBytes * 8,
        handshakeTimeout: 10_000,
      });
    } catch {
      this.scheduleRedial(url);
      return;
    }
    ws.on('error', () => {});
    const link = this.setupLink(ws, true, url);
    ws.once('open', () => this.sendHello(link));
  }

  /** Whether we keep trying a URL: a static peer, or an overlay link. */
  private wantsUrl(url: string) {
    if (this.staticUrls.includes(url)) return true;
    const desired = this.desired();
    for (const s of this.known.values()) if (s.url === url && desired.has(s.id)) return true;
    return false;
  }

  private scheduleRedial(url: string) {
    if (this.closed) return;
    const state = this.dialing.get(url) ?? { attempts: 0 };
    state.attempts += 1;
    state.failedAt = Date.now();
    // Direct links aren't retried on their own: the next frame for them dials again.
    if (!this.wantsUrl(url) || (!this.isKnownUrl(url) && state.attempts > 5)) {
      state.timer = undefined;
      this.dialing.set(url, state);
      if (state.attempts > 5 && !this.isKnownUrl(url)) this.dialing.delete(url);
      return;
    }
    const delay =
      Math.min(60_000, 1000 * 2 ** Math.min(state.attempts, 6)) * (0.75 + Math.random() * 0.5);
    state.timer = setTimeout(() => this.dial(url), delay);
    state.timer.unref?.();
    this.dialing.set(url, state);
  }

  private isKnownUrl(url: string) {
    return [...this.known.values()].some((s) => s.url === url) || this.staticUrls.includes(url);
  }

  accept(ws: WebSocket) {
    ws.on('error', () => {});
    const link = this.setupLink(ws, false);
    this.sendHello(link);
  }

  private sendHello(link: Link) {
    sendJson(link.ws, {
      t: 'fed_hello',
      server: this.hub.info,
      challenge: link.challenge,
      channel: link.channelKeys.offer,
      protocol: PROTOCOL_VERSION,
    });
  }

  private setupLink(ws: WebSocket, initiator: boolean, url?: string): Link {
    const link: Link = {
      ws,
      initiator,
      url,
      challenge: randomId(16),
      authed: false,
      replaced: false,
      idle: false,
      syncing: false,
      syncDone: false,
      sentUpTo: 0,
      alive: true,
      lastUsed: Date.now(),
      channelKeys: createChannelKeys(),
      inbox: Promise.resolve(),
      limiter: new RateLimiter(500, 5000),
    };
    this.pendingLinks.add(link);
    const authTimer = setTimeout(() => {
      if (!link.authed) ws.terminate();
    }, 15_000);
    authTimer.unref?.();

    ws.on('pong', () => (link.alive = true));
    ws.on('message', (raw) => {
      // A link we have started to close says nothing more.
      if (ws.readyState !== ws.OPEN) return;
      let frame: FedFrame;
      try {
        frame = JSON.parse(raw.toString()) as FedFrame;
      } catch {
        ws.close(1003, 'bad json');
        return;
      }
      if (link.channel) {
        // After the handshake every frame is encrypted.
        const inner = frame.t === 'x' ? link.channel.open(frame) : undefined;
        if (inner === undefined) {
          ws.close(1008, 'bad frame');
          return;
        }
        frame = inner as FedFrame;
      } else if (frame.t !== 'fed_hello' && frame.t !== 'fed_auth') {
        return;
      }
      // Checked like client input: a malformed frame from a peer is dropped.
      const checked = FedFrameSchema.safeParse(frame);
      if (!checked.success) {
        this.hub.log.debug('dropped malformed federation frame', { t: String(frame.t) });
        return;
      }
      frame = checked.data as FedFrame;
      if (USEFUL.has(frame.t)) link.lastUsed = Date.now();
      try {
        this.onFrame(link, frame);
      } catch (err) {
        this.hub.log.warn('federation frame failed', { t: frame.t, err: String(err) });
      }
    });
    ws.on('close', (code) => {
      clearTimeout(authTimer);
      this.pendingLinks.delete(link);
      const peerId = link.peerId;
      if (peerId && this.links.get(peerId) === link) {
        this.links.delete(peerId);
        this.hub.log.info('mesh link down', { peer: peerId });
        this.failRequests(peerId, link);
        this.hub.membership.linkDown(peerId, !link.idle && code !== IDLE_CLOSE && !this.closed);
        // Frames queued while it was closing.
        const s = this.known.get(peerId);
        if (s && this.queued.get(peerId)?.length && !this.closed) this.ensureDial(s.url);
      }
      if (link.replaced || link.idle || code === IDLE_CLOSE || this.closed) return;
      const redialUrl = link.initiator ? url : link.peer?.url;
      if (redialUrl) this.scheduleRedial(redialUrl);
    });
    return link;
  }

  /** Requests sent on a link that went away won't be answered; queued ones still may be. */
  private failRequests(serverId: string, link: Link) {
    for (const [rid, r] of this.requests) {
      if (r.server !== serverId || r.link !== link) continue;
      clearTimeout(r.timer);
      this.requests.delete(rid);
      r.reject(new RpcFailure('unavailable', `lost the link to server ${serverId}`));
    }
  }

  private onFrame(link: Link, frame: FedFrame) {
    if (frame.t === 'fed_hello' || frame.t === 'fed_auth') {
      // Who the peer is gets settled once. A second hello, before or after
      // authenticating, would let it act as a server it did not prove to be.
      if (link.authed || (frame.t === 'fed_hello' && link.peer)) {
        link.ws.close(1008, `unexpected ${frame.t}`);
        return;
      }
    }
    if (frame.t === 'fed_hello') {
      const parsed = ServerInfo.safeParse(frame.server);
      if (
        !parsed.success ||
        !keyMatchesUserId(frame.server.key, frame.server.id) ||
        frame.server.id === this.selfId
      ) {
        link.ws.close(1008, 'invalid server identity');
        return;
      }
      if ((frame.protocol ?? 1) < PROTOCOL_VERSION) {
        this.hub.log.warn('server runs an older protocol; update it to link', {
          peer: frame.server.id,
          url: frame.server.url,
          protocol: frame.protocol ?? 1,
        });
        link.replaced = true;
        link.ws.close(1008, `protocol ${PROTOCOL_VERSION} required`);
        return;
      }
      link.peer = parsed.data;
      link.peerProtocol = frame.protocol;
      link.peerOffer = frame.channel;
      let answer: { epk: string; kem: string };
      try {
        const res = answerChannel(frame.channel);
        answer = res.answer;
        link.answeredSecret = res.secret;
      } catch {
        link.ws.close(1008, 'bad channel offer');
        return;
      }
      const sig = sign(this.hub.identity, SIG_DOMAIN.federation, {
        challenge: frame.challenge,
        from: this.selfId,
        to: link.peer.id,
        offer: link.channelKeys.offer,
        answer,
      });
      sendJson(link.ws, { t: 'fed_auth', answer, sig, cursor: this.cursor(link.peer.id) });
      return;
    }
    if (frame.t === 'fed_auth') {
      if (!link.peer || !link.answeredSecret || !link.peerOffer) return;
      const ok = verifyPayload(
        link.peer.key,
        SIG_DOMAIN.federation,
        {
          challenge: link.challenge,
          from: link.peer.id,
          to: this.selfId,
          offer: link.peerOffer,
          answer: frame.answer,
        },
        frame.sig,
      );
      if (!ok) {
        link.ws.close(1008, 'bad federation signature');
        return;
      }
      let accepted: Uint8Array;
      try {
        accepted = acceptChannel(link.channelKeys, frame.answer);
      } catch {
        link.ws.close(1008, 'bad channel answer');
        return;
      }
      // Both directions' secrets, ordered by server id so both sides agree.
      const self = this.selfId;
      const lower = self < link.peer.id;
      const secret = lower
        ? concatBytes(accepted, link.answeredSecret)
        : concatBytes(link.answeredSecret, accepted);
      const ctx = lower ? `${self}|${link.peer.id}` : `${link.peer.id}|${self}`;
      link.channel = new SecureChannel(secret, ctx, lower);
      this.onAuthed(link, frame.cursor);
      return;
    }
    if (!link.authed || !link.peerId) return;
    const peerId = link.peerId;
    switch (frame.t) {
      case 'records': {
        const { items, upTo } = frame;
        link.inbox = link.inbox
          .then(() => this.hub.dist.onReplicated(items, peerId))
          .then(() => {
            if (upTo) this.setCursor(peerId, upTo);
          })
          .catch((err) => this.hub.log.warn('replication failed', { err: String(err) }));
        return;
      }
      case 'rec_push':
        void this.hub.dist.onPush(frame.record);
        return;
      case 'beacon':
        if (this.hub.membership.onBeacon(frame)) this.forward(frame, peerId);
        return;
      case 'presence':
        if (this.hub.presence.applyRemote(frame)) this.forward(frame, peerId);
        return;
      case 'voice':
        if (this.hub.sessions.applyRemoteVoice(frame)) this.forward(frame, peerId);
        return;
      case 'flood':
        this.onFlood(frame, peerId);
        return;
      case 'req':
        if (!link.limiter.take()) {
          this.send(link, {
            t: 'res',
            rid: frame.rid,
            err: { code: 'rate_limited', message: 'too many requests' },
          });
          return;
        }
        this.hub.dist
          .handleRequest(peerId, frame.m, frame.p)
          .then((ok) => this.send(link, { t: 'res', rid: frame.rid, ok }))
          .catch((err) =>
            this.send(link, {
              t: 'res',
              rid: frame.rid,
              err: {
                code: err instanceof RpcFailure ? err.code : 'internal',
                message: err instanceof Error ? err.message : String(err),
              },
            }),
          );
        return;
      case 'res': {
        const r = this.requests.get(frame.rid);
        if (!r || r.server !== peerId) return;
        clearTimeout(r.timer);
        this.requests.delete(frame.rid);
        if (frame.err)
          r.reject(new RpcFailure(frame.err.code as RpcFailure['code'], frame.err.message));
        else r.resolve(frame.ok);
        return;
      }
      case 'route': {
        // Only events servers route (ROUTED_EVENTS); a session's state only
        // from the server that owns it.
        if (frame.ev === 'session') {
          const state = (frame.d as { state?: { id?: unknown } })?.state;
          if (typeof state?.id !== 'string' || this.hub.sessions.ownerOf(state.id) !== peerId)
            return;
        }
        this.hub.deliverLocal(frame.to, frame.ev as never, frame.d as never);
        return;
      }
      case 'session_op':
        this.hub.sessions.handleRemoteOp(peerId, frame);
        return;
      case 'session_op_res':
        this.hub.sessions.handleRemoteResult(frame.opId, frame.ok, frame.err);
        return;
      case 'servers':
        this.addKnown(frame.servers);
        return;
      case 'ping':
        this.send(link, { t: 'pong' });
        return;
      case 'link_answer':
        this.onLinkAnswer(frame.qid, frame.found);
        return;
    }
  }

  private onFlood(frame: FedFlood, from: string) {
    if (this.floodSeen.has(frame.id) || frame.origin === this.selfId) return;
    const now = Date.now();
    this.floodSeen.set(frame.id, now);
    if (this.floodSeen.size > 20_000) {
      for (const [id, at] of this.floodSeen) if (now - at > 10 * 60_000) this.floodSeen.delete(id);
    }
    if (frame.hops < FLOOD_HOPS) this.forward({ ...frame, hops: frame.hops + 1 }, from);
    const f = frame.f;
    switch (f.t) {
      case 'mail_query':
        this.hub.mailbox.onQuery(frame.origin, f.peer, f.proof);
        return;
      case 'mail_ack':
        this.hub.mailbox.onRemoteAck(f.peer, f.ids, f.proof);
        return;
      case 'link_query': {
        const found = this.hub.findLink(f.code);
        if (!found) return;
        found.claimedBy = `remote:${frame.origin}`;
        this.flood({
          t: 'link_answer',
          qid: f.qid,
          found: { peer: found.peer, key: found.key, encKey: found.encKey },
        });
        return;
      }
      case 'link_answer':
        this.onLinkAnswer(f.qid, f.found);
        return;
    }
  }

  private onAuthed(link: Link, cursor: number) {
    const peer = link.peer!;
    link.peerId = peer.id;
    link.authed = true;
    this.pendingLinks.delete(link);
    const existing = this.links.get(peer.id);
    if (existing) {
      // Both sides dialled each other: keep the link dialled by the lower id.
      const keeperInitiator = this.selfId < peer.id ? this.selfId : peer.id;
      const initiatorOf = (l: Link) => (l.initiator ? this.selfId : peer.id);
      if (initiatorOf(link) !== keeperInitiator) {
        link.replaced = true;
        link.ws.close(1000, 'duplicate link');
        this.flushQueue(peer.id, existing);
        return;
      }
      existing.replaced = true;
      this.links.delete(peer.id);
      existing.ws.close(1000, 'duplicate link');
    }
    this.links.set(peer.id, link);
    this.known.set(peer.id, peer);
    this.dialing.delete(peer.url);
    if (link.url) this.dialing.delete(link.url);
    this.hub.log.info('mesh link up', { peer: peer.id, name: peer.name, url: peer.url });
    this.hub.membership.linkUp(peer.id);

    this.send(link, { t: 'servers', servers: [this.hub.info, ...this.knownServers()] });
    for (const b of this.hub.membership.freshBeacons()) this.send(link, b);
    for (const p of this.hub.presence.snapshot()) this.send(link, p);
    for (const v of this.hub.sessions.voiceFrames()) this.send(link, v);
    this.flushQueue(peer.id, link);
    link.sentUpTo = Math.max(0, Math.min(cursor, this.hub.records.store.latestSeq()));
    void this.pump(link);
    this.scheduleMaintain();
  }

  private flushQueue(serverId: string, link: Link) {
    const q = this.queued.get(serverId);
    if (!q) return;
    this.queued.delete(serverId);
    const now = Date.now();
    for (const e of q) {
      if (now - e.at >= QUEUE_MS) continue;
      if (e.frame.t === 'req') {
        const r = this.requests.get(e.frame.rid);
        if (r) r.link = link;
      }
      this.send(link, e.frame);
    }
  }

  /** Streams the records the peer owns that it hasn't seen, respecting backpressure. */
  private async pump(link: Link) {
    if (link.syncing) return;
    link.syncing = true;
    const store = this.hub.records.store;
    const peerId = link.peerId!;
    try {
      while (link.ws.readyState === link.ws.OPEN && link.sentUpTo < store.latestSeq()) {
        const batch = store.since(link.sentUpTo, SYNC_BATCH);
        if (batch.length === 0) {
          link.sentUpTo = store.latestSeq();
          break;
        }
        const upTo = batch[batch.length - 1]!.seq;
        const m = this.hub.membership;
        // Owner by the current view or the settled one: while they differ, a
        // record the peer owns in either must not be skipped (the cursor moves on).
        const items = batch.filter(
          (i) => m.view.owns(peerId, i.record) || m.settled.owns(peerId, i.record),
        );
        // Split so no frame is over the receiver's size limit (records reach 400 KiB).
        const chunks = chunkByBytes(items);
        if (!chunks.length) chunks.push([]);
        for (const [i, chunk] of chunks.entries()) {
          const last = i === chunks.length - 1;
          this.send(link, { t: 'records', items: chunk, upTo: last ? upTo : chunk.at(-1)!.seq });
        }
        link.sentUpTo = upTo;
        while (link.ws.readyState === link.ws.OPEN && link.ws.bufferedAmount > 4 * 1024 * 1024) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      link.syncDone = true;
    } finally {
      link.syncing = false;
    }
  }

  /**
   * A write we accepted: copy it to the other servers that own it (and to the
   * owners of its previous version, which drop it once they don't own it).
   */
  onRecord(
    record: SignedRecord,
    seq: number,
    origin: string | null,
    previous: SignedRecord | null,
  ) {
    const { view, settled } = this.hub.membership;
    const targets = new Set([...view.placement(record), ...settled.placement(record)]);
    if (previous) for (const id of view.placement(previous)) targets.add(id);
    targets.delete(this.selfId);
    for (const id of targets) {
      const link = this.links.get(id);
      if (!link) {
        // The catch-up stream sends it once the link is up.
        const s = this.known.get(id);
        if (s && id !== origin) this.ensureDial(s.url);
        continue;
      }
      if (!link.syncDone || seq <= link.sentUpTo) continue;
      if (id !== origin) this.send(link, { t: 'records', items: [{ seq, record }], upTo: seq });
      link.sentUpTo = seq;
    }
  }

  /** Send records to a server that has just become an owner (no cursor involved). */
  async handOver(serverId: string, records: SignedRecord[]) {
    const items = records.map((record) => ({ seq: 0, record }));
    for (const chunk of chunkByBytes(items, undefined, 200)) {
      this.sendTo(serverId, { t: 'records', items: chunk, upTo: 0 });
      const link = this.links.get(serverId);
      while (
        link &&
        link.ws.readyState === link.ws.OPEN &&
        link.ws.bufferedAmount > 4 * 1024 * 1024
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }

  private cursor(peerId: string): number {
    return Number(this.hub.records.store.getMeta(`cursor:${peerId}`) ?? 0);
  }

  private setCursor(peerId: string, seq: number) {
    if (seq > this.cursor(peerId)) this.hub.records.store.setMeta(`cursor:${peerId}`, String(seq));
  }

  private heartbeat() {
    for (const link of this.links.values()) {
      if (!link.alive) {
        link.ws.terminate();
        continue;
      }
      link.alive = false;
      try {
        link.ws.ping();
      } catch {
        /* closed */
      }
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    clearInterval(this.maintainTimer);
    clearTimeout(this.maintainSoon);
    for (const d of this.dialing.values()) if (d.timer) clearTimeout(d.timer);
    for (const r of this.requests.values()) clearTimeout(r.timer);
    for (const link of [...this.links.values(), ...this.pendingLinks]) {
      link.replaced = true;
      link.ws.terminate();
    }
  }
}
