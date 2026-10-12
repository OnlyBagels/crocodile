import { afterEach, describe, expect, it } from 'vitest';
import {
  CoordinatorLink,
  CrocodileClient,
  MemoryKeyValueStore,
  MemoryMessageStore,
  type NetworkProbe,
  type PlatformAdapter,
  type VoiceEngine,
} from '@crocodile/client-core';
import type { Coordinator } from '@crocodile/coordinator';
import { Directory } from '@crocodile/directory';
import { createChatMessage, createIdentity, signRecord } from '@crocodile/crypto';
import {
  DELETED_PROFILE_NAME,
  recordKey,
  sessionIds,
  type DeviceBody,
  type SpaceBody,
} from '@crocodile/protocol';
import { FakeRelayNetwork } from './helpers/fake-relay';
import { caps, connectUser, joinSpace, startCoordinator, waitFor } from './helpers';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(overrides = {}) {
  const c = await startCoordinator(overrides);
  cleanup.push(() => c.stop());
  return c;
}

function makeClient(
  net: FakeRelayNetwork,
  coordinator: Coordinator,
  opts: {
    canHost?: boolean;
    nat?: 'open' | 'cone' | 'symmetric' | 'unknown';
    kv?: MemoryKeyValueStore;
    directories?: string[];
    /** How far this device's clock is off, in ms (a number, or read each time). */
    clockOffsetMs?: number | (() => number);
    /** What a network check finds. */
    probe?: NetworkProbe;
    ringTimeoutMs?: number;
  } = {},
) {
  const platform: PlatformAdapter = {
    platform: opts.canHost === false ? 'web' : 'desktop',
    appVersion: 'test',
    kv: opts.kv ?? new MemoryKeyValueStore(),
    messages: new MemoryMessageStore(),
    ...(opts.canHost === false ? {} : { relay: net.adapter() }),
    capabilities: async () => ({ nat: opts.nat ?? 'cone', cpuCores: 8 }),
    ...(opts.probe ? { probeNetwork: async () => opts.probe! } : {}),
  };
  const client = new CrocodileClient(platform, {
    directories: opts.directories ?? [],
    preferredServers: [coordinator.url],
    transportFactory: net.transportFactory(),
    ...(opts.clockOffsetMs
      ? {
          now: () =>
            Date.now() +
            (typeof opts.clockOffsetMs === 'function' ? opts.clockOffsetMs() : opts.clockOffsetMs!),
        }
      : {}),
    ...(opts.ringTimeoutMs ? { ringTimeoutMs: opts.ringTimeoutMs } : {}),
    log: process.env.DBG ? (m, e) => console.log('client', m, JSON.stringify(e)) : undefined,
  });
  cleanup.push(() => client.shutdown());
  return client;
}

async function signUp(client: CrocodileClient, name: string) {
  await client.init();
  await client.createAccount(name);
  await waitFor(
    () => client.state.link === 'connected' && client.state.me,
    5000,
    `${name} connected`,
  );
  return client;
}

const channelOf = (c: CrocodileClient, spaceId: string) =>
  c.state.spaces[spaceId]!.channels.find((ch) => ch.kind === 'text')!.id;
const bodies = (c: CrocodileClient, ch: string) => (c.state.messages[ch] ?? []).map((m) => m.body);

