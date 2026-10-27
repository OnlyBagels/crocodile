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
  beacons: Map<string, unknown>;
  isLive(id: string): boolean;
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
  it('rebuilds the ring only when the live servers change', async () => {
    const { c, members } = await server();
    const rebuilt = vi.spyOn(c.membership as never as { buildView(): unknown }, 'buildView');
    const fakes = Array.from({ length: 3 }, () => createIdentity());
    for (const f of fakes) expect(members.onBeacon(beacon(f), 'link')).toBe(true);
    expect(rebuilt.mock.calls.length).toBeGreaterThanOrEqual(1);
    const before = rebuilt.mock.calls.length;
    // The same servers again, with newer beacons: nothing moved.
    const now = Date.now() + 1;
    for (const f of fakes) expect(members.onBeacon(beacon(f, now), 'link')).toBe(true);
    expect(rebuilt.mock.calls.length).toBe(before);
    // One that now keeps a full copy does change who owns what.
    expect(members.onBeacon(beacon(fakes[0]!, now + 1, true), 'link')).toBe(true);
    expect(rebuilt.mock.calls.length).toBe(before + 1);
  });

  it('lets a link introduce a network at once, then only a few new servers a second', async () => {
    const { members } = await server();
    const fakes = Array.from({ length: 1100 }, () => createIdentity());
    const taken = fakes.filter((f) => members.onBeacon(beacon(f), 'chatty'));
    // The burst, and a few that arrived while it ran.
    expect(taken.length).toBeGreaterThanOrEqual(1000);
    expect(taken.length).toBeLessThan(1050);
    // Another link has its own allowance; servers already known need none.
    expect(members.onBeacon(beacon(createIdentity()), 'quiet')).toBe(true);
    expect(members.onBeacon(beacon(taken[0]!, Date.now() + 10), 'chatty')).toBe(true);
  }, 60_000);

  it('forgets servers that have not been heard from for a long time', async () => {
    const { members } = await server({ membership: { beaconMs: 50, liveMs: 200, settleMs: 50 } });
    for (let i = 0; i < 5; i++) members.onBeacon(beacon(createIdentity()), 'link');
    expect(members.beacons.size).toBe(5);
    await new Promise((r) => setTimeout(r, 2800));
    expect(members.beacons.size).toBe(0);
  });
});
