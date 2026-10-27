import { keyMatchesUserId, sign, verifyPayload } from '@crocodile/crypto';
import { ServerInfo, SIG_DOMAIN, type FedBeacon } from '@crocodile/protocol';
import type { Coordinator } from './coordinator';
import { View } from './placement';
import { RateLimiter } from './util';

export interface MembershipTiming {
  /** How often each server announces itself. */
  beaconMs: number;
  /** A server we have no link to is live while its last beacon is this recent. */
  liveMs: number;
  /** How long the live set must stay unchanged before records are moved. */
  settleMs: number;
}

export const defaultMembershipTiming: MembershipTiming = {
  beaconMs: 20_000,
  liveMs: 70_000,
  settleMs: 3_000,
};

/**
 * Servers cost nothing to make up, so a link may only introduce so many we have not heard of: a
 * network's worth when it first connects (the burst), then a few a second. At most this many
 * servers are tracked at all.
 */
const NEW_SERVERS_BURST = 1000;
const NEW_SERVERS_PER_SECOND = 5;
const MAX_TRACKED_SERVERS = 5000;
/** A beacon is forgotten when it is this many times older than a live one could be. */
const FORGET_AFTER_LIVE = 10;

type Listener = {
  up?: (id: string) => void;
  down?: (id: string) => void;
  settled?: (before: View, after: View) => void;
};

/**
 * Which servers are live, and the view of who owns what that follows from it
 * (docs/MESH.md). A server is live while we hold a link to it or have heard
 * its signed beacon recently; beacons are flooded through the overlay.
 */
export class Membership {
  private beacons = new Map<string, { frame: FedBeacon; at: number }>();
  private linked = new Set<string>();
  private liveSet = new Set<string>();
  /** The live servers that keep a full copy, when the current view was built. */
  private fullSet = new Set<string>();
  /** How many unknown servers each link may still introduce. */
  private introductions = new Map<string, RateLimiter>();
  private currentView: View;
  private settledView: View;
  private settledSince = Date.now();
  private settleTimer?: ReturnType<typeof setTimeout>;
  private beaconTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private listeners: Listener[] = [];
  private own?: FedBeacon;

  constructor(
    private readonly hub: Coordinator,
    readonly timing: MembershipTiming,
  ) {
    this.liveSet.add(this.selfId);
    this.currentView = this.buildView();
    this.settledView = this.currentView;
  }

  private get selfId() {
    return this.hub.identity.userId;
  }

  start() {
    this.announce();
    this.beaconTimer = setInterval(() => this.announce(), this.timing.beaconMs);
    this.beaconTimer.unref?.();
    this.sweepTimer = setInterval(() => this.recompute(), Math.max(250, this.timing.beaconMs / 2));
    this.sweepTimer.unref?.();
  }

  stop() {
    clearInterval(this.beaconTimer);
    clearInterval(this.sweepTimer);
    clearTimeout(this.settleTimer);
  }

  on(listener: Listener) {
    this.listeners.push(listener);
  }

  /** Who owns what, as of now. */
  get view() {
    return this.currentView;
  }

  /** The view once the live set had stopped changing; records are moved by it. */
  get settled() {
    return this.settledView;
  }

  /** Since when the settled view has held. */
  get stableSince() {
    return this.settledSince;
  }

  liveIds(): string[] {
    return [...this.liveSet].sort();
  }

  isLive(id: string) {
    return this.liveSet.has(id);
  }

  /** Our latest beacon, and every fresh one we hold (for a new neighbour). */
  freshBeacons(): FedBeacon[] {
    const now = Date.now();
    const out = this.own ? [this.own] : [];
    for (const { frame, at } of this.beacons.values())
      if (now - at < this.timing.liveMs) out.push(frame);
    return out;
  }

  private announce() {
    const server = this.hub.info;
    // Timestamps as sequence numbers keep increasing across restarts.
    const seq = Math.max(Date.now(), (this.own?.seq ?? 0) + 1);
    const full = !!this.hub.config.storeAll;
    const presence = this.hub.presence.latestSeq;
    this.own = {
      t: 'beacon',
      server,
      seq,
      full,
      presence,
      sig: sign(this.hub.identity, SIG_DOMAIN.beacon, { server, seq, full, presence }),
    };
    this.hub.mesh.forward(this.own);
    this.recompute();
  }