describe('client', () => {
  it('onboards, befriends and chats end-to-end in a space', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');

    // Friends: request, then accept.
    const found = await bob.searchUsers(`alice#${alice.state.me!.tag}`);
    expect(found.map((p) => p.userId)).toEqual([alice.userId]);
    await bob.addFriend(alice.userId);
    await waitFor(
      () => alice.state.friends.incoming.includes(bob.userId),
      3000,
      'incoming request',
    );
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.friends.includes(alice.userId), 12000, 'friendship');

    // Space + invite.
    const spaceId = await alice.createSpace('Swamp');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(`croc://join/${code}`);
    await waitFor(
      () => alice.state.spaces[spaceId]?.members.includes(bob.userId),
      3000,
      'member visible',
    );
    const ch = channelOf(alice, spaceId);
    await alice.openChannel(ch);
    await bob.openChannel(ch);

    const sid = sessionIds.space(spaceId);
    await waitFor(
      () =>
        alice.state.sessions[sid]?.peers.includes(bob.userId) &&
        bob.state.sessions[sid]?.peers.includes(alice.userId),
      5000,
      'relay mesh',
    );
    expect(alice.state.sessions[sid]!.host).toBe(alice.userId);
    expect(alice.state.sessions[sid]!.iAmHost).toBe(true);

    await alice.sendMessage(ch, 'hello swamp');
    await waitFor(() => bodies(bob, ch).includes('hello swamp'), 12000, 'bob receives');
    await bob.sendMessage(ch, 'hi alice');
    await waitFor(() => bodies(alice, ch).includes('hi alice'), 12000, 'alice receives');

    // Edits fold onto the original.
    const original = bob.state.messages[ch]!.find((m) => m.body === 'hello swamp')!;
    await alice.editMessage(ch, original.id, 'hello swamp!');
    await waitFor(() => bodies(bob, ch).includes('hello swamp!'), 12000, 'edit');
    expect(bob.state.messages[ch]!.find((m) => m.id === original.id)!.edited).toBe(true);
  });

  it('keeps a reply after the message it answers when the clocks disagree', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    // Bob's computer clock is two minutes behind Alice's.
    const bob = await signUp(makeClient(net, coord, { clockOffsetMs: -120_000 }), 'bob');
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    const dm = await alice.openDm(bob.userId);
    await waitFor(() => bob.state.dms.includes(alice.userId), 12000, 'dm invite');
    await alice.openChannel(dm);
    await bob.openChannel(dm);
    await waitFor(() => alice.state.sessions[dm]?.peers.includes(bob.userId), 12000, 'dm');

    await alice.sendMessage(dm, 'ping');
    await waitFor(() => bodies(bob, dm).includes('ping'), 12000, 'bob receives');
    await bob.sendMessage(dm, 'pong');
    await waitFor(() => bodies(alice, dm).includes('pong'), 12000, 'alice receives');
    await bob.sendMessage(dm, 'and again');
    await waitFor(() => bodies(alice, dm).includes('and again'), 12000, 'alice receives');

    expect(bodies(alice, dm)).toEqual(['ping', 'pong', 'and again']);
    expect(bodies(bob, dm)).toEqual(['ping', 'pong', 'and again']);
  });

  it('keeps sending after a clock that was far ahead is corrected', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    // Bob's clock starts a day ahead.
    let offset = 24 * 3600_000;
    const bob = await signUp(makeClient(net, coord, { clockOffsetMs: () => offset }), 'bob');
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    const dm = await alice.openDm(bob.userId);
    await waitFor(() => bob.state.dms.includes(alice.userId), 12000, 'dm invite');
    await alice.openChannel(dm);
    await bob.openChannel(dm);
    await waitFor(() => alice.state.sessions[dm]?.peers.includes(bob.userId), 12000, 'dm');

    await bob.sendMessage(dm, 'from tomorrow');
    // Then his clock is put right; what he writes next must still arrive.
    offset = 0;
    await bob.sendMessage(dm, 'clock fixed');
    await waitFor(() => bodies(alice, dm).includes('clock fixed'), 12000, 'alice receives');
    // The message stamped a day ahead was never accepted.
    expect(bodies(alice, dm)).toEqual(['clock fixed']);
  });

  it('syncs history to members who join later, peer to peer', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    const spaceId = await alice.createSpace('History');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(code);
    const ch = channelOf(alice, spaceId);
    const sid = sessionIds.space(spaceId);
    await waitFor(() => alice.state.sessions[sid]?.peers.includes(bob.userId), 12000);
    for (let i = 0; i < 5; i++) await alice.sendMessage(ch, `msg ${i}`);

    const carol = await signUp(makeClient(net, coord), 'carol');
    await carol.joinWithInvite(code);
    await carol.openChannel(ch);
    await waitFor(() => bodies(carol, ch).length === 5, 12000, 'history');
    expect(bodies(carol, ch)).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']);
  });

  it('scrolling back shows every older message once, however many share a time', async () => {
    const coord = await server();
    const alice = await signUp(makeClient(new FakeRelayNetwork(), coord), 'alice');
    const spaceId = await alice.createSpace('Busy');
    const ch = channelOf(alice, spaceId);
    // 150 messages; 40 of them at one moment, around where a page ends.
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < 150; i++) {
      const ts = i >= 30 && i < 70 ? base + 30 : base + i;
      await alice.platform.messages.put(
        createChatMessage(alice.identity!, { ch, body: `m${i}` }, ts),
      );
    }
    await alice.openChannel(ch);
    expect(alice.state.messages[ch]).toHaveLength(100);
    // Fast scrolling asks several times before the first answer.
    await Promise.all([alice.loadOlder(ch), alice.loadOlder(ch), alice.loadOlder(ch)]);
    const shown = bodies(alice, ch);
    expect(shown).toHaveLength(150);
    expect(new Set(shown).size).toBe(150);
  });

  it('counts and announces new messages, not edits or deletions', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    const spaceId = await alice.createSpace('Edits');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(code);
    const ch = channelOf(alice, spaceId);
    const sid = sessionIds.space(spaceId);
    await alice.openChannel(ch);
    await waitFor(() => alice.state.sessions[sid]?.peers.includes(bob.userId), 12000, 'connected');
    // Bob is elsewhere in the app.
    bob.closeChannel();
    const events: boolean[] = [];
    bob.on('message', ({ update }) => events.push(update));
    await alice.sendMessage(ch, 'first take');
    await waitFor(() => bob.state.unread[ch] === 1, 12000, 'unread');
    const id = alice.state.messages[ch]!.find((m) => m.body === 'first take')!.id;
    await alice.editMessage(ch, id, 'second take');
    await alice.deleteMessage(ch, id);
    await waitFor(() => events.length === 3, 12000, 'edit and deletion arrive');
    expect(events).toEqual([false, true, true]);
    expect(bob.state.unread[ch]).toBe(1);
  });

  it('starts the relay again when its process dies, and members come back', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord, { canHost: false }), 'bob');
    const spaceId = await alice.createSpace('Crash');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(code);
    const ch = channelOf(alice, spaceId);
    const sid = sessionIds.space(spaceId);
    await alice.openChannel(ch);
    await bob.openChannel(ch);
    await waitFor(() => bob.state.sessions[sid]?.peers.includes(alice.userId), 12000, 'connected');
    const epoch = bob.state.sessions[sid]!.epoch;

    // Seen as it happens: the relay can be back before a poll would notice.
    let dropped = false;
    bob.store.subscribe(() => {
      if (!bob.state.sessions[sid]?.peers.includes(alice.userId)) dropped = true;
    });
    const started = net.started;
    net.crashRelayProcessOf(alice.userId);
    // One relay started in place of the one that died.
    expect(net.started).toBe(started + 1);
    // Alice runs a new relay for the same session: no new election needed.
    await waitFor(
      () => dropped && bob.state.sessions[sid]?.peers.includes(alice.userId),
      5000,
      'dropped and back',
    );
    expect(bob.state.sessions[sid]!.epoch).toBe(epoch);
    await alice.sendMessage(ch, 'still here');
    await waitFor(() => bodies(bob, ch).includes('still here'), 5000, 'delivered');
  });

  it('syncs a long history in parts small enough for the data channel', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const spaceId = await alice.createSpace('Long');
    const code = await alice.createInvite(spaceId);
    const ch = channelOf(alice, spaceId);
    await alice.openChannel(ch);
    // 40 long messages: about 300 KiB of history, in several-byte characters.
    for (let i = 0; i < 40; i++) await alice.sendMessage(ch, `${i} ${'żółw '.repeat(780)}`);

    const carol = await signUp(makeClient(net, coord), 'carol');
    await carol.joinWithInvite(code);
    await carol.openChannel(ch);
    await waitFor(() => bodies(carol, ch).length === 40, 15000, 'history');
  }, 40_000);

  it('delivers DMs, including ones written while the friend was offline', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);

    const dm = await alice.openDm(bob.userId);
    await waitFor(() => bob.state.dms.includes(alice.userId), 12000, 'dm invite');
    await alice.openChannel(dm);
    await bob.openChannel(dm);
    await waitFor(
      () => alice.state.sessions[dm]?.peers.includes(bob.userId),
      12000,
      'dm connected',
    );
    await alice.sendMessage(dm, 'psst');
    await waitFor(() => bodies(bob, dm).includes('psst'), 12000, 'dm delivered');

    // Bob goes offline; Alice writes; Bob comes back and syncs from Alice.
    const bobKv = bob.platform.kv as MemoryKeyValueStore;
    await bob.shutdown();
    await waitFor(() => alice.state.sessions[dm]?.peers.length === 0, 12000, 'bob gone');
    await alice.sendMessage(dm, 'while you were away');
    expect(alice.state.messages[dm]!.at(-1)!.pending).toBe(true);

    const bob2 = new CrocodileClient(
      { ...bob.platform, kv: bobKv },
      { directories: [], preferredServers: [coord.url], transportFactory: net.transportFactory() },
    );
    cleanup.push(() => bob2.shutdown());
    await bob2.init();
    await bob2.openDm(alice.userId);
    await bob2.openChannel(dm);
    await waitFor(
      () => bodies(bob2, dm).includes('while you were away'),
      5000,
      'offline dm synced',
    );
  });

  it('fails over to the backup host and keeps chatting', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord, { nat: 'cone' }), 'bob');
    const carol = await signUp(makeClient(net, coord, { canHost: false }), 'carol');
    const spaceId = await alice.createSpace('Failover');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(code);
    await carol.joinWithInvite(code);
    const ch = channelOf(alice, spaceId);
    const sid = sessionIds.space(spaceId);
    await bob.openChannel(ch);
    await carol.openChannel(ch);
    await waitFor(() => carol.state.sessions[sid]?.peers.length === 2, 12000, 'all connected');
    expect(carol.state.sessions[sid]!.host).toBe(alice.userId);
    expect(carol.state.sessions[sid]!.backup).toBe(bob.userId);

    // Alice's machine drops off the network entirely.
    net.killRelaysOf(alice.userId);
    alice.link!.stop();
    await waitFor(
      () =>
        carol.state.sessions[sid]?.host === bob.userId &&
        carol.state.sessions[sid]?.status === 'connected',
      8000,
      'failover',
    );
    await carol.sendMessage(ch, 'still here?');
    await waitFor(() => bodies(bob, ch).includes('still here?'), 12000, 'chat after failover');
  });

  it('works across two coordination servers in a mesh', async () => {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => a.mesh.peerIds().length === 1, 12000, 'mesh');
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, a, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, b), 'bob');
    const spaceId = await alice.createSpace('Federated');
    const code = await alice.createInvite(spaceId);
    await waitFor(() => b.records.get(`invite:${code}`), 12000, 'invite replicated');
    await bob.joinWithInvite(code);
    const ch = channelOf(alice, spaceId);
    await bob.openChannel(ch);
    const sid = sessionIds.space(spaceId);
    await waitFor(
      () => bob.state.sessions[sid]?.peers.includes(alice.userId),
      8000,
      'cross-server relay',
    );
    await alice.sendMessage(ch, 'across the mesh');
    await waitFor(() => bodies(bob, ch).includes('across the mesh'), 12000);
    expect(bob.state.server!.info.id).toBe(b.info.id);
    expect(alice.state.server!.info.id).toBe(a.info.id);
  });

  it('keeps its conversations after switching to another server', async () => {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => a.mesh.peerIds().length === 1, 12000, 'mesh');
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, a, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, a), 'bob');
    const spaceId = await alice.createSpace('Swamp');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(code);
    const ch = channelOf(alice, spaceId);
    await alice.openChannel(ch);
    await bob.openChannel(ch);
    const sid = sessionIds.space(spaceId);
    await waitFor(() => bob.state.sessions[sid]?.peers.includes(alice.userId), 8000, 'mesh');

    // Bob picks the other server (Settings → Network → Use).
    await bob.preferServer(b.url);
    await waitFor(() => bob.state.server?.info.id === b.info.id, 12000, 'on B');
    // Leaving A ended Bob's membership there; he must have joined again through B.
    await new Promise((r) => setTimeout(r, 1500));
    await waitFor(
      () => alice.state.sessions[sid]?.members.includes(bob.userId),
      8000,
      'bob back in the session',
    );
    // A new connection to the host is set up through the new server.
    net.killRelaysOf(alice.userId);
    await waitFor(
      () =>
        bob.state.sessions[sid]?.status === 'connected' &&
        bob.state.sessions[sid]?.peers.includes(alice.userId),
      15000,
      'reconnected through B',
    );
    await alice.sendMessage(ch, 'still here?');
    await waitFor(() => bodies(bob, ch).includes('still here?'), 12000, 'bob receives on B');
    await bob.sendMessage(ch, 'yes, from B');
    await waitFor(() => bodies(alice, ch).includes('yes, from B'), 12000, 'alice receives');
  });
});

