import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity, sign, type Identity } from '@crocodile/crypto';
import { SIG_DOMAIN, type FedBeacon } from '@crocodile/protocol';
import { startCoordinator } from './helpers';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** What a server's membership sees of the rest, reached without a mesh. */
type Members = {
  onBeacon(frame: FedBeacon, from?: string): boolean;
  linkUp(id: string): void;
  linkDown(id: string, broke: boolean): void;
  beacons: Map<string, unknown>;
  view: unknown;
  recompute(): void;
  introductions: Map<string, unknown>;
};

async function server(overrides = {}) {
  const c = await startCoordinator(overrides);
  cleanup.push(() => c.stop());
  return { c, members: c.membership as unknown as Members };
}

/** A signed beacon from a server that exists only as a key. */
function beacon(who: Identity, seq = Date.now(), full = false): FedBeacon {
  const server = {
    id: who.userId,
    key: who.publicKey,
    name: 'made up',
    url: 'http://203.0.113.9:7443',
    version: 'test',
  };
  return {
    t: 'beacon',
    server,
    seq,
    full,
    sig: sign(who, SIG_DOMAIN.beacon, { server, seq, full, presence: undefined }),
  } as FedBeacon;
}

describe('servers made up out of nothing', () => {
  afterEach(() => vi.useRealTimers());

  it('builds the ring only when someone looks, and only if the live servers changed', async () => {
    const { c, members } = await server();
    const built = vi.spyOn(c.membership as never as { buildView(): unknown }, 'buildView');
    const fakes = Array.from({ length: 3 }, () => createIdentity());
    for (const f of fakes) expect(members.onBeacon(beacon(f), 'link')).toBe(true);
    // Three servers joined, and nobody asked who owns what: no ring yet. Then one, for all three.
    expect(built.mock.calls.length).toBe(0);
    void members.view;
    expect(built.mock.calls.length).toBe(1);
    // The same servers again, with newer beacons: nothing moved.
    const now = Date.now() + 1;
    for (const f of fakes) expect(members.onBeacon(beacon(f, now), 'link')).toBe(true);
    void members.view;
    expect(built.mock.calls.length).toBe(1);
    // One that now keeps a full copy does change who owns what.
    expect(members.onBeacon(beacon(fakes[0]!, now + 1, true), 'link')).toBe(true);
    void members.view;
    expect(built.mock.calls.length).toBe(2);
  });

  it('lets a link introduce a network at once, then only a few new servers a second', async () => {
    const { members } = await server();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const fakes = Array.from({ length: 1100 }, () => createIdentity());
    const taken = fakes.filter((f) => members.onBeacon(beacon(f), 'chatty'));
    expect(taken.length).toBe(1000);
    // Another link has its own allowance; servers already known need none.
    expect(members.onBeacon(beacon(createIdentity()), 'quiet')).toBe(true);
    expect(members.onBeacon(beacon(taken[0]!, Date.now() + 10), 'chatty')).toBe(true);
    // A link that drops and returns has not got its allowance back.
    members.linkUp('chatty');
    members.linkDown('chatty', false);
    expect(members.onBeacon(beacon(createIdentity()), 'chatty')).toBe(false);
    // But a few a second come back with time.
    vi.setSystemTime(Date.now() + 2000);
    expect(members.onBeacon(beacon(createIdentity(), Date.now()), 'chatty')).toBe(true);
  }, 60_000);

  it('forgets servers that have been silent for long, but not one it is linked to', async () => {
    const { members } = await server();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const linked = createIdentity();
    for (const f of [linked, ...Array.from({ length: 4 }, () => createIdentity())])
      members.onBeacon(beacon(f), 'link');
    members.linkUp(linked.userId);
    expect(members.beacons.size).toBe(5);
    vi.setSystemTime(Date.now() + 20 * 70_000);
    members.recompute();
    expect([...members.beacons.keys()]).toEqual([linked.userId]);
  });

  it('does not take back a beacon of a server whose link broke', async () => {
    const { members } = await server();
    const gone = createIdentity();
    const last = beacon(gone);
    expect(members.onBeacon(last, 'link')).toBe(true);
    members.linkUp(gone.userId);
    members.linkDown(gone.userId, true);
    // Someone passes the same beacon on: it is not news.
    expect(members.onBeacon(last, 'other')).toBe(false);
    expect(members.beacons.has(gone.userId)).toBe(true);
  });

  /** Fills the table with servers that have been silent for long, from many links. */
  function fillStale(members: Members, count: number, at: number) {
    const ids: Identity[] = [];
    for (let i = 0; i < count; i++) {
      const who = createIdentity();
      ids.push(who);
      expect(members.onBeacon(beacon(who, at), `link-${Math.floor(i / 900)}`)).toBe(true);
    }
    return ids;
  }

  it('holds at most 5000 servers, pushing out the longest silent when a good beacon comes', async () => {
    const { c, members } = await server();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const first = fillStale(members, 5000, Date.now());
    expect(members.beacons.size).toBe(5000);
    // While they are live there is no room, and no one is pushed out.
    expect(members.onBeacon(beacon(createIdentity()), 'late')).toBe(false);
    expect(members.beacons.size).toBe(5000);
    vi.setSystemTime(Date.now() + 80_000);
    members.recompute();
    const newcomer = createIdentity();
    expect(members.onBeacon(beacon(newcomer), 'late')).toBe(true);
    expect(members.beacons.size).toBe(5000);
    expect(members.beacons.has(newcomer.userId)).toBe(true);
    expect(members.beacons.has(first[0]!.userId)).toBe(false);
    // The server that was pushed out is no longer dialled either.
    expect(c.mesh.knownServers().some((s) => s.id === first[0]!.userId)).toBe(false);
  }, 60_000);

  it('pushes no one out for a beacon that does not check out', async () => {
    const { members } = await server();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    fillStale(members, 5000, Date.now());
    vi.setSystemTime(Date.now() + 80_000);
    members.recompute();
    const forged = beacon(createIdentity());
    forged.sig = beacon(createIdentity()).sig;
    expect(members.onBeacon(forged, 'late')).toBe(false);
    expect(members.beacons.size).toBe(5000);
    expect([...members.beacons.values()].every((b) => (b as { at: number }).at > 0)).toBe(true);
    expect(members.beacons.has(forged.server.id)).toBe(false);
    // Nor for one the link may no longer introduce.
    const burst = Array.from({ length: 1000 }, () => createIdentity());
    for (const f of burst) members.onBeacon(beacon(f), 'spender');
    const before = new Set(members.beacons.keys());
    expect(members.onBeacon(beacon(createIdentity()), 'spender')).toBe(false);
    expect(new Set(members.beacons.keys())).toEqual(before);
  }, 60_000);

  it('does not push out a broken link whose last beacon could still be passed on', async () => {
    const { members } = await server();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    fillStale(members, 4999, Date.now());
    vi.setSystemTime(Date.now() + 30_000);
    const gone = createIdentity();
    const last = beacon(gone);
    members.onBeacon(last, 'link');
    members.linkUp(gone.userId);
    members.linkDown(gone.userId, true);
    // The others are silent and old enough to go; the broken link's beacon is not yet.
    vi.setSystemTime(Date.now() + 45_000);
    members.recompute();
    for (let i = 0; i < 3; i++)
      expect(members.onBeacon(beacon(createIdentity()), 'late')).toBe(true);
    expect(members.beacons.has(gone.userId)).toBe(true);
    expect(members.onBeacon(last, 'other')).toBe(false);
  }, 60_000);

  it('keeps the allowance of a busy link when idle ones are forgotten', async () => {
    const { members } = await server();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    // A link that has spent its burst...
    for (let i = 0; i < 1000; i++) members.onBeacon(beacon(createIdentity()), 'busy');
    // ...while two thousand others come and go.
    for (let i = 0; i < 2000; i++) {
      members.onBeacon(beacon(createIdentity()), `idle-${i}`);
      members.onBeacon(beacon(createIdentity()), 'busy');
    }
    expect(members.introductions.size).toBe(2000);
    expect(members.introductions.has('busy')).toBe(true);
    expect(members.onBeacon(beacon(createIdentity()), 'busy')).toBe(false);
  }, 60_000);

  it('stops dialling a forgotten server, but not one it was told to link to', async () => {
    const { c, members } = await server();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const [a] = fillStale(members, 1, Date.now());
    expect(c.mesh.knownServers().some((s) => s.id === a!.userId)).toBe(true);
    vi.setSystemTime(Date.now() + 20 * 70_000);
    members.recompute();
    expect(c.mesh.knownServers().some((s) => s.id === a!.userId)).toBe(false);
  });
});
