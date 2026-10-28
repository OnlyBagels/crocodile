import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { AddressInfo } from 'node:net';
import {
  identityFromSeed,
  isSpaceMember,
  randomBytes,
  randomId,
  sign,
  toPublicServerInfo,
  userTag,
  type Identity,
} from '@crocodile/crypto';
import {
  fromB64u,
  LIMITS,
  PROTOCOL_VERSION,
  recordKey,
  SIG_DOMAIN,
  toB64u,
  type DirectoryEntry,
  type ProfileBody,
  type LinkBox,
  type RelayGrant,
  type ServerEvents,
  type ServerInfo,
  type SignedRecord,
  type OperatorInfo,
  isOperatorContact,
} from '@crocodile/protocol';
import { ClientConnection } from './client';
import { DirectoryClient } from './directory-client';
import { Distribution, defaultDistributionConfig, type DistributionConfig } from './distribution';
import { Membership, defaultMembershipTiming, type MembershipTiming } from './membership';
import { Mesh, defaultMeshConfig, type MeshConfig } from './mesh';
import { PresenceService } from './presence';
import { RecordService, defaultRecordQuotas, type RecordQuotas } from './records';
import { SessionService } from './sessions';
import { openStore, type Store } from './store';
import { TurnServer } from './turn';
import { startStunServer } from './stun';
import type { Socket } from 'node:dgram';
import { MailboxService, defaultMailboxConfig, type MailboxConfig } from './mailbox';
import { consoleLogger, RpcFailure, type Logger } from './util';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { lookup } from 'node:dns/promises';

/** The release this server was built from: CROC_VERSION, set by the release images. */
export const COORDINATOR_VERSION = process.env.CROC_VERSION || 'dev';

export interface CoordinatorConfig {
  /** Display name announced to the directory, e.g. "Swamp EU-1". */
  name: string;
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** URL clients and peers use to reach this server. Defaults to http://<host>:<port>. */
  publicUrl?: string;
  region?: string;
  /** Persist state here; omitted means in-memory only. */
  dataDir?: string;
  storage?: 'sqlite' | 'memory';
  /** Directory services to register with and learn peers from. */
  directoryUrls: string[];
  /** Coordination servers to link with regardless of the directory. */
  meshPeers: string[];
  /** UDP port for the built-in STUN server; null disables it. */
  stunPort: number | null;
  /**
   * Second UDP port answering STUN only. Apps compare the public port they
   * get on both to tell a cone NAT (same port, good for hosting calls) from
   * a symmetric one, without asking third-party STUN servers. Default: the
   * port after `stunPort`; null disables it.
   */
  stunAltPort?: number | null;
  /** Extra STUN URLs handed to clients. */
  extraStun: string[];
  capacity: number;
  /** Register with the directory (off for private/LAN servers). */
  announce: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Fixed identity seed (base64url); otherwise generated and persisted. */
  seed?: string;
  /**
   * Opt-in relay (TURN) for users without a direct path. Runs on the STUN
   * port. Grants last at most an hour; `maxUsers` caps concurrent users.
   */
  relay: {
    enabled: boolean;
    maxUsers: number;
    publicIp?: string;
    /** UDP ports for relayed addresses (see TurnServerOptions.relayPorts). */
    ports?: { min: number; max: number };
    /** Allow relaying to private/loopback addresses (LAN-only setups, tests). */
    allowPrivatePeers?: boolean;
  };
  /** Opt-in mailbox holding sealed messages for offline devices. */
  mailbox: MailboxConfig;
  /** Concurrent WebSocket connections allowed from one IP address. */
  maxConnectionsPerIp: number;
  /** Per-user record limits; defaults in defaultRecordQuotas. */
  quotas?: Partial<RecordQuotas>;
  /**
   * Take the client address from X-Forwarded-For (only behind a trusted
   * reverse proxy, as on the main server). Exactly one proxy hop is trusted:
   * the address is the last one the proxy added, never one the client wrote.
   */
  trustProxy: boolean;
  /**
   * Where users can get this server's source code (AGPL-3.0 section 13).
   * Operators running a modified version must point this at their changes.
   */
  sourceUrl?: string;
  /**
   * How to reach whoever runs this server: an email address or an https://
   * page such as its privacy notice. Apps show it to the people using it.
   */
  operatorContact?: string;
  /** Version shown in /health and the server info; defaults to COORDINATOR_VERSION. */
  version?: string;
  /** How many servers hold each record (docs/MESH.md). */
  replicas: number;
  /**
   * Keep a copy of every record, as well as answering for the shards this
   * server owns. For well-provisioned servers, so the network never depends
   * on a few home computers for its data.
   */
  storeAll?: boolean;
  /** Overlay and direct links; defaults in defaultMeshConfig. */
  mesh?: Partial<MeshConfig>;
  /** Beacons and the live set; defaults in defaultMembershipTiming. */
  membership?: Partial<MembershipTiming>;
  /** Watches, moving and dropping records; defaults in defaultDistributionConfig. */
  distribution?: Partial<DistributionConfig>;
}