describe('connection help', () => {
  it('checks the network on connecting and says when direct connections are limited', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const blocked = await signUp(
      makeClient(net, coord, { probe: { nat: 'unknown', udp: false } }),
      'blocked',
    );
    const strict = await signUp(
      makeClient(net, coord, { probe: { nat: 'symmetric', udp: true } }),
      'strict',
    );
    const fine = await signUp(makeClient(net, coord, { probe: { nat: 'cone', udp: true } }), 'ok');
    await waitFor(() => blocked.state.network?.checkedAt, 3000, 'checked');
    expect(blocked.state.network).toMatchObject({ verdict: 'blocked', checking: false });
    await waitFor(() => strict.state.network?.checkedAt, 3000, 'checked');
    expect(strict.state.network!.verdict).toBe('limited');
    await waitFor(() => fine.state.network?.checkedAt, 3000, 'checked');
    expect(fine.state.network!.verdict).toBe('good');
  });

  it('offers the relay when a friend cannot be reached directly, and connects through it', async () => {
    const coord = await server({ relay: { enabled: true, maxUsers: 5 }, stunPort: 0 });
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    // Bob can't host (like the web app), so Alice stays the host.
    const bob = await signUp(makeClient(net, coord, { canHost: false }), 'bob');
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    // Bob's network lets nothing through directly.
    net.blocked.add(bob.userId);
    const dm = await alice.openDm(bob.userId);
    await waitFor(() => bob.state.dms.includes(alice.userId), 12000, 'dm invite');
    await alice.openChannel(dm);
    await bob.openChannel(dm);
    const host = await waitFor(() => bob.state.sessions[dm]?.host, 12000, 'host elected');
    expect(host).toBe(alice.userId);

    const trouble = await waitFor(() => bob.state.connectionTrouble, 12000, 'trouble noticed');
    expect(trouble).toEqual({ sessionId: dm, with: alice.userId });
    expect(bob.state.sessions[dm]!.trouble).toBe(true);
    // Where it fails: Alice answers, but no network path works.
    const failed = bob.state.sessions[dm]!.attempts.filter((a) => a.end).at(-1)!;
    expect(failed).toMatchObject({ host: alice.userId, viaRelay: false });
    expect(failed.end).toMatchObject({ ok: false, stage: 'no-path' });
    expect(failed.steps.map((s) => s.step)).toEqual(['offer', 'answer']);

    await bob.useRelay(dm);
    expect(bob.state.settings.allowServerRelay).toBe(true);
    await waitFor(() => bob.state.sessions[dm]?.status === 'connected', 12000, 'relayed');
    expect(bob.state.sessions[dm]!.route).toBe('relay');
    expect(bob.state.sessions[dm]!.relay).not.toBeNull();
    expect(bob.state.connectionTrouble).toBeNull();
    const relayed = bob.state.sessions[dm]!.attempts.at(-1)!;
    expect(relayed).toMatchObject({ viaRelay: true, end: { ok: true } });
    expect(relayed.steps.map((s) => s.step)).toEqual(['offer', 'answer', 'path', 'open']);
    expect(bob.state.sessions[dm]!.connectedAt).toBeGreaterThan(0);
    await bob.sendMessage(dm, 'through the relay');
    await waitFor(() => bodies(alice, dm).includes('through the relay'), 12000, 'delivered');
    // Alice reached her own relay directly.
    expect(alice.state.sessions[dm]!.trouble).toBe(false);
  });
});

