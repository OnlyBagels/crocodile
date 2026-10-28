import { afterEach, describe, expect, it } from 'vitest';
import { sealToDevice } from '@crocodile/crypto';
import { recordKey, sessionIds, type SignedRecord } from '@crocodile/protocol';
import {
  CrocodileClient,
  MemoryKeyValueStore,
  MemoryMessageStore,
  type PlatformAdapter,
} from '@crocodile/client-core';
import type { Coordinator } from '@crocodile/coordinator';
import { FakeRelayNetwork } from './helpers/fake-relay';
import { startCoordinator, waitFor } from './helpers';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(overrides = {}) {
  const c = await startCoordinator(overrides);
  cleanup.push(() => c.stop());
  return c;
}

function makeClient(net: FakeRelayNetwork, coordinator: Coordinator, platform?: PlatformAdapter) {
  const client = new CrocodileClient(
    platform ?? {
      platform: 'desktop',
      appVersion: 'test',
      kv: new MemoryKeyValueStore(),
      messages: new MemoryMessageStore(),
      relay: net.adapter(),
      capabilities: async () => ({ nat: 'cone', cpuCores: 8 }),
    },
    {
      directories: [],
      preferredServers: [coordinator.url],
      transportFactory: net.transportFactory(),
      log: process.env.DBG ? (m, e) => console.log('client', m, JSON.stringify(e)) : undefined,
    },
  );
  cleanup.push(() => client.shutdown());
  return client;
}

/** Same device (same storage), started again. */
async function restart(net: FakeRelayNetwork, old: CrocodileClient, coordinator: Coordinator) {
  const c = makeClient(net, coordinator, old.platform);
  await c.init();
  await waitFor(() => c.state.link === 'connected', 8000, 'reconnected');
  return c;
}

async function signUp(client: CrocodileClient, name: string) {
  await client.init();
  await client.createAccount(name);
  await waitFor(() => client.state.link === 'connected' && client.state.me, 8000, name);
  return client;
}

const bodies = (c: CrocodileClient, ch: string) => (c.state.messages[ch] ?? []).map((m) => m.body);

/** Friends with an established DM (so each knows the other's devices). */
async function friends(net: FakeRelayNetwork, ca: Coordinator, cb: Coordinator) {
  const alice = await signUp(makeClient(net, ca), 'alice');
  const bob = await signUp(makeClient(net, cb), 'bob');
  await waitFor(() => cb.records.get(`profile:${alice.userId}`), 8000, 'profile replicated');
  await alice.addFriend(bob.userId);
  await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000, 'request');
  await bob.addFriend(alice.userId);
  await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12000, 'friends');
  const dm = await alice.openDm(bob.userId);
  await waitFor(() => bob.state.dms.includes(alice.userId), 12000, 'dm invite');
  await alice.openChannel(dm);
  await bob.openChannel(dm);
  await waitFor(() => alice.state.sessions[dm]?.peers.includes(bob.userId), 12000, 'dm up');
  await alice.sendMessage(dm, 'hi');
  await waitFor(() => bodies(bob, dm).includes('hi'), 12000, 'first message');
  await waitFor(() => !alice.state.messages[dm]!.find((m) => m.body === 'hi')!.pending, 5000);
  return { alice, bob, dm };
}

