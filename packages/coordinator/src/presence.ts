import { keyMatchesUserId, sign, verifyPayload } from '@crocodile/crypto';
import {
  FedFrameSchema,
  SIG_DOMAIN,
  presenceSigned,
  type FedPresence,
  type PresenceEntry,
  type Platform,
  type ServerEvents,
} from '@crocodile/protocol';
import type { Coordinator } from './coordinator';

export type OwnStatus = 'online' | 'idle' | 'dnd' | 'invisible';
type FedEntry = FedPresence['entries'][number];

/** A server's sequence numbers are its clock; news dated further ahead than this is refused. */
const SEQ_AHEAD_MS = 5 * 60_000;

/** One authenticated client WebSocket (one device of one user). */
export interface ClientHandle {
  readonly connId: number;
  readonly userId: string;
  readonly deviceId: string;
  /** `<userId>.<deviceId>` */
  readonly peer: string;
  readonly platform: Platform;
  readonly connectedAt: number;
  status: OwnStatus;
  statusText?: string;
  subscriptions: Set<string>;
  presenceWatch: Set<string>;
  voiceWatch: Set<string>;
  send<E extends keyof ServerEvents>(ev: E, d: ServerEvents[E]): void;
  close(code: number, reason: string): void;
  /** Close once the requests in progress have been answered. */
  closeAfterRequests?(code: number, reason: string): void;
}

const STATUS_RANK: Record<string, number> = {
  online: 4,
  dnd: 3,
  idle: 2,
  invisible: 1,
  offline: 0,
};

/**
 * Who is online, on which devices, and where. A user is online if any device
 * is; their shown status is the "most present" across devices. Each server
 * floods changes to its own users through the overlay; they can arrive by
 * several paths and out of order, so every entry keeps the sequence number
 * its origin server gave it, and older news is ignored.
 */
export class PresenceService {
  /** userId -> deviceId -> connection */
  private localDevices = new Map<string, Map<string, ClientHandle>>();
  /** userId -> serverId -> state of that user's devices on that server */
  private remote = new Map<
    string,
    Map<
      string,
      {
        status: FedEntry['status'];
        text?: string;
        since: number;
        devices: string[];
        seq: number;
      }
    >
  >();
  /** `${origin}|${userId}` -> seq of the latest news applied (also for users who left). */
  private seqs = new Map<string, number>();
  private ownSeq = 0;
  /** Our signed full state at `ownSeq`, so a burst of requests signs it once. */
  private fullCache?: FedPresence;
  /** origin -> the newest seq we have applied from it. */
  private originSeq = new Map<string, number>();
  /** origin -> when we last asked it for its full presence. */
  private askedAt = new Map<string, number>();
  private watchers = new Map<string, Set<ClientHandle>>();

  constructor(private readonly hub: Coordinator) {}

  get localCount() {
    let n = 0;
    for (const d of this.localDevices.values()) n += d.size;
    return n;
  }

  *localClients(): Iterable<ClientHandle> {
    for (const devices of this.localDevices.values()) yield* devices.values();
  }

  localOf(userId: string): ClientHandle[] {
    return [...(this.localDevices.get(userId)?.values() ?? [])];
  }

  localPeer(peer: string): ClientHandle | undefined {
    const [userId, deviceId] = peer.split('.') as [string, string];
    return this.localDevices.get(userId)?.get(deviceId);
  }

  /** Registers a client; returns a previous connection of the same device, if any. */
  attach(client: ClientHandle): ClientHandle | undefined {
    let devices = this.localDevices.get(client.userId);
    if (!devices) this.localDevices.set(client.userId, (devices = new Map()));
    const previous = devices.get(client.deviceId);
    devices.set(client.deviceId, client);
    this.changed(client.userId, true);
    return previous;
  }

  detach(client: ClientHandle) {
    this.unwatchAll(client);
    const devices = this.localDevices.get(client.userId);
    if (devices?.get(client.deviceId) !== client) return false;
    devices.delete(client.deviceId);
    if (devices.size === 0) this.localDevices.delete(client.userId);
    this.changed(client.userId, true);
    return true;
  }

  setStatus(client: ClientHandle, status: OwnStatus, text?: string) {
    client.status = status;
    client.statusText = text;
    this.changed(client.userId, true);
  }