describe('strict networks', () => {
  it('a message from behind a symmetric NAT gets through: the reachable side hosts', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const strict = await signUp(makeClient(net, coord, { nat: 'symmetric' }), 'strict');
    const open = await signUp(makeClient(net, coord, { nat: 'open' }), 'open');
    // Nobody can reach a relay the strict side hosts; it can reach others.
    net.unreachable.add(strict.userId);
    await strict.addFriend(open.userId);
    await waitFor(() => open.state.friends.incoming.includes(strict.userId), 12000);
    await open.addFriend(strict.userId);
    await waitFor(() => strict.state.friends.friends.includes(open.userId), 12000, 'friends');
    // The strict side starts the conversation (and so is elected first).
    const dm = await strict.openDm(open.userId);
    await strict.openChannel(dm);
    await strict.sendMessage(dm, 'from behind a strict NAT');
    // The open side gets the invite and opens the conversation.
    await waitFor(() => open.state.dms.includes(strict.userId), 12000, 'dm invite');
    await open.openChannel(dm);
    await waitFor(
      () => bodies(open, dm).includes('from behind a strict NAT'),
      15000,
      'the open side receives it',
    );
    expect(strict.state.sessions[dm]?.host).toBe(open.userId);
  });
});

describe('host reports', () => {
  it('reports a host it has no network path to after one try, not two', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    // The strict side's own network check couldn't finish, so the election
    // can't tell it is a poor host: only members' reports can move it.
    const strict = await signUp(makeClient(net, coord, { nat: 'unknown' }), 'strict');
    const open = await signUp(makeClient(net, coord, { nat: 'open' }), 'open');
    net.unreachable.add(strict.userId);
    await strict.addFriend(open.userId);
    await waitFor(() => open.state.friends.incoming.includes(strict.userId), 12000);
    await open.addFriend(strict.userId);
    await waitFor(() => strict.state.friends.friends.includes(open.userId), 12000, 'friends');
    const dm = await strict.openDm(open.userId);
    await waitFor(() => open.state.dms.includes(strict.userId), 12000, 'dm invite');
    await open.openChannel(dm);
    await waitFor(() => open.state.sessions[dm]?.iAmHost, 12000, 'the open side hosts');
    const toStrict = open.state.sessions[dm]!.attempts.filter((a) => a.host === strict.userId);
    expect(toStrict).toHaveLength(1);
    expect(toStrict[0]!.end).toMatchObject({ ok: false, stage: 'no-path' });
  });

  it('tries twice before reporting when its own network is the limited one', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const open = await signUp(makeClient(net, coord, { nat: 'open' }), 'open');
    // UDP blocked: the app reports symmetric, and the fault is likely its own.
    const strict = await signUp(makeClient(net, coord, { nat: 'symmetric' }), 'strict');
    net.blocked.add(strict.userId);
    await open.addFriend(strict.userId);
    await waitFor(() => strict.state.friends.incoming.includes(open.userId), 12000);
    await strict.addFriend(open.userId);
    await waitFor(() => open.state.friends.friends.includes(strict.userId), 12000, 'friends');
    const dm = await open.openDm(strict.userId);
    await waitFor(() => strict.state.dms.includes(open.userId), 12000, 'dm invite');
    await open.openChannel(dm);
    await strict.openChannel(dm);
    // One report would have made the strict side host after its first try.
    const toOpen = () =>
      strict.state.sessions[dm]?.attempts.filter((a) => a.host === open.userId && a.end) ?? [];
    await waitFor(() => toOpen().length >= 2, 12000, 'a second try');
    expect(toOpen()[0]!.end).toMatchObject({ ok: false, stage: 'no-path' });
  });
});

describe('relay windows', () => {
  /** Alice hosts a DM with Bob, who has the relay on and turned it on for the DM. */
  async function relayedDm(bobBlocked: boolean) {
    const coord = await server({ relay: { enabled: true, maxUsers: 5 }, stunPort: 0 });
    // Short windows; the server extends grants asked for in their last minutes.
    coord.turn!.limits.maxGrantMs = 3000;
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord, { canHost: false }), 'bob');
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    if (bobBlocked) net.blocked.add(bob.userId);
    const dm = await alice.openDm(bob.userId);
    await waitFor(() => bob.state.dms.includes(alice.userId), 12000, 'dm invite');
    await alice.openChannel(dm);
    await bob.openChannel(dm);
    await bob.useRelay(dm);
    await waitFor(
      () =>
        bob.state.sessions[dm]?.status === 'connected' &&
        bob.state.sessions[dm]?.relay &&
        bob.state.sessions[dm]?.route,
      12000,
      'connected with the relay offered',
    );
    return { bob, dm };
  }

  it('renews the relay while the connection goes through it, without dropping the call', async () => {
    const { bob, dm } = await relayedDm(true);
    const view = () => bob.state.sessions[dm]!;
    expect(view().route).toBe('relay');
    const first = view().relay!.expiresAt;
    const attempts = view().attempts.length;
    // Past the first window's end.
    await new Promise((r) => setTimeout(r, first - Date.now() + 700));
    expect(view().relay!.expiresAt).toBeGreaterThan(first);
    expect(view().status).toBe('connected');
    expect(view().attempts).toHaveLength(attempts);
    expect(bob.state.relayEnded).toBeNull();
  });

  it("lets the relay go when ICE found a direct path, and doesn't reconnect", async () => {
    const { bob, dm } = await relayedDm(false);
    const view = () => bob.state.sessions[dm]!;
    expect(view().route).toBe('lan');
    const first = view().relay!.expiresAt;
    const attempts = view().attempts.length;
    await waitFor(() => view().relay === null, 5000, 'relay let go');
    // The server's window ends too; the direct connection carries on.
    await new Promise((r) => setTimeout(r, first - Date.now() + 700));
    expect(view().status).toBe('connected');
    expect(view().attempts).toHaveLength(attempts);
    expect(bob.state.relayEnded).toBeNull();
  });
});

