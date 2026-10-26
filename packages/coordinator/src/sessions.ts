import { isSpaceMember, keyMatchesUserId, randomId, sign, verifyPayload } from '@crocodile/crypto';
import {
  DEFAULT_RELAY_SLOTS,
  LIMITS,
  SIG_DOMAIN,
  parseSessionId,
  peerIds,
  voiceSigned,
  type FedSessionOp,
  type FedVoice,
  type HostCaps,
  type SessionOp,
  type SessionState,
  type SignedRecord,
  type VoiceOccupancy,
} from '@crocodile/protocol';
import type { Coordinator } from './coordinator';
import { elect, rendezvousOwner } from './election';
import { RpcFailure } from './util';
import type { ClientHandle } from './presence';

interface OwnedSession {
  state: SessionState;
  memberServer: Map<string, string>;
  penalties: Map<string, number>;
  reports: Set<string>;
  /** Host adopted from a hint whose member has not re-joined yet. */
  pendingHostUntil: number;
  timer?: ReturnType<typeof setTimeout>;
}

type Hint = { epoch: number; host: string | null; backup: string | null };

const PENDING_HOST_GRACE_MS = 4000;
const HOST_PENALTY_MS = 60_000;
const OP_TIMEOUT_MS = 8000;
const MEMBER_RECONNECT_GRACE_MS = 10_000;
/** A member server re-joins a session whose new owner it could not reach this soon. */
const REJOIN_RETRY_MS = 1000;
/**
 * The owner repeats what it says about an occupied room this often, and a
 * server believes an announcement for this long: an old one that someone
 * replays does not bring a long-empty room back.
 */
const VOICE_REFRESH_MS = 5 * 60_000;
const VOICE_MAX_AGE_MS = 15 * 60_000;
/** An announcement dated further ahead than this is refused. */
const VOICE_AHEAD_MS = 5 * 60_000;
/**
 * How long an operation from a server waits for news that the member is connected
 * to it (the news may still be on its way), and how many may wait at once.
 */
const HOSTING_GRACE_MS = 1500;
const HOSTING_WAITERS_MAX = 200;
/** A new owner adopts the epoch a member saw; no honest session has changed host this often. */
const HINT_EPOCH_MAX = 1_000_000;

/**
 * Sessions and host election.
 *
 * Each session is owned by exactly one coordination server, chosen by
 * rendezvous hashing over the live mesh. Members' own servers keep a registry
 * of which local clients are in which session and forward operations to the
 * owner; when the mesh changes and a session gets a new owner, the member
 * servers simply re-submit their joins (with a hint of the last known host)
 * so the new owner rebuilds identical state without disturbing the call.
 */
