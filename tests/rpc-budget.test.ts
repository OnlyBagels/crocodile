import { afterEach, describe, expect, it } from 'vitest';
import { createIdentity, signRecord } from '@crocodile/crypto';
import { recordKey } from '@crocodile/protocol';
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
    expect(JSON.stringify(first.records).length).toBeLessThan(1024 * 1024);

    // Asking again for what is left gets there.
    const got = new Set(first.records.map((r) => r.key));
    const second = await reader.conn.request('records.get', {
      keys: keys.filter((k) => !got.has(k)),
    });
    for (const r of second.records) got.add(r.key);
    expect(second.records.length).toBeGreaterThan(0);
    expect(got.size).toBeGreaterThan(first.records.length);
  });

  it('page a long list by key', async () => {
    const { users, reader } = await server(8);
    const seen: string[] = [];
    let after: string | undefined;
    for (let rounds = 0; rounds < 20; rounds++) {
      const res = await reader.conn.request('records.list', {
        prefix: 'profile:',
        ...(after ? { after } : {}),
      });
      expect(JSON.stringify(res.records).length).toBeLessThan(1024 * 1024);
      seen.push(...res.records.map((r) => r.key));
      after = res.records.at(-1)?.key;
      if (!res.more) break;
    }
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
    for (const u of users) expect(seen).toContain(recordKey.profile(u.identity.userId));
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