  private localAggregate(
    userId: string,
  ): { status: OwnStatus; text?: string; since: number } | null {
    const devices = this.localOf(userId);
    if (devices.length === 0) return null;
    const best = devices.sort(
      (a, b) => STATUS_RANK[b.status]! - STATUS_RANK[a.status]! || b.connectedAt - a.connectedAt,
    )[0]!;
    return {
      status: best.status,
      text: best.statusText,
      since: Math.min(...devices.map((d) => d.connectedAt)),
    };
  }

  publicEntry(userId: string): PresenceEntry {
    const candidates: { status: FedEntry['status']; text?: string }[] = [];
    const local = this.localAggregate(userId);
    if (local) candidates.push(local);
    for (const e of this.remote.get(userId)?.values() ?? []) candidates.push(e);
    const best = candidates.sort((a, b) => STATUS_RANK[b.status]! - STATUS_RANK[a.status]!)[0];
    if (!best || best.status === 'invisible' || best.status === 'offline')
      return { userId, status: 'offline' };
    return { userId, status: best.status, ...(best.text ? { text: best.text } : {}) };
  }

  /** Servers that currently host at least one device of the user (excluding us). */
  remoteServersOf(userId: string): string[] {
    return [...(this.remote.get(userId) ?? new Map())]
      .filter(([, e]) => e.status !== 'offline')
      .map(([s]) => s);
  }

  /**
   * Whether `server` has told us it has `who` connected: a device (a peer id)
   * or any device of a user (a user id). Servers are taken at their word about
   * their own users, never about another server's.
   */
  hosts(server: string, who: string): boolean {
    const [userId, deviceId] = who.split('.') as [string, string | undefined];
    const entry = this.remote.get(userId)?.get(server);
    if (!entry || entry.status === 'offline') return false;
    return deviceId === undefined || entry.devices.includes(deviceId);
  }

  /** Server hosting a specific device. */
  locatePeer(peer: string): string | null {
    if (this.localPeer(peer)) return this.hub.info.id;
    const [userId, deviceId] = peer.split('.') as [string, string];
    let best: { server: string; since: number } | null = null;
    for (const [server, e] of this.remote.get(userId) ?? []) {
      if (e.devices.includes(deviceId) && (!best || e.since > best.since))
        best = { server, since: e.since };
    }
    return best?.server ?? null;
  }

  watch(client: ClientHandle, userIds: string[]): PresenceEntry[] {
    for (const id of userIds) {
      client.presenceWatch.add(id);
      let set = this.watchers.get(id);
      if (!set) this.watchers.set(id, (set = new Set()));
      set.add(client);
    }
    return userIds.map((id) => this.publicEntry(id));
  }

  unwatchAll(client: ClientHandle) {
    for (const id of client.presenceWatch) {
      const set = this.watchers.get(id);
      set?.delete(client);
      if (set && set.size === 0) this.watchers.delete(id);
    }
    client.presenceWatch.clear();
  }

  private fedEntry(userId: string): FedEntry {
    const agg = this.localAggregate(userId);
    if (!agg) return { userId, status: 'offline', since: Date.now(), devices: [] };
    return {
      userId,
      status: agg.status,
      ...(agg.text ? { text: agg.text } : {}),
      since: agg.since,
      devices: this.localOf(userId).map((c) => c.deviceId),
    };
  }

  localEntries(): FedEntry[] {
    return [...this.localDevices.keys()].map((u) => this.fedEntry(u));
  }

  /** Our latest presence seq, announced in beacons. */
  get latestSeq() {
    return this.ownSeq;
  }

  /**
   * A beacon says `origin`'s presence is at `seq`. If we have seen less, we
   * missed something (an offline user, say): fetch its full presence.
   */
  checkOrigin(origin: string, seq: number) {
    if (seq <= (this.originSeq.get(origin) ?? 0)) return;
    const now = Date.now();
    // At most once per beacon period, so a lost answer is asked again soon.
    if (now - (this.askedAt.get(origin) ?? 0) < this.hub.membership.timing.beaconMs) return;
    this.askedAt.set(origin, now);
    this.hub.mesh
      .request<FedPresence>(origin, 'presence_state', {})
      .then((frame) => {
        // A response is checked like a flooded frame.
        const checked = FedFrameSchema.safeParse(frame);
        if (checked.success && checked.data.t === 'presence' && checked.data.origin === origin)
          this.applyRemote(checked.data);
      })
      .catch(() => {});
  }

  /** Our users, all of them, for a server that asked. */
  fullState(): FedPresence {
    // Not a new seq: a snapshot isn't news, and a new seq here would make
    // every server that didn't get the snapshot ask us for it.
    if (this.fullCache?.seq !== this.ownSeq) {
      this.fullCache = this.signed(this.ownSeq, true, this.localEntries());
    }
    return this.fullCache;
  }