export class SessionService {
  /** sessionId -> local peer id -> caps */
  private local = new Map<string, Map<string, HostCaps>>();
  private lastOwner = new Map<string, string>();
  private lastKnown = new Map<string, Hint>();
  private owned = new Map<string, OwnedSession>();
  /** `frame` is what the owner signed, kept to hand on as it was (none if we made the entry up). */
  private occupancy = new Map<string, { occ: VoiceOccupancy; owner: string; frame?: FedVoice }>();
  private pendingOps = new Map<
    string,
    {
      server: string;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private voiceRefresh: ReturnType<typeof setInterval>;

  constructor(private readonly hub: Coordinator) {
    this.voiceRefresh = setInterval(() => this.refreshVoice(), VOICE_REFRESH_MS);
    this.voiceRefresh.unref?.();
  }

  get selfId() {
    return this.hub.info.id;
  }

  liveServers(): string[] {
    return this.hub.membership.liveIds();
  }

  ownerOf(sessionId: string): string {
    return rendezvousOwner(sessionId, this.liveServers());
  }

  // -------------------------------------------------------------------------
  // Client-facing operations (called on the member's own server)
  // -------------------------------------------------------------------------

  async checkAccess(userId: string, sessionId: string) {
    const scope = parseSessionId(sessionId);
    if (!scope) throw new RpcFailure('bad_request', 'invalid session id');
    if (scope.kind === 'space' || scope.kind === 'voice') {
      // The space's records may live on other servers.
      const records = await this.hub.dist.get([
        `space:${scope.spaceId}`,
        `member:${scope.spaceId}:${userId}`,
      ]);
      const byKey = new Map(records.map((r) => [r.key, r]));
      if (!isSpaceMember({ get: (k) => byKey.get(k) }, scope.spaceId, userId))
        throw new RpcFailure('forbidden', 'not a member of this space');
      if (scope.kind === 'voice') {
        const space = byKey.get(`space:${scope.spaceId}`) as SignedRecord<'space'>;
        const channel = space.body.channels.find((c) => c.id === scope.channelId);
        if (!channel || channel.kind !== 'voice')
          throw new RpcFailure('not_found', 'no such voice channel');
      }
      return;
    }
    const [a, b] = scope.users;
    if (userId !== a && userId !== b)
      throw new RpcFailure('forbidden', 'not part of this conversation');
    // Blocks are enforced by the blocking user's apps: block lists are sealed,
    // so servers can't (and shouldn't) know who blocked whom.
  }

  inSession(peer: string, sessionId: string) {
    return this.local.get(sessionId)?.has(peer) ?? false;
  }

  async join(client: ClientHandle, sessionId: string, caps: HostCaps): Promise<SessionState> {
    await this.checkAccess(client.userId, sessionId);
    const leaveKey = `${sessionId}|${client.peer}`;
    clearTimeout(this.pendingLeaves.get(leaveKey));
    this.pendingLeaves.delete(leaveKey);
    let members = this.local.get(sessionId);
    if (!members) this.local.set(sessionId, (members = new Map()));
    members.set(client.peer, caps);
    this.lastOwner.set(sessionId, this.ownerOf(sessionId));
    const hint = this.lastKnown.get(sessionId);
    const state = (await this.submit(sessionId, client.peer, {
      op: 'join',
      caps,
      ...(hint ? { hint } : {}),
    })) as SessionState;
    return state;
  }

  async update(client: ClientHandle, sessionId: string, caps: HostCaps) {
    const members = this.local.get(sessionId);
    if (!members?.has(client.peer)) throw new RpcFailure('not_found', 'not in session');
    members.set(client.peer, caps);
    await this.submit(sessionId, client.peer, { op: 'update', caps });
  }

  async leave(peer: string, sessionId: string) {
    const members = this.local.get(sessionId);
    if (!members?.delete(peer)) return;
    if (members.size === 0) {
      this.local.delete(sessionId);
      this.lastOwner.delete(sessionId);
      this.lastKnown.delete(sessionId);
    }
    await this.submit(sessionId, peer, { op: 'leave' }).catch(() => {});
  }

  async report(client: ClientHandle, sessionId: string, epoch: number) {
    if (!this.inSession(client.peer, sessionId))
      throw new RpcFailure('not_found', 'not in session');
    await this.submit(sessionId, client.peer, { op: 'report', epoch, issue: 'host_unreachable' });
  }

  private pendingLeaves = new Map<string, ReturnType<typeof setTimeout>>();
  private orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();

  onClientReplaced(peer: string) {
    for (const [sessionId, members] of this.local) {
      if (!members.has(peer)) continue;
      const key = `${sessionId}|${peer}`;
      clearTimeout(this.pendingLeaves.get(key));
      const timer = setTimeout(() => {
        this.pendingLeaves.delete(key);
        void this.leave(peer, sessionId);
      }, 10_000);
      timer.unref?.();
      this.pendingLeaves.set(key, timer);
    }
  }

  onClientGone(peer: string) {
    for (const [sessionId, members] of [...this.local]) {
      if (members.has(peer)) void this.leave(peer, sessionId);
    }
  }

  /** Called when a 'session' event reaches a local member: remember the host. */
  noteState(state: SessionState) {
    if (this.local.has(state.id))
      this.lastKnown.set(state.id, { epoch: state.epoch, host: state.host, backup: state.backup });
  }

  /** Sessions the given local peer is in (for tests and diagnostics). */
  sessionsOf(peer: string) {
    return [...this.local].filter(([, m]) => m.has(peer)).map(([id]) => id);
  }

  ownedState(sessionId: string): SessionState | undefined {
    return this.owned.get(sessionId)?.state;
  }

  // -------------------------------------------------------------------------
  // Routing to the owner
  // -------------------------------------------------------------------------

  private submit(sessionId: string, peer: string, op: SessionOp): Promise<unknown> {
    const owner = this.ownerOf(sessionId);
    if (owner === this.selfId) {
      try {
        return Promise.resolve(this.apply(sessionId, peer, this.selfId, op));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    const opId = randomId(8);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOps.delete(opId);
        reject(new RpcFailure('unavailable', 'session owner did not respond'));
      }, OP_TIMEOUT_MS);
      this.pendingOps.set(opId, { server: owner, resolve, reject, timer });
      const sent = this.hub.mesh.sendTo(owner, { t: 'session_op', opId, sessionId, peer, op });
      if (!sent) {
        clearTimeout(timer);
        this.pendingOps.delete(opId);
        reject(new RpcFailure('unavailable', 'session owner unreachable'));
      }
    });
  }

  /** Operations on one session are applied one at a time, in the order they arrived. */
  private opChains = new Map<string, Promise<void>>();
  private hostingWaiters = 0;

  handleRemoteOp(fromServer: string, frame: FedSessionOp) {
    const reply = (res: { ok: unknown } | { err: unknown }) =>
      this.hub.mesh.sendTo(fromServer, { t: 'session_op_res', opId: frame.opId, ...res } as never);
    const fail = (err: unknown) =>
      reply({
        err: {
          code: err instanceof RpcFailure ? err.code : 'internal',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    void this.connectedTo(fromServer, frame.peer).then((connected) => {
      if (!connected) {
        fail(new RpcFailure('forbidden', 'that device is not connected to the sending server'));
        return;
      }
      const previous = this.opChains.get(frame.sessionId) ?? Promise.resolve();
      const run: Promise<void> = previous.then(async () => {
        try {
          reply({ ok: await this.runRemoteOp(fromServer, frame) });
        } catch (err) {
          fail(err);
        }
      });
      this.opChains.set(frame.sessionId, run);
      void run.then(() => {
        if (this.opChains.get(frame.sessionId) === run) this.opChains.delete(frame.sessionId);
      });
    });
  }

  /**
   * Whether the server may act for this device: it has told the mesh the
   * device is connected to it. News of a device that has only just connected
   * can still be on its way, so it is waited for briefly.
   */
  private async connectedTo(server: string, peer: string): Promise<boolean> {
    const presence = this.hub.presence;
    if (presence.hosts(server, peer)) return true;
    if (this.hostingWaiters >= HOSTING_WAITERS_MAX) return false;
    this.hostingWaiters += 1;
    try {
      const until = Date.now() + HOSTING_GRACE_MS;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50));
        if (presence.hosts(server, peer)) return true;
      }
      return false;
    } finally {
      this.hostingWaiters -= 1;
    }
  }

  /** The owner's side of an operation: whoever joins must still be allowed, and so must the host they name. */
  private async runRemoteOp(fromServer: string, frame: FedSessionOp): Promise<unknown> {
    let op = frame.op;
    if (op.op === 'join') {
      await this.checkAccess(peerIds.user(frame.peer), frame.sessionId);
      if (op.hint) {
        const { hint, ...rest } = op;
        op = (await this.hintAllowed(frame.sessionId, hint)) ? op : rest;
      }
    }
    return this.apply(frame.sessionId, frame.peer, fromServer, op);
  }

  /** A hint is believed only if the host and backup it names may be in the session. */
  private async hintAllowed(sessionId: string, hint: Hint): Promise<boolean> {
    if (hint.epoch < 0 || hint.epoch > HINT_EPOCH_MAX) return false;
    try {
      for (const peer of [hint.host, hint.backup]) {
        if (peer) await this.checkAccess(peerIds.user(peer), sessionId);
      }
      return true;
    } catch {
      return false;
    }
  }

  handleRemoteResult(opId: string, ok: unknown, err?: { code: string; message: string }) {
    const pending = this.pendingOps.get(opId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingOps.delete(opId);
    if (err) pending.reject(new RpcFailure(err.code as RpcFailure['code'], err.message));
    else pending.resolve(ok);
  }

  // -------------------------------------------------------------------------
  // Owner-side state machine
  // -------------------------------------------------------------------------

  private apply(sessionId: string, peer: string, serverId: string, op: SessionOp): unknown {
    const userId = peerIds.user(peer);
    const scope = parseSessionId(sessionId);
    if (!scope) throw new RpcFailure('bad_request', 'invalid session id');
    const now = Date.now();
    let s = this.owned.get(sessionId);

    if (op.op === 'join') {
      if (!s) {
        s = {
          state: {
            id: sessionId,
            epoch: 0,
            host: null,
            backup: null,
            members: [],
            relaySlots: scope.kind === 'voice' ? DEFAULT_RELAY_SLOTS : scope.kind === 'dm' ? 1 : 0,
            updatedAt: now,
          },
          memberServer: new Map(),
          penalties: new Map(),
          reports: new Set(),
          pendingHostUntil: 0,
        };
        this.owned.set(sessionId, s);
      }
      if (op.hint && op.hint.epoch > s.state.epoch) {
        s.state.epoch = op.hint.epoch;
        s.state.host = op.hint.host;
        s.state.backup = op.hint.backup;
        s.pendingHostUntil = now + PENDING_HOST_GRACE_MS;
        this.scheduleRecheck(s, PENDING_HOST_GRACE_MS + 50);
      }
      const existing = s.state.members.find((m) => m.peer === peer);
      if (existing) existing.caps = op.caps;
      else {
        if (s.state.members.length >= LIMITS.sessionMembersMax)
          throw new RpcFailure('conflict', 'session is full');
        s.state.members.push({ peer, userId, joinedAt: now, caps: op.caps });
      }
      s.memberServer.set(peer, serverId);
      clearTimeout(this.orphanTimers.get(`${sessionId}|${peer}`));
      this.orphanTimers.delete(`${sessionId}|${peer}`);
      this.recompute(s);
      if (scope.kind === 'dm') {
        const other = scope.users[0] === userId ? scope.users[1] : scope.users[0];
        if (!s.state.members.some((m) => m.userId === other)) {
          this.hub.deliver(other, 'session_invite', { sessionId, from: userId });
        }
      }
      return s.state;
    }

    if (!s) return {};
    const member = s.state.members.find((m) => m.peer === peer);
    // Only the server a member joined from speaks for it afterwards.
    if (member && s.memberServer.get(peer) !== serverId) return {};
    switch (op.op) {
      case 'update':
        if (member) {
          member.caps = op.caps;
          this.recompute(s);
        }
        return {};
      case 'leave':
        this.removeMember(s, peer);
        return {};
      case 'report': {
        if (!member || op.epoch !== s.state.epoch || !s.state.host || peer === s.state.host)
          return {};
        s.reports.add(peer);
        const others = s.state.members.length - 1;
        if (s.reports.size >= Math.max(1, Math.ceil(others / 2))) {
          s.penalties.set(s.state.host, now + HOST_PENALTY_MS);
          this.hub.log.info('host reported unreachable; failing over', {
            sessionId,
            host: s.state.host,
          });
          this.recompute(s);
        }
        return {};
      }
    }
  }

  private removeMember(s: OwnedSession, peer: string) {
    const before = s.state.members.length;
    s.state.members = s.state.members.filter((m) => m.peer !== peer);
    s.memberServer.delete(peer);
    s.reports.delete(peer);
    if (s.state.members.length === before) return;
    if (s.state.members.length === 0) {
      this.dropOwned(s.state.id, true);
      return;
    }
    this.recompute(s);
  }

  private dropOwned(sessionId: string, announceEmpty: boolean) {
    const s = this.owned.get(sessionId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.owned.delete(sessionId);
    if (announceEmpty) {
      s.state.members = [];
      s.state.host = null;
      s.state.backup = null;
      this.announceVoice(s.state);
    }
  }

  private scheduleRecheck(s: OwnedSession, delay: number) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = undefined;
      if (this.owned.get(s.state.id) === s) this.recompute(s);
    }, delay);
    s.timer.unref?.();
  }

  private recompute(s: OwnedSession) {
    const now = Date.now();
    const st = s.state;
    const prevHost = st.host;
    const hostIsMember = !!st.host && st.members.some((m) => m.peer === st.host);
    let result: { host: string | null; backup: string | null };
    if (st.host && !hostIsMember && s.pendingHostUntil > now) {
      // The adopted host has not re-joined yet; keep it during the grace period.
      const others = elect({
        members: st.members,
        host: null,
        backup: st.backup,
        penalties: s.penalties,
        now,
      });
      result = { host: st.host, backup: others.host === st.host ? others.backup : others.host };
    } else {
      result = elect({
        members: st.members,
        host: st.host,
        backup: st.backup,
        penalties: s.penalties,
        now,
      });
    }
    st.host = result.host;
    st.backup = result.backup;
    if (st.host !== prevHost) {
      st.epoch += 1;
      s.reports.clear();
    }
    st.updatedAt = now;
    this.broadcast(s);
    // Re-evaluate when a penalty expires so a recovered peer can serve as backup again.
    const nextPenalty = Math.min(...[...s.penalties.values()].filter((t) => t > now));
    if (Number.isFinite(nextPenalty) && !s.timer) this.scheduleRecheck(s, nextPenalty - now + 10);
  }

  private broadcast(s: OwnedSession) {
    for (const m of s.state.members) {
      // We know each member's server: no need to look it up.
      const server = s.memberServer.get(m.peer);
      const d = { state: s.state };
      if (server && server !== this.selfId) {
        this.hub.mesh.sendTo(server, { t: 'route', to: m.peer, ev: 'session', d });
      } else this.hub.deliverToPeer(m.peer, 'session', d);
    }
    this.announceVoice(s.state);
  }

  // -------------------------------------------------------------------------
  // Voice channel occupancy (flooded, so any server can answer voice.watch)
  // -------------------------------------------------------------------------

  /** sessionId -> when its latest announcement was made (kept after it empties). */
  private voiceAt = new Map<string, number>();
  /** Rooms that emptied in the last hour, so a server that missed it hears it in a snapshot. */
  private emptied = new Map<
    string,
    { occ: VoiceOccupancy; owner: string; at: number; frame?: FedVoice }
  >();
  private voiceSeq = 0;

  private announceVoice(state: SessionState) {
    const scope = parseSessionId(state.id);
    if (!scope || scope.kind !== 'voice') return;
    const occ: VoiceOccupancy = {
      spaceId: scope.spaceId,
      channelId: scope.channelId,
      members: [...new Set(state.members.map((m) => m.userId))],
      host: state.host ? peerIds.user(state.host) : null,
    };
    this.voiceSeq = Math.max(Date.now(), this.voiceSeq + 1);
    const at = this.voiceSeq;
    this.voiceAt.set(state.id, at);
    const parts = { sessionId: state.id, occ, owner: this.selfId, at };
    const frame: FedVoice = {
      t: 'voice',
      ...parts,
      key: this.hub.info.key,
      sig: sign(this.hub.identity, SIG_DOMAIN.voice, voiceSigned(parts)),
    };
    this.setOccupancy(state.id, occ, this.selfId, frame);
    this.hub.mesh.forward(frame);
  }

  /** Say again what we have said about the rooms we own that are occupied. */
  private refreshVoice() {
    for (const s of this.owned.values())
      if (s.state.members.length > 0) this.announceVoice(s.state);
  }

  /**
   * An announcement from another server: signed by the owner of the room, which
   * is the server we also take to own it, and recent. Returns true if it was news.
   */
  applyRemoteVoice(frame: FedVoice): boolean {
    if (frame.owner === this.selfId || typeof frame.at !== 'number') return false;
    const now = Date.now();
    if (!(frame.at <= now + VOICE_AHEAD_MS) || !(frame.at >= now - VOICE_MAX_AGE_MS)) return false;
    if ((this.voiceAt.get(frame.sessionId) ?? 0) >= frame.at) return false;
    const scope = parseSessionId(frame.sessionId);
    if (
      scope?.kind !== 'voice' ||
      scope.spaceId !== frame.occ.spaceId ||
      scope.channelId !== frame.occ.channelId ||
      this.ownerOf(frame.sessionId) !== frame.owner
    )
      return false;
    if (
      !keyMatchesUserId(frame.key, frame.owner) ||
      !verifyPayload(frame.key, SIG_DOMAIN.voice, voiceSigned(frame), frame.sig)
    )
      return false;
    this.voiceAt.set(frame.sessionId, frame.at);
    this.setOccupancy(frame.sessionId, frame.occ, frame.owner, frame);
    return true;
  }

  private setOccupancy(sessionId: string, occ: VoiceOccupancy, owner: string, frame?: FedVoice) {
    if (occ.members.length === 0) {
      this.occupancy.delete(sessionId);
      this.emptied.set(sessionId, { occ, owner, at: Date.now(), frame });
    } else {
      this.occupancy.set(sessionId, { occ, owner, frame });
      this.emptied.delete(sessionId);
    }
    if (this.voiceAt.size > 100_000) {
      for (const id of this.voiceAt.keys()) if (!this.occupancy.has(id)) this.voiceAt.delete(id);
    }
    for (const client of this.hub.presence.localClients()) {
      if (client.voiceWatch.has(occ.spaceId)) client.send('voice', occ);
    }
  }

  voiceSnapshot(spaceIds: string[]): VoiceOccupancy[] {
    const wanted = new Set(spaceIds);
    return [...this.occupancy.values()].map((o) => o.occ).filter((o) => wanted.has(o.spaceId));
  }

  /** Every room we know is occupied, as its owner announced it, for a server that just linked to us. */
  voiceFrames(): FedVoice[] {
    const now = Date.now();
    for (const [id, e] of this.emptied) if (e.at < now - 3600_000) this.emptied.delete(id);
    return [...this.occupancy.values(), ...this.emptied.values()]
      .map((o) => o.frame)
      .filter((f): f is FedVoice => !!f && f.at >= now - VOICE_MAX_AGE_MS);
  }

  // -------------------------------------------------------------------------
  // Mesh membership changes
  // -------------------------------------------------------------------------

  onServerUp() {
    this.rebalance();
  }

  onServerDown(serverId: string) {
    for (const [opId, p] of this.pendingOps) {
      if (p.server === serverId) {
        clearTimeout(p.timer);
        this.pendingOps.delete(opId);
        p.reject(new RpcFailure('unavailable', 'session owner went away'));
      }
    }
    // Members of the lost server get a grace period to reconnect through
    // another server before we treat them as gone; this avoids needless host
    // failovers when only a coordinator (not the peer) went away.
    for (const s of [...this.owned.values()]) {
      for (const [peer, server] of [...s.memberServer]) {
        if (server !== serverId) continue;
        const key = `${s.state.id}|${peer}`;
        clearTimeout(this.orphanTimers.get(key));
        const timer = setTimeout(() => {
          this.orphanTimers.delete(key);
          const current = this.owned.get(s.state.id);
          if (current && current.memberServer.get(peer) === serverId)
            this.removeMember(current, peer);
        }, MEMBER_RECONNECT_GRACE_MS);
        timer.unref?.();
        this.orphanTimers.set(key, timer);
      }
    }
    for (const [sessionId, o] of [...this.occupancy]) {
      if (o.owner === serverId)
        this.setOccupancy(sessionId, { ...o.occ, members: [], host: null }, serverId);
    }
    this.rebalance();
  }

  private rebalanceTimer: ReturnType<typeof setTimeout> | undefined;

  private rebalance() {
    clearTimeout(this.rebalanceTimer);
    this.rebalanceTimer = undefined;
    for (const sessionId of [...this.owned.keys()]) {
      if (this.ownerOf(sessionId) !== this.selfId) this.dropOwned(sessionId, false);
    }
    for (const [sessionId, members] of this.local) {
      const owner = this.ownerOf(sessionId);
      if (this.lastOwner.get(sessionId) === owner) continue;
      this.lastOwner.set(sessionId, owner);
      const hint = this.lastKnown.get(sessionId);
      for (const [peer, caps] of members) {
        this.submit(sessionId, peer, { op: 'join', caps, ...(hint ? { hint } : {}) }).catch(
          (err) => {
            this.hub.log.warn('re-join after owner change failed', { sessionId, err: String(err) });
            // Try again shortly, unless the owner changed meanwhile (that re-joins anyway).
            if (this.lastOwner.get(sessionId) !== owner) return;
            this.lastOwner.delete(sessionId);
            this.rebalanceTimer ??= setTimeout(() => this.rebalance(), REJOIN_RETRY_MS);
            this.rebalanceTimer.unref?.();
          },
        );
      }
    }
  }

  close() {
    clearTimeout(this.rebalanceTimer);
    clearInterval(this.voiceRefresh);
    for (const t of this.pendingLeaves.values()) clearTimeout(t);
    for (const t of this.orphanTimers.values()) clearTimeout(t);
    for (const s of this.owned.values()) if (s.timer) clearTimeout(s.timer);
    for (const p of this.pendingOps.values()) clearTimeout(p.timer);
  }
}