describe('calls', () => {
  /** Enough of a voice engine to place a call without a microphone. */
  const silentVoice = () =>
    ({
      start: async () => {},
      stop: () => {},
      stopSession: () => {},
      setMuted: () => {},
      setDeafened: () => {},
      playSlot: () => {},
      micTrack: () => null,
      frameCrypto: () => undefined,
    }) as unknown as VoiceEngine;

  it('signing out during a call ends it and turns the microphone off', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    let micOn = false;
    alice.voiceEngine = {
      ...silentVoice(),
      start: async () => void (micOn = true),
      stop: () => void (micOn = false),
    } as unknown as VoiceEngine;
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12000, 'friends');
    await alice.callDm(bob.userId);
    expect(micOn).toBe(true);
    await alice.signOut();
    expect(micOn).toBe(false);
    expect(alice.state.voiceSession).toBeNull();
    expect(alice.state.outgoingCall).toBeNull();
  });

  it('falls back to the relay even while other members keep coming and going', async () => {
    const coord = await server({ relay: { enabled: true, maxUsers: 5 }, stunPort: 0 });
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord, { canHost: false }), 'bob');
    await bob.updateSettings({ allowServerRelay: true });
    // Bob's network lets nothing through directly.
    net.blocked.add(bob.userId);
    const spaceId = await alice.createSpace('Busy');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(code);
    // Carol (another app) joins and leaves the space's session over and over:
    // every change sends Bob a new session state while he can't connect.
    const carol = await connectUser(coord);
    await joinSpace(carol, spaceId, code);
    const sid = sessionIds.space(spaceId);
    let churning = true;
    let churned = 0;
    const churn = (async () => {
      while (churning) {
        churned++;
        await carol.conn.request('session.join', {
          sessionId: sid,
          caps: caps({ canHost: false }),
        });
        await new Promise((r) => setTimeout(r, 200));
        await carol.conn.request('session.leave', { sessionId: sid });
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    cleanup.push(async () => {
      churning = false;
      await churn.catch(() => {});
    });
    await waitFor(() => churned >= 3, 5000, 'churn under way');
    const ch = channelOf(alice, spaceId);
    await alice.openChannel(ch);
    await bob.openChannel(ch);
    await waitFor(
      () => bob.state.sessions[sid]?.status === 'connected' && bob.state.sessions[sid]?.relay,
      20000,
      'relayed despite the churn',
    );
    expect(bob.state.sessions[sid]!.route).toBe('relay');
  });

  it('hangs up a call nobody answers, instead of staying in it alone', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { ringTimeoutMs: 1500 }), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    alice.voiceEngine = silentVoice();
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12000, 'friends');

    await alice.callDm(bob.userId);
    expect(alice.state.outgoingCall?.to).toBe(bob.userId);
    await waitFor(() => bob.state.incomingCall, 12000, 'bob rings');
    await waitFor(() => !alice.state.voiceSession, 6000, 'hung up');
    expect(alice.state.outgoingCall).toBeNull();
    expect(alice.state.errors.map((e) => e.message)).toContain('No answer');
    await waitFor(() => !bob.state.incomingCall, 6000, 'stops ringing for bob');
  });

  it('the hang-up reaches the callee when the caller hosts the call', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { ringTimeoutMs: 1500 }), 'alice');
    // Bob can't host, so Alice's device is the relay: hanging up closes it.
    const bob = await signUp(makeClient(net, coord, { canHost: false }), 'bob');
    alice.voiceEngine = silentVoice();
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12000, 'friends');

    await alice.callDm(bob.userId);
    await waitFor(() => bob.state.incomingCall, 12000, 'bob rings');
    const started = Date.now();
    await waitFor(() => !alice.state.voiceSession, 6000, 'hung up');
    await waitFor(() => !bob.state.incomingCall, 6000, 'stops ringing for bob');
    // By the hang-up itself, not because the rings stopped.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  /** Alice and Bob, friends, both able to take calls. */
  async function callers(opts: { bobCanHost?: boolean } = {}) {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord, { canHost: opts.bobCanHost ?? true }), 'bob');
    alice.voiceEngine = silentVoice();
    bob.voiceEngine = silentVoice();
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12000, 'friends');
    return { alice, bob };
  }

  /** Alice calls, Bob answers, and the call is live on both sides. */
  async function liveCall(opts: { bobCanHost?: boolean } = {}) {
    const { alice, bob } = await callers(opts);
    await alice.callDm(bob.userId);
    await waitFor(() => bob.state.incomingCall, 12000, 'bob rings');
    // Ringing is not talking: the call is on, but not live.
    expect(alice.state.callLiveSince).toBeNull();
    await bob.callDm(alice.userId);
    await waitFor(
      () => alice.state.callLiveSince && bob.state.callLiveSince,
      12000,
      'live on both sides',
    );
    const sid = alice.state.voiceSession!;
    return { alice, bob, sid };
  }

  it('ends the call for the other side when one hangs up after answering', async () => {
    for (const bobCanHost of [true, false]) {
      const { alice, bob, sid } = await liveCall({ bobCanHost });
      expect(alice.state.sessions[sid]!.inCall.sort()).toEqual([alice.userId, bob.userId].sort());
      const started = Date.now();
      await alice.leaveVoice();
      await waitFor(() => !bob.state.voiceSession, 6000, 'ended for bob');
      expect(Date.now() - started).toBeLessThan(3000);
      expect(bob.state.callLiveSince).toBeNull();
      expect(bob.state.errors).toContainEqual(
        expect.objectContaining({ message: 'Call ended', kind: 'info' }),
      );
    }
  });

  it('ends the call when the other side leaves it, even if the hang-up was lost', async () => {
    const { alice, bob, sid } = await liveCall();
    // Bob's app leaves the call without a word (the hang-up got lost).
    await bob.leaveVoice({ quiet: true });
    await waitFor(() => !alice.state.voiceSession, 6000, 'ended for alice');
    // Bob is still in the conversation, just not in the call.
    await waitFor(() => alice.state.sessions[sid]?.peers.includes(bob.userId), 8000, 'chat');
    expect(alice.state.sessions[sid]!.inCall).toEqual([]);
  });

  it("stops the call's clock as soon as the other side is gone, while waiting for them", async () => {
    const { alice, bob, sid } = await liveCall();
    // Alice's app goes away without hanging up (its hang-up never leaves).
    (alice as unknown as { sendCallSignal: () => boolean }).sendCallSignal = () => false;
    await alice.shutdown();
    // Bob answered the call, but answering doesn't keep it live with nobody there.
    await waitFor(() => !bob.state.callLiveSince, 6000, 'not live');
    // Still in the call for a while, in case Alice comes back.
    expect(bob.state.voiceSession).toBe(sid);
  });

  it('measures each call member’s latency to the host for everyone to see', async () => {
    const { alice, bob, sid } = await liveCall();
    await waitFor(
      () => {
        const l = alice.state.sessions[sid]?.latency ?? {};
        return l[alice.userId] !== undefined && l[bob.userId] !== undefined;
      },
      8000,
      'both latencies',
    );
  });

  it('stops ringing when the caller goes quiet without hanging up', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    alice.voiceEngine = silentVoice();
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12000, 'friends');

    await alice.callDm(bob.userId);
    await waitFor(() => bob.state.incomingCall, 12000, 'bob rings');
    // Alice's app freezes: no more rings, and no hang-up either.
    clearInterval((alice as unknown as { ringTimer: ReturnType<typeof setInterval> }).ringTimer);
    await waitFor(() => !bob.state.incomingCall, 12000, 'stops ringing for bob');
  }, 30_000);
});