/** Source of the unmodified coordinator (AGPL-3.0). */
export const SOURCE_URL = 'https://github.com/pwalda/crocodile';

export const defaultConfig: CoordinatorConfig = {
  name: 'Crocodile coordinator',
  host: '0.0.0.0',
  port: 7443,
  directoryUrls: [],
  meshPeers: [],
  stunPort: 7443,
  extraStun: [],
  capacity: 5000,
  announce: true,
  storage: 'sqlite',
  relay: { enabled: true, maxUsers: 25 },
  mailbox: defaultMailboxConfig,
  maxConnectionsPerIp: 50,
  trustProxy: false,
  replicas: 3,
};

/**
 * A coordination server. Holds signed metadata, tracks presence, elects
 * session hosts and relays signalling. Voice and text never pass through it.
 * Embeddable: the desktop app runs one of these when the user opts in.
 */
/** A relay grant asked for again in its last minutes is extended (see requestRelay). */
export const RELAY_RENEW_WINDOW_MS = 10 * 60_000;

export class Coordinator {
  readonly config: CoordinatorConfig;
  readonly log: Logger;
  readonly store: Store;
  readonly identity: Identity;
  readonly records: RecordService;
  readonly presence: PresenceService;
  readonly sessions: SessionService;
  readonly mesh: Mesh;
  readonly membership: Membership;
  readonly dist: Distribution;
  readonly mailbox: MailboxService;
  private directory?: DirectoryClient;
  private app?: FastifyInstance;
  turn?: TurnServer;
  private _info?: ServerInfo;
  /** userId -> grant expiry */
  private relayGrants = new Map<
    string,
    { expiresAt: number; timer: ReturnType<typeof setTimeout> }
  >();
  /** Device-link codes opened on this server. */
  private links = new Map<
    string,
    {
      peer: string;
      key: string;
      encKey: string;
      kemKey: string;
      commit: string;
      expiresAt: number;
      claimedBy?: string;
      revealed?: boolean;
    }
  >();
  /** Codes this server resolved for a claiming device (code -> target peer). */
  private claims = new Map<
    string,
    { peer: string; by: string; expiresAt: number; nonceSent?: boolean }
  >();
  private noteTimer?: ReturnType<typeof setInterval>;