  private signed(seq: number, full: boolean, entries: FedEntry[]): FedPresence {
    const parts = { origin: this.hub.info.id, seq, full, entries };
    return {
      t: 'presence',
      ...parts,
      key: this.hub.info.key,
      sig: sign(this.hub.identity, SIG_DOMAIN.presence, presenceSigned(parts)),
    };
  }

  private nextSeq() {
    this.ownSeq = Math.max(Date.now(), this.ownSeq + 1);
    return this.ownSeq;
  }

  /**
   * News from another server, which must be signed by the server it names.
   * Returns true if any of it was new (so it travels on).
   */
  applyRemote(frame: FedPresence): boolean {
    const origin = frame.origin;
    if (!origin || origin === this.hub.info.id || typeof frame.seq !== 'number') return false;
    // Sequence numbers are timestamps: one far ahead would outrank everything
    // the origin says afterwards.
    if (!(frame.seq <= Date.now() + SEQ_AHEAD_MS)) return false;
    const isNew = (userId: string) => (this.seqs.get(`${origin}|${userId}`) ?? 0) < frame.seq;
    const listed = new Set(frame.entries.map((e) => e.userId));
    const dropped: string[] = [];
    if (frame.full) {
      for (const [userId, entries] of this.remote) {
        if (entries.has(origin) && !listed.has(userId) && isNew(userId)) dropped.push(userId);
      }
    }
    const fresh = frame.entries.filter((e) => isNew(e.userId));
    // Old news is not worth checking a signature for.
    if (
      frame.seq <= (this.originSeq.get(origin) ?? 0) &&
      fresh.length === 0 &&
      dropped.length === 0
    )
      return false;
    if (
      !keyMatchesUserId(frame.key, origin) ||
      !verifyPayload(frame.key, SIG_DOMAIN.presence, presenceSigned(frame), frame.sig)
    )
      return false;
    if (frame.seq > (this.originSeq.get(origin) ?? 0)) this.originSeq.set(origin, frame.seq);
    const touched = new Set<string>();
    for (const userId of dropped) {
      const entries = this.remote.get(userId)!;
      entries.delete(origin);
      if (entries.size === 0) this.remote.delete(userId);
      this.seqs.set(`${origin}|${userId}`, frame.seq);
      touched.add(userId);
    }
    for (const e of fresh) {
      this.seqs.set(`${origin}|${e.userId}`, frame.seq);
      let entries = this.remote.get(e.userId);
      if (!entries) this.remote.set(e.userId, (entries = new Map()));
      if (e.status === 'offline' || e.devices.length === 0) entries.delete(origin);
      else
        entries.set(origin, {
          status: e.status,
          text: e.text,
          since: e.since,
          devices: e.devices,
          seq: frame.seq,
        });
      if (entries.size === 0) this.remote.delete(e.userId);
      touched.add(e.userId);
    }
    for (const userId of touched) this.changed(userId, false);
    return touched.size > 0;
  }

  /** A server stopped being live: forget its users (newer news brings them back). */
  dropServer(serverId: string) {
    for (const [userId, entries] of [...this.remote]) {
      if (!entries.delete(serverId)) continue;
      if (entries.size === 0) this.remote.delete(userId);
      this.changed(userId, false);
    }
  }

  /**
   * What a server that just linked to us is told: our own users, signed. What
   * we know of other servers' users is not repeated, because we can't sign it
   * and a signed frame we kept would bring back users who have since left. The
   * newcomer hears every server's beacon, sees that its presence is ahead of
   * what it has, and fetches that server's current picture itself.
   */
  snapshot(): FedPresence[] {
    return [this.fullState()];
  }

  private lastPublished = new Map<string, string>();

  private changed(userId: string, local: boolean) {
    if (local) this.hub.mesh.forward(this.signed(this.nextSeq(), false, [this.fedEntry(userId)]));
    const entry = this.publicEntry(userId);
    const fingerprint = `${entry.status}|${entry.text ?? ''}`;
    if ((this.lastPublished.get(userId) ?? 'offline|') === fingerprint) return;
    if (entry.status === 'offline') this.lastPublished.delete(userId);
    else this.lastPublished.set(userId, fingerprint);
    for (const w of this.watchers.get(userId) ?? []) w.send('presence', entry);
  }
}