describe('space admins', () => {
  it('lets an admin change the space and invite people, until the owner says otherwise', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    const carol = await signUp(makeClient(net, coord), 'carol');
    const dave = await signUp(makeClient(net, coord), 'dave');
    const spaceId = await alice.createSpace('Swamp');
    await bob.joinWithInvite(await alice.createInvite(spaceId));
    // A member can't change the space.
    await expect(bob.addChannel(spaceId, 'mine', 'text')).rejects.toThrow(/owner or an admin/);

    await alice.setAdmin(spaceId, bob.userId, true);
    await waitFor(() => bob.state.spaces[spaceId]?.admins.includes(bob.userId), 8000, 'admin');
    await bob.updateSpace(spaceId, (b) => ({ ...b, name: 'Pond' }));
    await bob.addChannel(spaceId, 'lily pads', 'text');
    // Two changes, each its own update: Alice gets both, in either order.
    await waitFor(
      () =>
        alice.state.spaces[spaceId]?.name === 'Pond' &&
        alice.state.spaces[spaceId]?.channels.some((c) => c.name === 'lily-pads'),
      8000,
      'renamed, with the new channel',
    );
    // Bob's invites work for others.
    const bobsInvite = await bob.createInvite(spaceId);
    await carol.joinWithInvite(bobsInvite);
    expect(carol.state.spaces[spaceId]?.name).toBe('Pond');
    // Admins ban members, but not the owner.
    await bob.banMember(spaceId, carol.userId);
    await waitFor(() => !carol.state.spaces[spaceId], 8000, 'carol banned');
    await bob.banMember(spaceId, alice.userId);
    await new Promise((r) => setTimeout(r, 300));
    expect(alice.state.spaces[spaceId]).toBeDefined();
    // But choosing admins and deleting the space stay with the owner.
    await expect(bob.setAdmin(spaceId, carol.userId, true)).rejects.toThrow(/owner/);
    await expect(bob.deleteSpace(spaceId)).rejects.toThrow(/owner/);

    await alice.setAdmin(spaceId, bob.userId, false);
    await waitFor(() => bob.state.spaces[spaceId]?.admins.length === 0, 8000, 'no longer admin');
    await expect(bob.addChannel(spaceId, 'again', 'text')).rejects.toThrow(/owner or an admin/);
    // His invite stopped working with his rights.
    await expect(dave.joinWithInvite(bobsInvite)).rejects.toThrow(/no longer an admin/);
  });
});

describe('invites in chat', () => {
  it('previews the space an invite leads to, before and after joining', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    const spaceId = await alice.createSpace('Pond');
    const code = await alice.createInvite(spaceId);
    expect(await bob.previewInvite(`croc://join/${code}`)).toEqual({
      code,
      spaceId,
      name: 'Pond',
      joined: false,
      expired: false,
    });
    // Only seen, not joined: the space stays out of Bob's list.
    expect(bob.state.spaces[spaceId]).toBeUndefined();
    await bob.joinWithInvite(code);
    expect((await bob.previewInvite(code))?.joined).toBe(true);
    expect(await bob.previewInvite('croc://join/zzzzzzzzzz')).toBeNull();
  });

  it("doesn't trust a server's invite that the space's owner didn't sign", async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    const spaceId = await alice.createSpace('Pond');
    // A lying server answers for a code with an invite to Alice's space,
    // signed by someone who may not make one.
    const mallory = createIdentity();
    const code = 'mmmmmmmmmm';
    const forged = signRecord(mallory, 'invite', recordKey.invite(code), {
      spaceId,
      code,
      expiresAt: null,
    });
    const link = bob.link!;
    const request = link.request.bind(link);
    link.request = (async (method: string, params: { keys?: string[] }) =>
      method === 'records.get' && params.keys?.[0] === recordKey.invite(code)
        ? { records: [forged] }
        : request(method as never, params as never)) as typeof link.request;
    expect(await bob.previewInvite(code)).toBeNull();
  });
});

describe('server list', () => {
  it('lists every public server, with one latency for the connected one', async () => {
    const dir = await new Directory({ host: '127.0.0.1', port: 0, allowPrivateUrls: true }).start();
    cleanup.push(() => dir.stop());
    const a = await server({ directoryUrls: [dir.url], announce: true });
    const b = await server({ directoryUrls: [dir.url], announce: true });
    await waitFor(() => dir.listing().servers.length === 2, 5000, 'registration');
    const alice = await signUp(
      makeClient(new FakeRelayNetwork(), a, { directories: [dir.url] }),
      'alice',
    );
    const listed = (id: string) => alice.state.servers.find((s) => s.info.id === id);
    await waitFor(() => alice.state.servers.length === 2, 5000, 'server list');
    expect(alice.state.server!.info.id).toBe(a.info.id);
    // The connected server shows the same latency in the list as at the top…
    expect(listed(a.info.id)!.rttMs).toBe(alice.state.server!.rttMs);
    // …also after measuring it again.
    await alice.measureLatency();
    expect(listed(a.info.id)!.rttMs).toBe(alice.state.server!.rttMs);

    // A server that stops answering stays listed, last, marked unreachable.
    await b.stop();
    await alice.refreshServers();
    expect(alice.state.servers.at(-1)).toMatchObject({ info: { id: b.info.id }, rttMs: Infinity });
    expect(listed(a.info.id)!.rttMs).toBe(alice.state.server!.rttMs);
  });
});

describe('preferred servers', () => {
  it('moves a server to the front without listing it twice', async () => {
    const coord = await server();
    const client = await signUp(makeClient(new FakeRelayNetwork(), coord), 'alice');
    await client.updateSettings({ preferredServers: ['http://a.test', 'http://b.test'] });
    await client.preferServer('http://b.test');
    expect(client.state.settings.preferredServers).toEqual(['http://b.test', 'http://a.test']);
    await client.preferServer('http://c.test');
    expect(client.state.settings.preferredServers).toEqual([
      'http://c.test',
      'http://b.test',
      'http://a.test',
    ]);
  });
});