  constructor(config: Partial<CoordinatorConfig> & Pick<CoordinatorConfig, 'name'>) {
    this.config = { ...defaultConfig, ...config };
    // A typo (NaN) or zero here would silently switch a protection off.
    for (const [name, n] of [
      ['capacity', this.config.capacity],
      ['replicas', this.config.replicas],
      ['maxConnectionsPerIp', this.config.maxConnectionsPerIp],
      ['relay.maxUsers', this.config.relay.maxUsers],
      ...Object.entries(this.config.quotas ?? {}).map(([k, v]) => [`quotas.${k}`, v] as const),
    ] as const) {
      if (!Number.isSafeInteger(n) || n < 1)
        throw new Error(`${name} must be a positive whole number, got ${n}`);
    }
    if (
      this.config.operatorContact !== undefined &&
      !isOperatorContact(this.config.operatorContact)
    )
      throw new Error(
        `operatorContact must be an email address or an https:// page, got ${this.config.operatorContact}`,
      );
    // ServerInfo allows 32 characters; a longer one would fail every client's check.
    if (this.version.length > 32) throw new Error(`version is too long: ${this.version}`);
    this.log = consoleLogger(`coord:${this.config.name}`, this.config.logLevel ?? 'info');
    this.store = openStore({ dataDir: this.config.dataDir, kind: this.config.storage });
    let seed = this.config.seed ?? this.store.getMeta('server-seed');
    if (!seed) {
      seed = toB64u(randomBytes(32));
      this.store.setMeta('server-seed', seed);
    }
    this.identity = identityFromSeed(fromB64u(seed));
    this.records = new RecordService(this.store, this.log, {
      ...defaultRecordQuotas,
      ...this.config.quotas,
    });
    this.presence = new PresenceService(this);
    this.sessions = new SessionService(this);
    this.mesh = new Mesh(this, { ...defaultMeshConfig, ...this.config.mesh });
    this.membership = new Membership(this, {
      ...defaultMembershipTiming,
      ...this.config.membership,
    });
    this.dist = new Distribution(this, {
      ...defaultDistributionConfig,
      ...this.config.distribution,
    });
    this.records.lookup = (key) => this.dist.lookup(key);
    this.mailbox = new MailboxService(this);
    this.membership.on({
      up: (id) => this.onServerUp(id),
      down: (id) => this.onServerDown(id),
    });
    this.records.onAccepted((record, seq, origin, previous) => {
      this.mesh.onRecord(record, seq, origin, previous);
      this.pushRecordToClients(record);
      this.dist.onAccepted(record);
      if (record.kind === 'profile' && (record.body as ProfileBody).deleted)
        this.purgeAccount(record as SignedRecord<'profile'>);
    });
    this.noteTimer = setInterval(() => {
      const n = this.records.expireNotes();
      if (n) this.log.info('notes expired', { count: n });
    }, 3600_000);
    this.noteTimer.unref?.();
  }

  /**
   * A deleted account: erase everything else this server holds about it. The
   * marker profile replicates through the mesh, so every server does the same,
   * and validateRecord refuses anything the identity signs afterwards.
   */
  private purgeAccount(marker: SignedRecord<'profile'>) {
    const userId = marker.key.slice('profile:'.length);
    // The spaces the user was in keep their memberships on other servers:
    // send those servers the marker, so they erase them too.
    const spaces = new Set(
      this.store
        .findByTerm(`member-any:${userId}`, 100_000)
        .map((r) => (r as SignedRecord<'member'>).body.spaceId),
    );
    // Kept until each of their owners confirms, across restarts.
    this.dist.trackDeletion(marker, [...spaces]);
    const keys = [
      ...this.store.listPrefix(recordKey.devicePrefix(userId), 100_000).map((r) => r.key),
      recordKey.friends(userId),
      ...this.store.findByTerm(`member-any:${userId}`, 100_000).map((r) => r.key),
      ...this.store.listPrefix(recordKey.notePrefix(userId), 100_000).map((r) => r.key),
    ];
    for (const key of keys) this.store.delete(key);
    const mail = this.store.mailDeleteUser(userId);
    this.log.info('account deleted', { records: keys.length, mail });
    this.signOutDeleted(userId, marker);
  }

  /** Sign out a deleted account's devices connected here. */
  signOutDeleted(userId: string, marker: SignedRecord<'profile'>) {
    // After the request that deleted it has been answered. The marker goes
    // first: devices only sign out on a deletion they can verify.
    setTimeout(() => {
      for (const client of this.presence.localOf(userId)) {
        client.send('record', { record: marker });
        if (client.closeAfterRequests) client.closeAfterRequests(4010, 'account deleted');
        else client.close(4010, 'account deleted');
      }
    }, 100).unref?.();
  }

