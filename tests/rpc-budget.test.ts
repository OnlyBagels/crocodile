import { afterEach, describe, expect, it } from 'vitest';
import {
  createIdentity,
  createPrekey,
  randomDeviceId,
  sealAnonymous,
  signRecord,
} from '@crocodile/crypto';
import { recordKey, utf8 } from '@crocodile/protocol';
import {
  CrocodileClient,
  MemoryKeyValueStore,
  MemoryMessageStore,
  type PlatformAdapter,
} from '@crocodile/client-core';
import { FakeRelayNetwork } from './helpers/fake-relay';
import { connectUser, expectAccepted, startCoordinator, waitFor } from './helpers';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A profile with an avatar close to the largest one allowed. */
const avatar = `data:image/png;base64,${'A'.repeat(300_000)}`;

async function server(profiles: number) {
  const c = await startCoordinator();
  cleanup.push(() => c.stop());
  const users = [];
  for (let i = 0; i < profiles; i++) {
    const u = await connectUser(c, createIdentity(), `big${i}`);
    cleanup.push(() => u.conn.close());
    const profile = signRecord(u.identity, 'profile', recordKey.profile(u.identity.userId), {
      username: `big${i}`,
      encKey: u.identity.encPublicKey,
      avatar,
    });
    expectAccepted(await u.conn.request('records.put', { record: profile }));
    users.push(u);
  }
  const reader = await connectUser(c, createIdentity(), 'reader');
  cleanup.push(() => reader.conn.close());
  return { c, users, reader };
}

describe('client RPC answers', () => {
  it('cut a long answer to one frame and say there is more', async () => {
    const { users, reader } = await server(8);
    const keys = users.map((u) => recordKey.profile(u.identity.userId));

    const first = await reader.conn.request('records.get', { keys });
    expect(first.more).toBe(true);
    expect(first.records.length).toBeGreaterThan(0);
    expect(first.records.length).toBeLessThan(keys.length);
    expect(Buffer.byteLength(JSON.stringify(first.records))).toBeLessThan(1024 * 1024);

    // Asking again from where it says it got to reaches the rest, once each.
    expect(first.next).toBeGreaterThan(0);
    const got = new Set(first.records.map((r) => r.key));
    const second = await reader.conn.request('records.get', { keys: keys.slice(first.next) });
    for (const r of second.records) got.add(r.key);
    expect(second.records.length).toBeGreaterThan(0);
    expect(got.size).toBeGreaterThan(first.records.length);
  });

  it('are not slowed by keys that have no record', async () => {
    const { users, reader } = await server(4);
    const missing = Array.from({ length: 30 }, (_, i) =>
      recordKey.profile(`${'a'.repeat(25)}${i}`),
    );
    const keys = [
      ...missing,
      ...users.map((u) => recordKey.profile(u.identity.userId)),
      ...missing,
    ];
    const first = await reader.conn.request('records.get', { keys });
    // The keys with nothing behind them are over and done with, not asked about again.
    expect(first.more).toBe(true);
    expect(first.next).toBeGreaterThanOrEqual(missing.length);
  });

  it('page a long list by key, past the most one request may ask for', async () => {
    const { users, reader } = await server(8);
    const seen: string[] = [];
    let after: string | undefined;
    for (let rounds = 0; rounds < 20; rounds++) {
      const res = await reader.conn.request('records.list', {
        prefix: 'profile:',
        // Each page is cut by bytes well before this many, so the list goes on past five.
        limit: 5,
        ...(after ? { after } : {}),
      });
      expect(Buffer.byteLength(JSON.stringify(res.records))).toBeLessThan(1024 * 1024);
      seen.push(...res.records.map((r) => r.key));
      after = res.records.at(-1)?.key;
      if (!res.more) break;
    }
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
    for (const u of users) expect(seen).toContain(recordKey.profile(u.identity.userId));
  });

  it('say there is more past the limit, and skip pages that hold nothing the asker may read', async () => {
    const { c } = await server(0);
    const bob = await connectUser(c, createIdentity(), 'bob');
    const carol = await connectUser(c, createIdentity(), 'carol');
    cleanup.push(
      () => bob.conn.close(),
      () => carol.conn.close(),
    );
    const sender = createIdentity();
    const noteFor = async (to: typeof bob, via: typeof bob) => {
      const author = createIdentity();
      const box = sealAnonymous(
        sender,
        randomDeviceId(),
        { peer: to.conn.peer, prekey: createPrekey().bundle },
        utf8.encode('hi'),
      );
      const note = signRecord(author, 'note', recordKey.note(to.identity.userId, author.userId), {
        boxes: [box],
      });
      expectAccepted(await via.conn.request('records.put', { record: note }));
      return note.key;
    };
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) keys.push(await noteFor(bob, carol));
    // Some for carol too, among them in the prefix and not for bob to read.
    for (let i = 0; i < 3; i++) await noteFor(carol, bob);
    // Pages of two reach all five of bob's, however the others fall among them.
    const seen: string[] = [];
    let after: string | undefined;
    for (let rounds = 0; rounds < 10; rounds++) {
      const res = await bob.conn.request('records.list', {
        prefix: 'note:',
        limit: 2,
        ...(after ? { after } : {}),
      });
      expect(res.records.length).toBeLessThanOrEqual(2);
      seen.push(...res.records.map((r) => r.key));
      after = res.next ?? res.records.at(-1)?.key;
      if (!res.more) break;
    }
    expect(seen.sort()).toEqual(keys.sort());
    // Carol reads her three, and is not told of bob's five.
    const hers = await carol.conn.request('records.list', { prefix: 'note:', limit: 10 });
    expect(hers.records).toHaveLength(3);
    // With a page of one, she looks at a few and is told where to go on from.
    const dave = await connectUser(c, createIdentity(), 'dave');
    cleanup.push(() => dave.conn.close());
    const step = await dave.conn.request('records.list', { prefix: 'note:', limit: 1 });
    expect(step).toMatchObject({ records: [], more: true });
    expect(step.next).toBeDefined();
    let rest = await dave.conn.request('records.list', {
      prefix: 'note:',
      limit: 1,
      after: step.next!,
    });
    // Eight notes, none his: a few looks at a time, and it ends.
    for (let rounds = 0; rest.more && rounds < 5; rounds++)
      rest = await dave.conn.request('records.list', {
        prefix: 'note:',
        limit: 1,
        after: rest.next!,
      });
    expect(rest).toEqual({ records: [] });
  });

  it('are asked for again by a client until it has every profile', async () => {
    const { c, users } = await server(8);
    const net = new FakeRelayNetwork();
    const platform: PlatformAdapter = {
      platform: 'desktop',
      appVersion: 'test',
      kv: new MemoryKeyValueStore(),
      messages: new MemoryMessageStore(),
      relay: net.adapter(),
      capabilities: async () => ({ nat: 'cone', cpuCores: 8 }),
    };
    const client = new CrocodileClient(platform, {
      directories: [],
      preferredServers: [c.url],
      transportFactory: net.transportFactory(),
    });
    cleanup.push(() => client.shutdown());
    await client.init();
    await client.createAccount('me');
    await waitFor(() => client.state.link === 'connected' && client.state.me, 8000, 'connected');
    const ids = users.map((u) => u.identity.userId);
    await (client as unknown as { fetchProfiles(ids: string[]): Promise<void> }).fetchProfiles(ids);
    for (const id of ids) expect(client.state.profiles[id]?.username, id).toBeDefined();
  });
});