describe('who runs the server', () => {
  it('shows the contact a server gives, and drops a malformed one', async () => {
    const net = new FakeRelayNetwork();
    const listed = await server({ operatorContact: 'ops@example.org' });
    const alice = await signUp(makeClient(net, listed), 'alice');
    expect(alice.state.server!.operator).toEqual({ contact: 'ops@example.org' });

    // A server can send anything; the app shows only an email or an https page.
    const odd = await server({ operatorContact: 'ops@example.org' });
    (odd.config as { operatorContact?: string }).operatorContact = 'javascript:alert(1)';
    const bob = await signUp(makeClient(net, odd), 'bob');
    expect(bob.state.server!.info.id).toBe(odd.info.id);
    expect(bob.state.server!.operator).toBeUndefined();
  });
});

describe('multiple devices', () => {
  it('links a new device with a code and delivers to every device of a user', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice1 = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');

    // A fresh install shows a code; the signed-in device types it in.
    const alice2 = makeClient(net, coord);
    await alice2.init();
    expect(alice2.state.phase).toBe('onboarding');
    await alice2.startDeviceLink();
    const code = await waitFor(
      () => (alice2.state.linking?.role === 'new' ? alice2.state.linking.code : undefined),
      5000,
      'code',
    );
    const shownOnOld = await alice1.claimDeviceLink(code);
    const shownOnNew = await waitFor(
      () =>
        alice2.state.linking?.role === 'new' && alice2.state.linking.step === 'claimed'
          ? alice2.state.linking.securityCode
          : undefined,
      5000,
      'claimed',
    );
    expect(shownOnNew).toBe(shownOnOld);
    await alice1.confirmDeviceLink();
    await waitFor(
      () => alice2.identity?.userId === alice1.userId && alice2.state.link === 'connected',
      5000,
      'linked',
    );
    alice2.finishOnboarding();
    expect(alice2.deviceId).not.toBe(alice1.deviceId);
    await waitFor(() => alice1.state.devices.length === 2, 12000, 'device list');

    const spaceId = await alice1.createSpace('Devices');
    const code2 = await alice1.createInvite(spaceId);
    await bob.joinWithInvite(code2);
    await waitFor(() => alice2.state.spaces[spaceId], 12000, 'space on second device');
    const ch = channelOf(alice1, spaceId);
    for (const c of [alice1, alice2, bob]) await c.openChannel(ch);
    const sid = sessionIds.space(spaceId);
    await waitFor(
      () => [alice1, alice2, bob].every((c) => c.sessionFor(sid)?.peers.size === 2),
      8000,
      'three peers',
    );
    // Each device keeps its own network type, and knows which one is itself.
    const networks = alice2.state.sessions[sid]!.networks;
    expect(
      networks
        .filter((n) => n.user === alice1.userId)
        .map((n) => n.nat)
        .sort(),
    ).toEqual(['cone', 'open']);
    expect(networks.find((n) => n.self)?.nat).toBe('cone');
    expect(networks.filter((n) => n.host)).toHaveLength(1);
    await bob.sendMessage(ch, 'to all your devices');
    await waitFor(
      () =>
        bodies(alice1, ch).includes('to all your devices') &&
        bodies(alice2, ch).includes('to all your devices'),
      5000,
    );
    await alice2.sendMessage(ch, 'from my laptop');
    await waitFor(
      () =>
        bodies(alice1, ch).includes('from my laptop') && bodies(bob, ch).includes('from my laptop'),
      5000,
    );

    // Removing a device: peers stop trusting it.
    await alice1.revokeDevice(alice2.deviceId);
    const alice2Peer = `${alice2.userId}.${alice2.deviceId}`;
    await waitFor(() => !bob.isAllowedPeer(sid, alice2Peer), 12000, 'revocation seen by bob');
    expect(bob.isAllowedPeer(sid, `${alice1.userId}.${alice1.deviceId}`)).toBe(true);
  });

  it('rejects a link when the security codes are not confirmed', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const fresh = makeClient(net, coord);
    await fresh.init();
    await fresh.startDeviceLink();
    const code = await waitFor(
      () => (fresh.state.linking?.role === 'new' ? fresh.state.linking.code : undefined),
      5000,
    );
    await expect(alice.claimDeviceLink('WRONGCODE')).rejects.toThrow(/not valid/);
    await alice.claimDeviceLink(code);
    // Not confirmed: nothing is sent and the new device stays signed out.
    await new Promise((r) => setTimeout(r, 300));
    expect(fresh.identity).toBeNull();
    fresh.cancelDeviceLink();
  });

  it('shows different security codes when the server swaps the key the account is sent to', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const fresh = makeClient(net, coord);
    await fresh.init();
    await fresh.startDeviceLink();
    const code = await waitFor(
      () => (fresh.state.linking?.role === 'new' ? fresh.state.linking.code : undefined),
      5000,
    );
    // A dishonest server answers the claim with its own encryption key, so the
    // account would be sealed to the server instead of the new device.
    const mallory = createIdentity();
    const link = alice.link!;
    const request = link.request.bind(link);
    link.request = (async (method: string, params: unknown) => {
      const res = await request(method as never, params as never);
      return method === 'link.claim' ? { ...(res as object), encKey: mallory.encPublicKey } : res;
    }) as typeof link.request;

    const shownOnAlice = await alice.claimDeviceLink(code);
    const shownOnNew = await waitFor(
      () => (fresh.state.linking?.role === 'new' ? fresh.state.linking.securityCode : undefined),
      5000,
      'claimed',
    );
    // The person comparing the screens sees a mismatch and doesn't confirm.
    expect(shownOnAlice).not.toBe(shownOnNew);
    fresh.cancelDeviceLink();
  });
});