describe('offline delivery', () => {
  it('exchanges both outboxes when two people who wrote offline meet again', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const start = await friends(net, coord, coord);
    const dm = start.dm;
    let { alice, bob } = start;

    // Bob leaves; Alice writes and leaves.
    await bob.shutdown();
    await alice.sendMessage(dm, 'from alice, bob away');
    await alice.shutdown();

    // Bob returns while Alice is away and writes something newer.
    bob = await restart(net, bob, coord);
    await bob.openChannel(dm);
    await new Promise((r) => setTimeout(r, 50));
    await bob.sendMessage(dm, 'from bob, alice away');
    expect(bob.state.messages[dm]!.at(-1)!.pending).toBe(true);

    // Alice returns: each device hands over its queue, whoever's clock is newer.
    alice = await restart(net, alice, coord);
    await alice.openChannel(dm);
    await waitFor(() => bodies(alice, dm).includes('from bob, alice away'), 15000, 'alice gets');
    await waitFor(() => bodies(bob, dm).includes('from alice, bob away'), 15000, 'bob gets');
    await waitFor(
      () =>
        !bob.state.messages[dm]!.find((m) => m.body === 'from bob, alice away')!.pending &&
        !alice.state.messages[dm]!.find((m) => m.body === 'from alice, bob away')!.pending,
      15000,
      'both confirmed',
    );
  });

  it('delivers through an opt-in mailbox when the sender has gone offline, across the mesh', async () => {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => a.mesh.peerIds().length === 1, 12000, 'mesh');
    const net = new FakeRelayNetwork();
    const { alice, bob: bob0, dm } = await friends(net, a, b);
    await alice.updateSettings({ useMailbox: true });

    await bob0.shutdown();
    await waitFor(() => alice.state.sessions[dm]?.peers.length === 0, 12000, 'bob gone');
    await alice.sendMessage(dm, 'sealed for later');
    await waitFor(
      () => alice.state.messages[dm]!.find((m) => m.body === 'sealed for later')?.mailed,
      15000,
      'mailed',
    );
    // Held on Alice's server, as ciphertext only.
    expect(a.store.mailCount({ toUser: bob0.userId })).toBeGreaterThan(0);
    const stored = a.store.mailFor(`${bob0.userId}.${bob0.state.deviceId}`, Date.now(), 10);
    expect(stored[0]!.box).not.toContain('sealed for later');
    await alice.shutdown();

    // Bob comes back on the other server while Alice is still offline.
    const bob = await restart(net, bob0, b);
    await waitFor(() => bodies(bob, dm).length > 0 || bob.state.unread[dm], 15000, 'mail');
    await bob.openChannel(dm);
    await waitFor(() => bodies(bob, dm).includes('sealed for later'), 15000, 'bob reads mail');
    await waitFor(() => a.store.mailCount({ toUser: bob.userId }) === 0, 8000, 'acked');
  });

  async function mailedByStranger() {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob0 = await signUp(makeClient(net, coord), 'bob');
    await waitFor(() => coord.records.get(`profile:${alice.userId}`), 8000, 'profile');
    await waitFor(
      () => coord.store.listPrefix(`device:${bob0.userId}`, 1).length > 0,
      8000,
      'bob device',
    );
    await alice.updateSettings({ useMailbox: true });
    const dm = await alice.openDm(bob0.userId);
    await alice.openChannel(dm);
    await bob0.shutdown();
    await alice.sendMessage(dm, 'mailed hello');
    await waitFor(
      () => alice.state.messages[dm]!.find((m) => m.body === 'mailed hello')?.mailed,
      15000,
      'mailed',
    );
    await alice.shutdown();
    const bob = await restart(net, bob0, coord);
    await waitFor(() => bob.state.dmRequests.includes(alice.userId), 15000, 'a request');
    return { coord, net, alice, bob, dm };
  }

  it('drops mail from someone we do not know and shows a request, which survives a restart', async () => {
    const { coord, net, alice, bob, dm } = await mailedByStranger();
    await waitFor(() => coord.store.mailCount({ toUser: bob.userId }) === 0, 8000, 'acked');
    expect(bob.state.dms).not.toContain(alice.userId);
    expect(bodies(bob, dm)).toEqual([]);
    const again = await restart(net, bob, coord);
    expect(again.state.dmRequests).toContain(alice.userId);
  });

  it('delivers what the sender still holds once the request is accepted', async () => {
    const { net, coord, alice: alice0, bob, dm } = await mailedByStranger();
    await bob.acceptDmRequest(alice0.userId);
    await bob.openChannel(dm);
    const alice = await restart(net, alice0, coord);
    await alice.openChannel(dm);
    await waitFor(() => bodies(bob, dm).includes('mailed hello'), 20000, 'from the sender');
  });

  it('does not make a request in someone else’s name from mail a stranger sends', async () => {
    const { bob, alice, dm } = await mailedByStranger();
    // A third person, and a conversation of theirs with Bob that Alice names in her mail.
    const carol = await signUp(makeClient(new FakeRelayNetwork(), await server()), 'carol');
    const device = bob.records.get(recordKey.device(bob.userId, bob.state.deviceId as string)) as
      SignedRecord<'device'> | undefined;
    const ch = sessionIds.dm(bob.userId, carol.userId);
    const message = {
      id: 'forged-message-0001',
      ch,
      author: alice.userId,
      key: alice.identity!.publicKey,
      ts: Date.now(),
      body: 'from carol, honest',
      sig: 'x',
    };
    const box = sealToDevice(
      alice.identity!,
      alice.state.deviceId as string,
      { peer: `${bob.userId}.${bob.state.deviceId as string}`, prekey: device!.body.prekey },
      new TextEncoder().encode(JSON.stringify({ type: 'mail', messages: [message] })),
    );
    await (bob as unknown as { onMail(items: unknown[]): Promise<void> }).onMail([
      { id: 'forged', box },
    ]);
    expect(bob.state.dmRequests).not.toContain(carol.userId);
    expect(bodies(bob, dm)).toEqual([]);
  });

  it('mails many long messages in boxes and requests the server takes', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const { alice, bob, dm } = await friends(net, coord, coord);
    await alice.updateSettings({ useMailbox: true });
    await bob.shutdown();
    await waitFor(() => alice.state.sessions[dm]?.peers.length === 0, 12000, 'bob gone');
    // 60 messages of 4000 several-byte characters: far more than one box holds.
    for (let i = 0; i < 60; i++) await alice.sendMessage(dm, `${i} ${'żółw '.repeat(780)}`);
    await waitFor(
      () => alice.state.messages[dm]!.filter((m) => m.mailed).length === 60,
      20000,
      'all mailed',
    );
    expect(coord.store.mailCount({ toUser: bob.userId })).toBeGreaterThan(1);
  }, 40_000);

  it('does not use a mailbox unless the user opted in', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const { alice, bob, dm } = await friends(net, coord, coord);
    await bob.shutdown();
    await waitFor(() => alice.state.sessions[dm]?.peers.length === 0, 12000, 'bob gone');
    await alice.sendMessage(dm, 'stays on my device');
    await new Promise((r) => setTimeout(r, 6500));
    expect(coord.store.mailCount({})).toBe(0);
    expect(alice.state.messages[dm]!.at(-1)!.mailed).toBeFalsy();
  });
});
