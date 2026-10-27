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
});