  /** The signed deletion marker, if we know this account was deleted. */
  deletionMarker(userId: string): SignedRecord<'profile'> | undefined {
    const profile = this.dist.lookup(recordKey.profile(userId)) as
      SignedRecord<'profile'> | undefined;
    return profile?.body.deleted ? profile : undefined;
  }

  get info(): ServerInfo {
    if (!this._info) throw new Error('coordinator not started');
    return this._info;
  }

  get url(): string {
    return this.info.url;
  }

  async start(): Promise<this> {
    const app = Fastify({
      logger: false,
      bodyLimit: 1024 * 1024,
      // Trust exactly one hop, not `true`: with `true`, Fastify takes the
      // leftmost X-Forwarded-For entry, which a client can write itself when
      // the proxy appends to an existing header.
      trustProxy: this.config.trustProxy ? (_address: string, hop: number) => hop < 1 : false,
    });
    this.app = app;
    await app.register(websocket, { options: { maxPayload: LIMITS.wsMessageMaxBytes } });
    app.addHook('onSend', async (_req, reply) => {
      reply.header('access-control-allow-origin', '*');
    });
    app.get('/health', async () => ({
      ok: true,
      id: this.identity.userId,
      name: this.config.name,
      version: this.version,
      protocol: PROTOCOL_VERSION,
      users: this.presence.localCount,
      capacity: this.config.capacity,
      peers: this.mesh.peerIds().length,
      time: Date.now(),
      source: this.config.sourceUrl ?? SOURCE_URL,
      ...this.operatorInfo(),
    }));
    app.get('/v1/info', async () => ({
      server: this.info,
      stun: this.stunUrls(),
      // Other servers' addresses are only shown obfuscated.
      peers: this.mesh.peers().map(toPublicServerInfo),
      source: this.config.sourceUrl ?? SOURCE_URL,
      ...this.operatorInfo(),
    }));
    app.register(async (scope) => {
      scope.get('/v1/client', { websocket: true }, (socket, req) => {
        if (!this.admit(socket, req.ip)) return;
        // Capacity is enforced when the device authenticates (see hasRoomFor).
        new ClientConnection(this, socket, req.socket.localAddress);
      });
      scope.get('/v1/federation', { websocket: true }, (socket, req) => {
        if (!this.admit(socket, req.ip)) return;
        this.mesh.accept(socket);
      });
    });

    await app.listen({ host: this.config.host, port: this.config.port });
    const port = (app.server.address() as AddressInfo).port;
    const publicUrl = (
      this.config.publicUrl ?? `http://${hostForUrl(this.config.host)}:${port}`
    ).replace(/\/$/, '');
    this._info = {
      id: this.identity.userId,
      key: this.identity.publicKey,
      name: this.config.name,
      url: publicUrl,
      version: this.version,
      ...(this.config.region ? { region: this.config.region } : {}),
    };

    if (this.config.stunPort !== null) {
      // One UDP port serves STUN for everyone and TURN for opted-in relay grants.
      try {
        this.turn = await new TurnServer({
          port: this.config.stunPort,
          host: this.config.host.includes(':') ? '::' : '0.0.0.0',
          relayIp: await this.relayIp(publicUrl, !this.config.publicUrl),
          ...(this.config.relay.ports ? { relayPorts: this.config.relay.ports } : {}),
          secret: Buffer.from(randomBytes(32)),
          limits: { maxUsers: this.config.relay.maxUsers },
          allowPrivatePeers: this.config.relay.allowPrivatePeers,
          grantEnd: (userId) => this.relayGrants.get(userId)?.expiresAt,
          log: (m, e) => this.log.debug(m, e),
        }).start();
        this.stunPortBound = this.turn.port;
      } catch (err) {
        this.log.warn('STUN/TURN server disabled', { err: String(err) });
      }
      const alt =
        this.config.stunAltPort !== undefined
          ? this.config.stunAltPort
          : this.config.stunPort === 0
            ? 0
            : this.config.stunPort + 1;
      if (this.stunPortBound && alt !== null) {
        try {
          this.stunAlt = await startStunServer(
            alt,
            this.config.host.includes(':') ? '::' : '0.0.0.0',
          );
          this.stunAltPortBound = this.stunAlt.address().port;
        } catch (err) {
          this.log.warn('second STUN port disabled; NAT detection will be coarser', {
            port: alt,
            err: String(err),
          });
        }
      }
    }

    this.mesh.start(this.config.meshPeers);
    this.membership.start();
    this.dist.start();
    if (this.config.directoryUrls.length) {
      this.directory = new DirectoryClient(this, this.config.directoryUrls);
      this.directory.start();
    }
    this.log.info('coordination server listening', {
      url: publicUrl,
      id: this.info.id,
      store: this.store.kind,
    });
    return this;
  }