describe('client and server quotas', () => {
  it('reuses a valid invite instead of making a new one each time', async () => {
    const coord = await server();
    const alice = await signUp(makeClient(new FakeRelayNetwork(), coord), 'alice');
    const spaceId = await alice.createSpace('Swamp');
    const first = await alice.shareInvite(spaceId);
    expect(await alice.shareInvite(spaceId)).toBe(first);
    // Making a new one on purpose still works.
    expect(await alice.createInvite(spaceId)).not.toBe(first);
  });

  it('does not keep a record the server refused', async () => {
    const coord = await server({ quotas: { spacesPerUser: 1 } });
    const alice = await signUp(makeClient(new FakeRelayNetwork(), coord), 'alice');
    await alice.createSpace('One');
    await expect(alice.createSpace('Two')).rejects.toThrow(/quota reached/);
    const cached = alice.records.list('space:').map((r) => (r.body as { name: string }).name);
    expect(cached).toEqual(['One']);
  });

  it('joining a big space fetches the members profiles in one go', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const bob = await signUp(makeClient(net, coord), 'bob');
    const spaceId = await bob.createSpace('Crowd');
    const code = await bob.createInvite(spaceId);
    for (let i = 0; i < 40; i++) {
      const u = await connectUser(coord);
      cleanup.push(() => u.conn.close());
      await joinSpace(u, spaceId, code);
    }
    const alice = await signUp(makeClient(net, coord), 'alice');
    const link = alice.link!;
    const request = link.request.bind(link);
    let gets = 0;
    link.request = ((m: string, p: unknown) => {
      if (m === 'records.get') gets++;
      return request(m as never, p as never);
    }) as typeof link.request;
    await alice.joinWithInvite(`croc://join/${code}`);
    await waitFor(() => alice.state.spaces[spaceId]?.members.length === 42, 5000, 'members');
    await new Promise((r) => setTimeout(r, 300));
    // Not one request per member record (which the server would rate-limit).
    expect(gets).toBeLessThan(10);
  });

  it('follows more users than one request may name', async () => {
    const coord = await server();
    const alice = await signUp(makeClient(new FakeRelayNetwork(), coord), 'alice');
    // 2500 people in our DMs: past the 2000 prefixes one subscribe request takes.
    const dms = Array.from({ length: 2500 }, () => createIdentity().userId);
    alice.store.set({ dms });
    await (alice as unknown as { syncProfiles(): Promise<void> }).syncProfiles();
    expect(Object.keys(alice.state.presence).length).toBeGreaterThanOrEqual(2500);
  }, 30_000);
});

describe('leaving', () => {
  it('signing out revokes this device on the server', async () => {
    const coord = await server();
    const alice = await signUp(makeClient(new FakeRelayNetwork(), coord), 'alice');
    const userId = alice.userId;
    const deviceId = alice.deviceId;
    await waitFor(
      () => coord.records.get(recordKey.device(userId, deviceId)),
      3000,
      'device registered',
    );
    await alice.signOut();
    expect(alice.state.phase).toBe('onboarding');
    const device = coord.records.get(recordKey.device(userId, deviceId))?.body as DeviceBody;
    expect(device.revoked).toBe(true);
  });

  it('deleting the account removes it for friends and signs out its other devices', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const kv = new MemoryKeyValueStore();
    const alice = await signUp(makeClient(net, coord, { nat: 'open', kv }), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.incoming.includes(bob.userId), 3000, 'request');
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.friends.includes(alice.userId), 5000, 'friends');
    const owned = await alice.createSpace('Alice place');
    const bobs = await bob.createSpace('Bob place');
    await alice.joinWithInvite(await bob.createInvite(bobs));
    await waitFor(() => bob.state.spaces[bobs]?.members.includes(alice.userId), 3000, 'member');
    await bob.joinWithInvite(await alice.createInvite(owned));
    await waitFor(() => bob.state.spaces[owned], 3000, 'bob joined');

    // The same account on a second device.
    const laptop = makeClient(net, coord);
    await laptop.init();
    await laptop.restoreAccount(alice.recoveryKey());
    await waitFor(() => laptop.state.link === 'connected', 5000, 'laptop connected');
    // The laptop is in a channel session when the account goes.
    await waitFor(() => laptop.state.spaces[bobs], 5000, 'laptop synced');
    await laptop.openChannel(channelOf(laptop, bobs));
    await waitFor(() => laptop.state.sessions[sessionIds.space(bobs)], 5000, 'laptop session');

    const aliceId = alice.userId;
    await alice.deleteAccount();
    expect(alice.state.phase).toBe('onboarding');
    expect(alice.state.accountDeleted).toBe(true);
    expect(alice.identity).toBeNull();
    // The other device forgets the account too, promptly despite its session.
    await waitFor(() => laptop.state.accountDeleted, 3000, 'laptop signed out');
    expect(laptop.state.phase).toBe('onboarding');
    // Nothing erased comes back from a delayed save.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await kv.get('records-cache')).toBeUndefined();
    expect(await kv.get('outbox')).toBeUndefined();
    // Bob: the space she owned is gone, she left his, and she's no longer a friend.
    await waitFor(() => !bob.state.spaces[owned], 5000, 'owned space deleted');
    await waitFor(() => !bob.state.spaces[bobs]?.members.includes(aliceId), 5000, 'left bob space');
    await waitFor(() => !bob.state.friends.friends.includes(aliceId), 5000, 'unfriended');
    expect(bob.state.friends.outgoing).not.toContain(aliceId);
  });

  it('a stopped link fails requests at once instead of waiting for a server', async () => {
    const link = new CoordinatorLink({
      identity: createIdentity(),
      deviceId: 'testdevice',
      platform: 'desktop',
      version: 'test',
      kv: new MemoryKeyValueStore(),
      directories: [],
    });
    link.stop();
    const started = Date.now();
    await expect(link.request('records.get', { keys: [] })).rejects.toThrow(/stopped/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("doesn't erase anything on a server's word without the signed marker", async () => {
    const coord = await server();
    const alice = await signUp(makeClient(new FakeRelayNetwork(), coord), 'alice');
    const userId = alice.userId;
    // A server (or anything in between) claims the account was deleted.
    for (const client of coord.presence.localOf(userId)) client.close(4010, 'account deleted');
    await waitFor(() => alice.state.link !== 'connected', 3000, 'disconnected');
    await waitFor(() => alice.state.link === 'connected', 5000, 'reconnected');
    expect(alice.identity?.userId).toBe(userId);
    expect(alice.state.accountDeleted).toBe(false);
    expect(alice.state.me?.userId).toBe(userId);
  });

  it('deletes owned spaces this device never synced', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const owned = await alice.createSpace('Old place');
    // She left her own space, so a restored device doesn't list it as hers.
    await alice.leaveSpace(owned);
    const laptop = makeClient(net, coord);
    await laptop.init();
    await laptop.restoreAccount(alice.recoveryKey());
    await waitFor(() => laptop.state.link === 'connected', 5000, 'laptop connected');
    expect(laptop.records.get(recordKey.space(owned))).toBeUndefined();
    await laptop.deleteAccount();
    expect((coord.records.get(recordKey.space(owned))?.body as SpaceBody).deleted).toBe(true);
  });

  it('drops a deleted account from member lists even if its leave never arrived', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    const space = await bob.createSpace('Swamp');
    await alice.joinWithInvite(await bob.createInvite(space));
    await waitFor(() => bob.state.spaces[space]?.members.includes(alice.userId), 3000, 'member');
    // Bob was offline: all he gets later is the marker.
    const marker = signRecord(alice.identity!, 'profile', recordKey.profile(alice.userId), {
      username: DELETED_PROFILE_NAME,
      encKey: alice.identity!.encPublicKey,
      deleted: true,
    });
    expect(bob.records.ingest(marker)).toBe(true);
    expect(bob.state.spaces[space]?.members).not.toContain(alice.userId);
  });
});
