import type { WebSocket } from 'ws';
import {
  acceptChannel,
  createChannelKeys,
  randomId,
  SecureChannel,
  sign,
  toPublicServerInfo,
  userIdFromKey,
  verifyPayload,
  type ChannelKeys,
} from '@crocodile/crypto';
import {
  ClientAuth,
  RpcParams,
  SIG_DOMAIN,
  helloFullPayload,
  peerIds,
  recordKey,
  type LinkBox,
  type SealedBox,
  type Platform,
  type RpcMethod,
  type ServerEvents,
  type ServerFrame,
  type SignedRecord,
  type MailProof,
} from '@crocodile/protocol';
import type { Coordinator } from './coordinator';
import type { ClientHandle, OwnStatus } from './presence';
import { RateLimiter, RpcFailure, sendJson } from './util';

/** Record prefixes, and users' presence, one connection may follow. */
const MAX_SUBSCRIPTIONS = 20_000;

let nextConnId = 1;

/**
 * One client WebSocket (one device). The server greets with a signed hello
 * carrying fresh hybrid (X25519 + ML-KEM-768) channel keys; the client
 * answers with its half and a signature binding its identity, device and
 * channel. Every later frame is AES-256-GCM encrypted and length-padded.
 */
export class ClientConnection implements ClientHandle {
  readonly connId = nextConnId++;
  userId = '';
  deviceId = '';
  peer = '';
  publicKey = '';
  /** X25519 key of this identity (only used for device linking). */
  encKey = '';
  platform: Platform = 'desktop';
  connectedAt = Date.now();
  status: OwnStatus = 'online';
  statusText?: string;
  subscriptions = new Set<string>();
  presenceWatch = new Set<string>();
  voiceWatch = new Set<string>();