  /** A beacon from the overlay. Returns true if it was news (and should travel on). */
  onBeacon(frame: FedBeacon, from?: string): boolean {
    const parsed = ServerInfo.safeParse(frame.server);
    if (!parsed.success) return false;
    const { id, key } = parsed.data;
    if (id === this.selfId || !keyMatchesUserId(key, id)) return false;
    const now = Date.now();
    if (typeof frame.seq !== 'number' || frame.seq > now + 5 * 60_000) return false;
    if (frame.seq < now - this.timing.liveMs) return false;
    const known = this.beacons.get(id);
    if (known && known.frame.seq >= frame.seq) return false;
    // Before checking a signature, see whether we would take the server at all.
    if (!known && !this.mayIntroduce(from)) return false;
    if (
      !verifyPayload(
        key,
        SIG_DOMAIN.beacon,
        { server: frame.server, seq: frame.seq, full: frame.full, presence: frame.presence },
        frame.sig,
      )
    )
      return false;
    this.beacons.set(id, { frame: { ...frame, server: parsed.data }, at: now });
    this.hub.mesh.addKnown([parsed.data]);
    this.recompute();
    if (typeof frame.presence === 'number') this.hub.presence.checkOrigin(id, frame.presence);
    return true;
  }

  /** Whether the link `from` may tell us of one more server we do not know. */
  private mayIntroduce(from?: string): boolean {
    if (this.beacons.size >= MAX_TRACKED_SERVERS) return false;
    if (from === undefined) return true;
    let limiter = this.introductions.get(from);
    if (!limiter) {
      limiter = new RateLimiter(NEW_SERVERS_PER_SECOND, NEW_SERVERS_BURST);
      this.introductions.set(from, limiter);
    }
    return limiter.take();
  }

  linkUp(id: string) {
    this.linked.add(id);
    this.recompute();
  }

  /**
   * A link went away. If it broke (rather than being closed for idleness),
   * the server may be gone: only a newer beacon brings it back.
   */
  linkDown(id: string, broke: boolean) {
    this.linked.delete(id);
    this.introductions.delete(id);
    const b = this.beacons.get(id);
    if (broke && b) b.at = 0;
    this.recompute();
  }

  private isFull(id: string) {
    if (id === this.selfId) return !!this.hub.config.storeAll;
    return !!this.beacons.get(id)?.frame.full;
  }

  private buildView() {
    const live = [...this.liveSet];
    return new View(
      live,
      live.filter((id) => this.isFull(id)),
      this.hub.config.replicas,
    );
  }

  private recompute() {
    const now = Date.now();
    const next = new Set<string>([this.selfId, ...this.linked]);
    for (const [id, b] of this.beacons) {
      if (now - b.at < this.timing.liveMs) next.add(id);
      else if (!this.linked.has(id) && now - b.at > this.timing.liveMs * FORGET_AFTER_LIVE)
        this.beacons.delete(id);
    }
    const up = [...next].filter((id) => !this.liveSet.has(id));
    const down = [...this.liveSet].filter((id) => !next.has(id));
    this.liveSet = next;
    // Building the ring costs a hash for every point of every server: only when something moved.
    const full = new Set([...next].filter((id) => this.isFull(id)));
    const fullMoved =
      full.size !== this.fullSet.size || [...full].some((id) => !this.fullSet.has(id));
    this.fullSet = full;
    const view = up.length || down.length || fullMoved ? this.buildView() : undefined;
    if (view && !view.equals(this.currentView)) {
      this.currentView = view;
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.settle(), this.timing.settleMs);
      this.settleTimer.unref?.();
    }
    for (const id of down) for (const l of this.listeners) l.down?.(id);
    for (const id of up) for (const l of this.listeners) l.up?.(id);
  }

  private settle() {
    if (this.currentView.equals(this.settledView)) return;
    const before = this.settledView;
    this.settledView = this.currentView;
    this.settledSince = Date.now();
    for (const l of this.listeners) l.settled?.(before, this.settledView);
  }
}