  private stunPortBound?: number;
  private stunAlt?: Socket;
  private stunAltPortBound?: number;

  private async relayIp(publicUrl: string, guessed: boolean): Promise<string> {
    if (this.config.relay.publicIp) return this.config.relay.publicIp;
    const host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, '');
    // No public URL and listening everywhere: a loopback relay address would
    // reach no one else, so use this machine's address on the network.
    if (guessed && isLoopback(host) && isUnspecified(this.config.host)) return lanAddress() ?? host;
    if (isIP(host)) return host;
    try {
      return (await lookup(host)).address;
    } catch {
      return '127.0.0.1';
    }
  }

  /**
   * The host apps should use for STUN and TURN: the public URL's, or, when
   * that is only a loopback address (no --public-url), the address the app
   * reached us on (`via`), so apps on the LAN get one that works for them.
   */
  publicHost(via?: string): string {
    const host = new URL(this.info.url).hostname.replace(/^\[|\]$/g, '');
    const local = via?.replace(/^::ffff:/, '');
    const pick = isLoopback(host) && local && isIP(local) && !isLoopback(local) ? local : host;
    return pick.includes(':') ? `[${pick}]` : pick;
  }

  stunUrls(via?: string): string[] {
    const host = this.publicHost(via);
    const own = [this.stunPortBound, this.stunAltPortBound].flatMap((p) =>
      p ? [`stun:${host}:${p}`] : [],
    );
    return [...own, ...this.config.extraStun];
  }

  get version(): string {
    return this.config.version ?? COORDINATOR_VERSION;
  }

  /** `{ operator }` for the hello, /health and /v1/info; nothing without a contact. */
  operatorInfo(): { operator?: OperatorInfo } {
    return this.config.operatorContact
      ? { operator: { contact: this.config.operatorContact } }
      : {};
  }

  directoryEntry(): DirectoryEntry {
    const load = { users: this.presence.localCount, capacity: this.config.capacity };
    const signedAt = Date.now();
    return {
      server: this.info,
      load,
      signedAt,
      sig: sign(this.identity, SIG_DOMAIN.directory, { server: this.info, load, signedAt }),
    };
  }

  /** Open WebSocket connections per remote IP. */
  private connectionsByIp = new Map<string, number>();

  /** Per-IP connection limit, so one machine cannot exhaust a (home) server. */
  private admit(
    socket: {
      close(code?: number, reason?: string): void;
      on(ev: 'close', fn: () => void): unknown;
    },
    ip: string,
  ) {
    const n = this.connectionsByIp.get(ip) ?? 0;
    if (n >= this.config.maxConnectionsPerIp) {
      this.log.info('too many connections from one address', { ip });
      socket.close(1008, 'too many connections from your address');
      return false;
    }
    this.connectionsByIp.set(ip, n + 1);
    socket.on('close', () => {
      const left = (this.connectionsByIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.connectionsByIp.delete(ip);
      else this.connectionsByIp.set(ip, left);
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /** Deliver an event to every device of a user, wherever in the mesh they are. */
  deliver<E extends keyof ServerEvents>(userId: string, ev: E, d: ServerEvents[E]): boolean {
    let delivered = this.deliverLocal(userId, ev, d);
    for (const server of this.presence.remoteServersOf(userId)) {
      if (server !== this.info.id && this.mesh.sendTo(server, { t: 'route', to: userId, ev, d }))
        delivered = true;
    }
    return delivered;
  }

  /** Deliver an event to one device (`<userId>.<deviceId>`). */
  deliverToPeer<E extends keyof ServerEvents>(peer: string, ev: E, d: ServerEvents[E]): boolean {
    if (this.deliverLocal(peer, ev, d)) return true;
    const server = this.presence.locatePeer(peer);
    if (!server || server === this.info.id) return false;
    return this.mesh.sendTo(server, { t: 'route', to: peer, ev, d });
  }

  /** `to` is a user id (all local devices) or a peer id (one device). */
  deliverLocal<E extends keyof ServerEvents>(to: string, ev: E, d: ServerEvents[E]): boolean {
    const targets = to.includes('.')
      ? [this.presence.localPeer(to)].filter((c): c is NonNullable<typeof c> => !!c)
      : this.presence.localOf(to);
    if (targets.length === 0) return false;
    if (ev === 'session') this.sessions.noteState((d as ServerEvents['session']).state);
    for (const client of targets) client.send(ev, d);
    return true;
  }

  pushRecordToClients(record: SignedRecord) {
    // Requests from apps that still write the readable list. Sealed lists say
    // nothing; their notes reach the recipient instead.
    let friendOf: Set<string> | undefined;
    const body = record.body as { friends?: string[] };
    if (record.kind === 'friends' && body.friends) friendOf = new Set(body.friends);
    // Your own memberships reach all your devices (a space joined on another device),
    // and so do your notes.
    const forUser =
      record.kind === 'member'
        ? (record as SignedRecord<'member'>).body.userId
        : record.kind === 'note'
          ? record.key.split(':')[1]
          : undefined;
    for (const client of this.presence.localClients()) {
      if (
        (client as ClientConnection).wants(record) ||
        friendOf?.has(client.userId) ||
        forUser === client.userId
      ) {
        client.send('record', { record });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Opt-in relay grants
  // -------------------------------------------------------------------------

  requestRelay(client: ClientConnection, sessionId: string): RelayGrant {
    if (!this.config.relay.enabled || !this.turn)
      throw new RpcFailure('unavailable', 'this server does not offer a relay');
    if (!this.sessions.inSession(client.peer, sessionId))
      throw new RpcFailure('forbidden', 'join the session first');
    const now = Date.now();
    for (const [u, g] of this.relayGrants) if (g.expiresAt <= now) this.endRelay(u, 'expired');
    let grant = this.relayGrants.get(client.userId);
    if (!grant && this.relayGrants.size >= this.config.relay.maxUsers) {
      throw new RpcFailure('unavailable', 'the relay on this server is at capacity right now');
    }
    // A new grant, or one about to end extended by another window: a client
    // renews while its connection still goes through the relay, and the TURN
    // server keeps the existing allocations (grantEnd), so nothing drops.
    if (!grant || grant.expiresAt - now < RELAY_RENEW_WINDOW_MS) {
      const userId = client.userId;
      const expiresAt = now + this.turn.limits.maxGrantMs;
      if (grant) clearTimeout(grant.timer);
      const timer = setTimeout(
        () => this.endRelay(userId, 'its time window ended'),
        expiresAt - now,
      );
      timer.unref?.();
      this.log.info(grant ? 'relay renewed' : 'relay granted', {
        user: userId,
        active: this.relayGrants.size + (grant ? 0 : 1),
      });
      grant = { expiresAt, timer };
      this.relayGrants.set(userId, grant);
    }
    const creds = this.turn.credentials(client.userId, grant.expiresAt);
    return {
      urls: [`turn:${this.publicHost(client.via)}:${this.turn.port}?transport=udp`],
      username: creds.username,
      credential: creds.credential,
      expiresAt: grant.expiresAt,
      server: this.info.name,
    };
  }

  endRelay(userId: string, reason: string) {
    const g = this.relayGrants.get(userId);
    if (!g) return;
    clearTimeout(g.timer);
    this.relayGrants.delete(userId);
    this.turn?.dropUser(userId);
    this.deliver(userId, 'relay_expired', { reason });
  }

  relayStats() {
    return {
      enabled: this.config.relay.enabled,
      activeUsers: this.relayGrants.size,
      maxUsers: this.config.relay.maxUsers,
    };
  }

  // -------------------------------------------------------------------------
  // Device linking
  // -------------------------------------------------------------------------

  openLink(
    client: ClientConnection,
    kemKey: string,
    commit: string,
  ): { code: string; expiresAt: number } {
    const now = Date.now();
    for (const [c, l] of this.links)
      if (l.expiresAt < now || l.peer === client.peer) this.links.delete(c);
    const code = randomId(5); // 40 bits; claims are rate limited
    const expiresAt = now + 10 * 60_000;
    this.links.set(code, {
      peer: client.peer,
      key: client.publicKey,
      encKey: client.encKey,
      kemKey,
      commit,
      expiresAt,
    });
    return { code, expiresAt };
  }

  /** Local lookup used by link.claim and by mesh link queries. */
  findLink(code: string) {
    const l = this.links.get(code);
    return l && l.expiresAt > Date.now() && !l.claimedBy ? l : undefined;
  }

  /**
   * The new device is told about the claim only once the existing device
   * sends its nonce (link.nonce), which it does after it holds the new
   * device's commit. See linkSecurityCode for why the order matters.
   */
  async claimLink(
    client: ClientConnection,
    code: string,
  ): Promise<{ peer: string; key: string; encKey: string; kemKey: string; commit: string }> {
    const clean = cleanLinkCode(code);
    const local = this.findLink(clean);
    if (local) local.claimedBy = client.peer;
    const found = local ?? (await this.mesh.queryLink(clean, client.peer));
    if (!found)
      throw new RpcFailure(
        'not_found',
        'That code is not valid (or expired). Check it and try again.',
      );
    this.claims.set(clean, {
      peer: found.peer,
      by: client.peer,
      expiresAt: Date.now() + 10 * 60_000,
    });
    return {
      peer: found.peer,
      key: found.key,
      encKey: found.encKey,
      kemKey: found.kemKey,
      commit: found.commit,
    };
  }

  nonceLink(client: ClientConnection, code: string, nonce: string) {
    const claim = this.ownClaim(client, code);
    if (claim.nonceSent) throw new RpcFailure('conflict', 'nonce already sent');
    const delivered = this.deliverToPeer(claim.peer, 'link_claimed', {
      key: client.publicKey,
      userId: client.userId,
      by: client.peer,
      nonce,
    });
    if (!delivered) throw new RpcFailure('unavailable', 'the new device went offline');
    claim.nonceSent = true;
  }

  revealLink(client: ClientConnection, code: string, to: string, nonce: string) {
    const link = this.links.get(cleanLinkCode(code));
    if (!link || link.peer !== client.peer || link.expiresAt < Date.now() || !link.claimedBy)
      throw new RpcFailure('not_found', 'no claimed link for this code');
    if (link.claimedBy !== to && !link.claimedBy.startsWith('remote:'))
      throw new RpcFailure('forbidden', 'the code was claimed by another device');
    if (link.revealed) throw new RpcFailure('conflict', 'nonce already revealed');
    link.revealed = true;
    if (!this.deliverToPeer(to, 'link_reveal', { nonce }))
      throw new RpcFailure('unavailable', 'the other device went offline');
  }

  private ownClaim(client: ClientConnection, code: string) {
    const claim = this.claims.get(cleanLinkCode(code));
    if (!claim || claim.by !== client.peer || claim.expiresAt < Date.now())
      throw new RpcFailure('not_found', 'claim the code first');
    return claim;
  }

  sendLink(client: ClientConnection, code: string, box: LinkBox) {
    const claim = this.ownClaim(client, code);
    if (!claim.nonceSent) throw new RpcFailure('not_found', 'send the link nonce first');
    this.claims.delete(cleanLinkCode(code));
    if (!this.deliverToPeer(claim.peer, 'link_payload', { box }))
      throw new RpcFailure('unavailable', 'the new device went offline');
  }

  /** Whether a user belongs to a space, asking the space's owners if need be. */
  async isSpaceMember(spaceId: string, userId: string) {
    return (await this.areSpaceMember([spaceId], userId))[0]!;
  }

  /** `isSpaceMember` for several spaces at once, in one round of questions to the owners. */
  async areSpaceMember(spaceIds: string[], userId: string) {
    const records = await this.dist.get(
      spaceIds.flatMap((id) => [recordKey.space(id), recordKey.member(id, userId)]),
    );
    const byKey = new Map(records.map((r) => [r.key, r]));
    return spaceIds.map((id) => isSpaceMember({ get: (k) => byKey.get(k) }, id, userId));
  }

  async searchUsers(query: string): Promise<SignedRecord<'profile'>[]> {
    const q = query.trim().toLowerCase();
    const [name, tag] = q.split('#') as [string, string?];
    // Exact user id lookups are handy for invites and QR codes.
    if (/^[a-z2-7]{26}$/.test(q)) {
      return (await this.dist.get([`profile:${q}`])) as SignedRecord<'profile'>[];
    }
    const found = (await this.dist.findByTerm(`name:${name}`, 50)) as SignedRecord<'profile'>[];
    if (!tag) return found;
    return found.filter((p) => userTag(p.key.slice('profile:'.length)) === tag);
  }

  // -------------------------------------------------------------------------
  // Lifecycle hooks
  // -------------------------------------------------------------------------

  /**
   * Whether a device that just proved its identity may stay. Checked and
   * followed by attach() in the same synchronous step, so concurrent logins
   * cannot overshoot the capacity; a device replacing its own older
   * connection always fits.
   */
  hasRoomFor(peer: string) {
    return !!this.presence.localPeer(peer) || this.presence.localCount < this.config.capacity;
  }

  onClientAuthed(client: ClientConnection) {
    const previous = this.presence.attach(client);
    this.dist.refreshWatchesSoon();
    // The account's records may live elsewhere: check it wasn't deleted.
    void this.dist
      .get([recordKey.profile(client.userId)])
      .then(([profile]) => {
        if ((profile?.body as ProfileBody | undefined)?.deleted)
          this.signOutDeleted(client.userId, profile as SignedRecord<'profile'>);
      })
      .catch(() => {});
    if (previous && previous !== client) {
      previous.send('replaced', { reason: 'this device connected again elsewhere' });
      previous.close(4009, 'replaced');
      // Give the new connection a moment to re-join before tearing sessions down.
      this.sessions.onClientReplaced(previous.peer);
    }
  }

  onClientClosed(client: ClientConnection) {
    if (this.presence.detach(client)) this.sessions.onClientGone(client.peer);
  }

  onServerUp(_serverId: string) {
    this.sessions.onServerUp();
  }

  onServerDown(serverId: string) {
    this.presence.dropServer(serverId);
    this.sessions.onServerDown(serverId);
  }

  private stopped = false;

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.directory?.stop();
    this.membership.stop();
    this.dist.stop();
    this.mesh.close();
    this.sessions.close();
    this.mailbox.close();
    clearInterval(this.noteTimer);
    for (const g of this.relayGrants.values()) clearTimeout(g.timer);
    this.turn?.stop();
    this.stunAlt?.close();
    await this.app?.close();
    this.store.close();
  }
}

function cleanLinkCode(code: string): string {
  return code
    .trim()
    .toLowerCase()
    .replace(/[^a-z2-7]/g, '');
}

function hostForUrl(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

function isUnspecified(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

/** This machine's first non-internal IPv4 address, if it has one. */
export function lanAddress(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | undefined {
  for (const list of Object.values(interfaces))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return undefined;
}