  private authed = false;
  private channel?: SecureChannel;
  private readonly channelKeys: ChannelKeys = createChannelKeys();
  private readonly challenge = randomId(16);
  private readonly limiter = new RateLimiter(30, 120);
  private readonly writeLimiter = new RateLimiter(5, 40);
  private readonly linkLimiter = new RateLimiter(0.2, 5);
  private readonly mailLimiter = new RateLimiter(1, 30);
  private alive = true;
  private pingTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly hub: Coordinator,
    private readonly ws: WebSocket,
    /** Our address as this client reached it, for STUN and TURN URLs. */
    readonly via?: string,
  ) {
    const time = Date.now();
    const info = hub.info;
    const channel = this.channelKeys.offer;
    const hello = {
      t: 'hello' as const,
      server: info,
      challenge: this.challenge,
      stun: hub.stunUrls(via),
      time,
      channel,
      features: {
        relay: hub.config.relay.enabled && !!hub.turn,
        ...(hub.config.mailbox.enabled ? { mailbox: { ttlMs: hub.mailbox.ttlMs } } : {}),
      },
      ...hub.operatorInfo(),
    };
    this.frame({
      ...hello,
      sig: sign(hub.identity, SIG_DOMAIN.serverHello, {
        challenge: this.challenge,
        server: info.id,
        time,
        channel,
      }),
      sigFull: sign(hub.identity, SIG_DOMAIN.serverHelloFull, helloFullPayload(hello)),
    });
    const authTimer = setTimeout(() => {
      if (!this.authed) ws.close(4001, 'authentication timeout');
    }, 15_000);
    authTimer.unref?.();

    ws.on('message', (raw) => {
      if (!this.limiter.take()) {
        this.frame({ t: 'error', err: { code: 'rate_limited', message: 'slow down' } });
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(1003, 'invalid json');
        return;
      }
      if (!this.authed) return this.onAuth(msg);
      const f = msg as { t?: unknown; n?: unknown; c?: unknown };
      if (f.t !== 'x' || typeof f.n !== 'number' || typeof f.c !== 'string')
        return ws.close(1008, 'expected encrypted frame');
      const inner = this.channel!.open({ n: f.n, c: f.c });
      if (inner === undefined) return ws.close(1008, 'bad frame');
      void this.onRequest(inner);
    });
    ws.on('pong', () => (this.alive = true));
    this.pingTimer = setInterval(() => {
      if (!this.alive) return ws.terminate();
      this.alive = false;
      ws.ping();
    }, 25_000);
    this.pingTimer.unref?.();
    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(this.pingTimer);
      if (this.authed) hub.onClientClosed(this);
    });
    ws.on('error', () => {});
  }

  private frame(f: ServerFrame) {
    sendJson(this.ws, this.channel ? this.channel.seal(f) : f);
  }

  send<E extends keyof ServerEvents>(ev: E, d: ServerEvents[E]) {
    this.frame({ t: 'ev', ev, d });
  }

  close(code: number, reason: string) {
    this.ws.close(code, reason);
  }

  private onAuth(msg: unknown) {
    const parsed = ClientAuth.safeParse(msg);
    if (!parsed.success) {
      this.ws.close(4002, 'expected auth');
      return;
    }
    const { key, sig, client, device, channel } = parsed.data;
    const ok = verifyPayload(
      key,
      SIG_DOMAIN.auth,
      { challenge: this.challenge, server: this.hub.info.id, device, channel },
      sig,
    );
    if (!ok) {
      this.frame({ t: 'error', err: { code: 'unauthorized', message: 'bad signature' } });
      this.ws.close(4003, 'unauthorized');
      return;
    }
    let secret: Uint8Array;
    try {
      secret = acceptChannel(this.channelKeys, channel);
    } catch {
      this.ws.close(4003, 'bad channel');
      return;
    }
    this.userId = userIdFromKey(key);
    const marker = this.hub.deletionMarker(this.userId);
    if (marker) {
      // The signed marker is the proof: clients don't erase anything on a server's word alone.
      this.frame({
        t: 'error',
        err: { code: 'account_deleted', message: 'this account was deleted', record: marker },
      });
      this.ws.close(4010, 'account deleted');
      return;
    }
    this.deviceId = device;
    this.peer = peerIds.make(this.userId, device);
    if (!this.hub.hasRoomFor(this.peer)) {
      this.ws.close(1013, 'server full; try another');
      return;
    }
    this.publicKey = key;
    this.platform = client.platform;
    this.channel = new SecureChannel(
      secret,
      `${this.challenge}|${this.hub.info.id}|${this.peer}`,
      false,
    );
    this.authed = true;
    this.connectedAt = Date.now();
    this.frame({ t: 'auth_ok', userId: this.userId, peer: this.peer });
    this.hub.onClientAuthed(this);
  }

  private inFlight = 0;
  private closeWhenIdle?: { code: number; reason: string };

  /**
   * Sign out once the requests in progress are answered: the request that
   * deleted the account gets its answer before the connection goes.
   */
  closeAfterRequests(code: number, reason: string) {
    if (this.inFlight === 0) this.close(code, reason);
    else this.closeWhenIdle = { code, reason };
  }

  private async onRequest(msg: unknown) {
    const req = msg as { t?: unknown; id?: unknown; m?: unknown; p?: unknown };
    if (req.t !== 'req' || typeof req.id !== 'number' || typeof req.m !== 'string') return;
    const id = req.id;
    this.inFlight++;
    try {
      await this.answer(id, req as { m: string; p?: unknown });
    } finally {
      this.inFlight--;
      if (this.inFlight === 0 && this.closeWhenIdle)
        this.close(this.closeWhenIdle.code, this.closeWhenIdle.reason);
    }
  }

  private async answer(id: number, req: { m: string; p?: unknown }) {
    try {
      if (!(req.m in RpcParams)) throw new RpcFailure('not_found', `unknown method ${req.m}`);
      const method = req.m as RpcMethod;
      const parsed = RpcParams[method].safeParse(req.p ?? {});
      if (!parsed.success)
        throw new RpcFailure('bad_request', parsed.error.issues[0]?.message ?? 'invalid params');
      const result = await this.dispatch(method, parsed.data as never);
      this.frame({ t: 'res', id, ok: result });
    } catch (err) {
      if (err instanceof RpcFailure)
        this.frame({ t: 'res', id, err: { code: err.code, message: err.message } });
      else {
        this.hub.log.error('rpc failed', { method: req.m, err: String(err) });
        this.frame({ t: 'res', id, err: { code: 'internal', message: 'internal error' } });
      }
    }
  }

  private async dispatch(method: RpcMethod, p: Record<string, never>): Promise<unknown> {
    const hub = this.hub;
    const store = hub.records.store;
    switch (method) {
      case 'records.put': {
        if (!this.writeLimiter.take()) throw new RpcFailure('rate_limited', 'too many writes');
        const { record } = p as unknown as { record: SignedRecord };
        // A user writes their own records. (A note is signed by a key made for it alone.)
        if (record.kind !== 'note' && record.author !== this.publicKey)
          throw new RpcFailure('forbidden', 'records are written by their author');
        const r = await hub.dist.putFromClient(record);
        return {
          accepted: r.accepted,
          current: r.current,
          ...(r.reason ? { reason: r.reason } : {}),
        };
      }
      case 'records.get': {
        const { keys } = p as unknown as { keys: string[] };
        const found = await hub.dist.get(keys.filter((k) => this.mayReadKey(k)));
        return { records: found.filter((r) => this.mayRead(r)) };
      }
      case 'records.list': {
        const { prefix, limit } = p as unknown as { prefix: string; limit?: number };
        const found = await hub.dist.list(prefix, limit ?? 1000);
        return { records: found.filter((r) => this.mayRead(r)) };
      }
      case 'records.subscribe': {
        const { prefixes } = p as unknown as { prefixes: string[] };
        const fresh = prefixes.filter((x) => !this.subscriptions.has(x));
        if (this.subscriptions.size + fresh.length > MAX_SUBSCRIPTIONS)
          throw new RpcFailure('bad_request', `at most ${MAX_SUBSCRIPTIONS} subscriptions`);
        for (const prefix of fresh) this.subscriptions.add(prefix);
        hub.dist.refreshWatchesSoon();
        return {};
      }
      case 'users.search': {
        const { query } = p as unknown as { query: string };
        return { profiles: await hub.searchUsers(query) };
      }
      case 'friends.incoming':
        // Lists in the old readable form, among those this server holds.
        return { records: store.findByTerm(`friend-of:${this.userId}`, 2000) };
      case 'spaces.mine': {
        const [members, owned] = await Promise.all([
          hub.dist.findByTerm(`member-user:${this.userId}`, 1000),
          hub.dist.findByTerm(`owner:${this.userId}`, 1000),
        ]);
        const spaceIds = new Set((members as SignedRecord<'member'>[]).map((m) => m.body.spaceId));
        // Owned spaces too, even without a membership (e.g. for account deletion).
        for (const s of owned) spaceIds.add(s.key.slice('space:'.length));
        const spaces = (await hub.dist.get([...spaceIds].map((id) => `space:${id}`))).filter(
          (s): s is SignedRecord<'space'> => s.kind === 'space',
        );
        return { spaces, members };
      }
      case 'presence.subscribe': {
        const { userIds } = p as unknown as { userIds: string[] };
        const fresh = userIds.filter((id) => !this.presenceWatch.has(id));
        if (this.presenceWatch.size + fresh.length > MAX_SUBSCRIPTIONS)
          throw new RpcFailure('bad_request', `at most ${MAX_SUBSCRIPTIONS} watched users`);
        return { presence: hub.presence.watch(this, userIds) };
      }
      case 'presence.set': {
        const { status, text } = p as unknown as { status: OwnStatus; text?: string };
        hub.presence.setStatus(this, status, text);
        return {};
      }
      case 'session.join': {
        const { sessionId, caps } = p as unknown as { sessionId: string; caps: never };
        return { state: await hub.sessions.join(this, sessionId, caps) };
      }
      case 'session.leave': {
        const { sessionId } = p as unknown as { sessionId: string };
        await hub.sessions.leave(this.peer, sessionId);
        return {};
      }
      case 'session.update': {
        const { sessionId, caps } = p as unknown as { sessionId: string; caps: never };
        await hub.sessions.update(this, sessionId, caps);
        return {};
      }
      case 'session.report': {
        const { sessionId, epoch } = p as unknown as { sessionId: string; epoch: number };
        await hub.sessions.report(this, sessionId, epoch);
        return {};
      }
      case 'voice.watch': {
        const { spaceIds } = p as unknown as { spaceIds: string[] };
        const member = await Promise.all(spaceIds.map((id) => hub.isSpaceMember(id, this.userId)));
        if (member.includes(false)) throw new RpcFailure('forbidden', 'not a member of that space');
        this.voiceWatch = new Set(spaceIds);
        return { voice: hub.sessions.voiceSnapshot(spaceIds) };
      }
      case 'signal.send': {
        const { to, sessionId, data } = p as unknown as {
          to: string;
          sessionId: string;
          data: never;
        };
        if (!hub.sessions.inSession(this.peer, sessionId))
          throw new RpcFailure('forbidden', 'join the session first');
        return { delivered: hub.deliverToPeer(to, 'signal', { from: this.peer, sessionId, data }) };
      }
      case 'servers.list':
        return { servers: [hub.info, ...hub.mesh.knownServers()].map(toPublicServerInfo) };
      case 'link.open': {
        const { encKey } = p as unknown as { encKey: string };
        this.encKey = encKey;
        return hub.openLink(this);
      }
      case 'link.claim': {
        if (!this.linkLimiter.take())
          throw new RpcFailure('rate_limited', 'too many attempts; wait a minute');
        const { code } = p as unknown as { code: string };
        return hub.claimLink(this, code);
      }
      case 'link.send': {
        const { code, box } = p as unknown as { code: string; box: LinkBox };
        hub.sendLink(this, code, box);
        return {};
      }
      case 'relay.request': {
        const { sessionId } = p as unknown as { sessionId: string };
        return { grant: hub.requestRelay(this, sessionId) };
      }
      case 'relay.release':
        hub.endRelay(this.userId, 'released');
        return {};
      case 'mail.put': {
        if (!this.mailLimiter.take())
          throw new RpcFailure('rate_limited', 'sending mail too fast; slow down');
        const { items } = p as unknown as { items: { to: string; box: SealedBox }[] };
        return await hub.mailbox.put(this, items);
      }
      case 'mail.fetch': {
        const { proof } = p as unknown as { proof?: MailProof };
        hub.mailbox.fetch(this, proof);
        return {};
      }
      case 'mail.ack': {
        const { ids, proof } = p as unknown as { ids: string[]; proof?: MailProof };
        hub.mailbox.ack(this, ids, proof);
        return {};
      }
    }
  }

  /** True if this client subscribed to a prefix covering the record key. */
  wants(record: SignedRecord): boolean {
    if (!this.mayRead(record)) return false;
    for (const prefix of this.subscriptions) if (record.key.startsWith(prefix)) return true;
    return false;
  }

  /**
   * Notes are sealed, but how many someone gets, and when, is theirs alone to
   * see: only the recipient may read them.
   */
  mayRead(record: SignedRecord): boolean {
    return this.mayReadKey(record.key);
  }

  mayReadKey(key: string): boolean {
    return !key.startsWith('note:') || key.startsWith(recordKey.notePrefix(this.userId));
  }
}
