import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CrocodileClient,
  MemoryKeyValueStore,
  MemoryMessageStore,
  type PlatformAdapter,
} from '@crocodile/client-core';
import type { Coordinator, CoordinatorConfig } from '@crocodile/coordinator';
import {
  createIdentity,
  createLinkKem,
  createPrekey,
  linkCommitment,
  linkNonce,
  randomDeviceId,
  sealAnonymous,
  sealToDevice,
  signMailProof,
  signRecord,
  spaceIdFor,
} from '@crocodile/crypto';
import {
  DELETED_PROFILE_NAME,
  PROTOCOL_VERSION,
  peerIds,
  recordKey,
  sessionIds,
  utf8,
  type SignedRecord,
} from '@crocodile/protocol';
import { FakeRelayNetwork } from './helpers/fake-relay';
import {
  caps,
  connectUser,
  createSpace,
  expectAccepted,
  joinSpace,
  startCoordinator,
  waitFor,
  type TestUser,
} from './helpers';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Fast timings, two owners per record and a sparse overlay from four servers on. */
const sharded: Partial<CoordinatorConfig> = {
  replicas: 2,
  mesh: { fullMeshMax: 3, maintainMs: 150, idleMs: 1500 },
  membership: { beaconMs: 600, liveMs: 3000, settleMs: 300 },
  distribution: {
    gcStableMs: 1200,
    gcCheckMs: 250,
    watchRenewMs: 1000,
    watchTtlMs: 3000,
    deletionRetryMs: 300,
  },
};

async function server(name: string, overrides: Partial<CoordinatorConfig> = {}) {
  const c = await startCoordinator({ name, ...sharded, ...overrides });
  cleanup.push(() => c.stop());
  return c;
}

/** n servers that each know only the one before; they find the rest through gossip. */
async function network(n: number, overrides: Partial<CoordinatorConfig> = {}) {
  const servers = [await server('S0', overrides)];
  for (let i = 1; i < n; i++)
    servers.push(await server(`S${i}`, { meshPeers: [servers[i - 1]!.url], ...overrides }));
  await converged(servers);
  return servers;
}

async function converged(servers: Coordinator[]) {
  await waitFor(
    () =>
      servers.every(
        (c) =>
          c.membership.liveIds().length === servers.length &&
          c.membership.settled.size === servers.length,
      ),
    15_000,
    'every server sees every other',
  );
}

const holders = (servers: Coordinator[], key: string) =>
  servers.filter((c) => c.store.get(key)).map((c) => c.info.id);

const owners = (servers: Coordinator[], record: SignedRecord) =>
  servers[0]!.membership.settled.placement(record).sort();

async function user(c: Coordinator, name?: string) {
  const u = await connectUser(c, createIdentity(), name);
  cleanup.push(() => u.conn.close());
  return u;
}

async function put(u: TestUser, record: SignedRecord) {
  expectAccepted(await u.conn.request('records.put', { record }));
}

function makeClient(net: FakeRelayNetwork, coordinator: Coordinator) {
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
    preferredServers: [coordinator.url],
    transportFactory: net.transportFactory(),
    log: process.env.DBG ? (m, e) => console.log('client', m, JSON.stringify(e)) : undefined,
  });
  cleanup.push(() => client.shutdown());
  return client;
}

async function signUp(client: CrocodileClient, name: string) {
  await client.init();
  await client.createAccount(name);
  await waitFor(() => client.state.link === 'connected' && client.state.me, 8000, name);
  return client;
}

describe('sharded records', () => {
  it('keeps each record on its owners, and every server can read it', async () => {
    const servers = await network(6);
    const alice = await user(servers[0]!, 'alice');
    const { spaceId, space, code } = await createSpace(alice, 'Swamp');
    const readers = await Promise.all(servers.map((c) => user(c)));
    // Readable through any server, owner or not (the invite reaches the
    // owners of its code a moment after the owners of its space).
    const keys = [space.key, `invite:${code}`].sort();
    for (const r of readers) {
      let got: string[] = [];
      for (const start = Date.now(); Date.now() - start < 3000;) {
        const res = await r.conn.request('records.get', { keys });
        got = res.records.map((x) => x.key).sort();
        if (got.join() === keys.join()) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      expect(got).toEqual(keys);
    }
    // Stored by its owners, and once things settle, by nobody else.
    await waitFor(
      () => holders(servers, space.key).sort().join() === owners(servers, space).join(),
      8000,
      'space only on its owners',
    );
    expect(owners(servers, space).length).toBeLessThanOrEqual(4);
    // A search by name and a member list go to the shards that hold them.
    const found = await readers[5]!.conn.request('users.search', { query: 'alice' });
    expect(found.profiles.map((p) => p.key)).toEqual([recordKey.profile(alice.identity.userId)]);
    await joinSpace(readers[3]!, spaceId, code);
    const members = await readers[4]!.conn.request('records.list', {
      prefix: recordKey.memberPrefix(spaceId),
    });
    expect(members.records).toHaveLength(2);
    const mine = await readers[3]!.conn.request('spaces.mine', {});
    expect(mine.spaces.map((s) => s.key)).toEqual([space.key]);
  });

  it('keeps the overlay sparse, and still reaches every server', async () => {
    const servers = await network(12);
    // Direct links that were only needed for a moment close again, once
    // they have been idle a while (later when a busy machine runs it slowly).
    const mostLinks = () => Math.max(...servers.map((c) => c.mesh.peerIds().length));
    await waitFor(() => mostLinks() < 11, 10_000, 'idle links closed');
    expect(mostLinks()).toBeLessThan(11);
    // Presence still travels between servers that aren't linked.
    const far = servers.find((c) => !c.mesh.peerIds().includes(servers[0]!.info.id))!;
    const watcher = await user(servers[0]!);
    const target = await user(far);
    const { presence } = await watcher.conn.request('presence.subscribe', {
      userIds: [target.identity.userId],
    });
    expect(presence[0]!.status).toBe('online');
  });

  it('notifies clients of changes to records their server does not own', async () => {
    const servers = await network(6);
    const alice = await user(servers[0]!, 'alice');
    const watchers = await Promise.all(servers.map((c) => user(c)));
    const key = recordKey.profile(alice.identity.userId);
    for (const w of watchers) await w.conn.request('records.subscribe', { prefixes: [key] });
    await new Promise((r) => setTimeout(r, 300));
    const renamed = signRecord(alice.identity, 'profile', key, {
      username: 'alice2',
      encKey: alice.identity.encPublicKey,
    });
    await put(alice, renamed);
    for (const w of watchers) {
      await waitFor(
        () =>
          w.events.some(
            (e) =>
              e.ev === 'record' && (e.d as { record: SignedRecord }).record.sig === renamed.sig,
          ),
        5000,
        'pushed to a watcher',
      );
    }
    // The old name's shard was told too, so it no longer finds her.
    const byOld = await watchers[2]!.conn.request('users.search', { query: 'alice' });
    expect(byOld.profiles).toEqual([]);
  });

  it('moves records to new owners as servers join, and drops copies no longer owned', async () => {
    const first = await network(3);
    const alice = await user(first[0]!, 'alice');
    const written: SignedRecord[] = [];
    for (let i = 0; i < 12; i++) {
      const { space } = await createSpace(alice, `Space ${i}`);
      written.push(space);
    }
    const more = [
      await server('S3', { meshPeers: [first[0]!.url] }),
      await server('S4', { meshPeers: [first[1]!.url] }),
      await server('S5', { meshPeers: [first[2]!.url] }),
    ];
    const servers = [...first, ...more];
    await converged(servers);
    for (const r of written) {
      await waitFor(
        () => holders(servers, r.key).sort().join() === owners(servers, r).join(),
        10_000,
        `${r.key} on exactly its owners`,
      );
    }
    // Some records really did move to the new servers.
    expect(written.some((r) => more.some((c) => c.store.get(r.key)))).toBe(true);
  });

  it('keeps records when an owner goes away', async () => {
    const servers = await network(5);
    const alice = await user(servers[0]!, 'alice');
    const written: SignedRecord[] = [];
    for (let i = 0; i < 8; i++) written.push((await createSpace(alice, `Space ${i}`)).space);
    // Take down a server that owns some of them (not the one Alice uses).
    const victim = servers.slice(1).find((c) => written.some((r) => c.store.get(r.key)))!;
    await victim.stop();
    const rest = servers.filter((c) => c !== victim);
    await converged(rest);
    for (const r of written) {
      await waitFor(
        () => holders(rest, r.key).length >= 2,
        10_000,
        `${r.key} copied to a new owner`,
      );
    }
    const reader = await user(rest[rest.length - 1]!);
    const got = await reader.conn.request('records.get', { keys: written.map((r) => r.key) });
    expect(got.records).toHaveLength(written.length);
  });

  it('keeps a copy handed over before this server sees that it owns it', async () => {
    // An owner that held a link to a server that went away notices at once
    // and hands its records on; a server without a link only notices when the
    // beacons stop. A copy arriving in between must not be thrown away as
    // "owned elsewhere".
    const servers = await network(5);
    const alice = await user(servers[0]!, 'alice');
    const { space } = await createSpace(alice, 'Swamp');
    const others = servers.filter((c) => !owners(servers, space).includes(c.info.id));
    const late = others[others.length - 1]!;
    const sender = owners(servers, space)[0]!;
    // Its view has been stable for long enough to collect garbage.
    await waitFor(
      () => Date.now() - late.membership.stableSince > sharded.distribution!.gcStableMs! + 300,
      5000,
      'a stable view',
    );
    await late.dist.onReplicated([{ seq: 0, record: space }], sender);
    expect(late.dist.collectGarbage()).toBe(0);
    expect(late.store.get(space.key)?.sig).toBe(space.sig);
    // Once it has had time to see the change and didn't, the copy goes.
    const { liveMs, settleMs } = sharded.membership!;
    const later = Date.now() + liveMs! + settleMs! + sharded.distribution!.gcStableMs!;
    expect(late.dist.collectGarbage(later)).toBe(1);
    expect(late.store.get(space.key)).toBeUndefined();
  });

  it('repairs a copy that went missing on one owner', async () => {
    const servers = await network(5);
    const alice = await user(servers[0]!, 'alice');
    const { space } = await createSpace(alice, 'Swamp');
    await waitFor(
      () => holders(servers, space.key).sort().join() === owners(servers, space).join(),
      8000,
      'stored by its owners',
    );
    const [lost, kept] = owners(servers, space).map((id) => servers.find((c) => c.info.id === id)!);
    lost!.store.delete(space.key);
    // Nothing else would bring it back; comparing notes with another owner does.
    await lost!.dist.repair(kept!.info.id);
    expect(lost!.store.get(space.key)?.sig).toBe(space.sig);
    // And the other way round: an owner that has it sends it.
    lost!.store.delete(space.key);
    await kept!.dist.repair(lost!.info.id);
    await waitFor(() => lost!.store.get(space.key), 3000, 'sent back');
  });

  it('a server that keeps a full copy has everything', async () => {
    const servers = await network(4);
    const archive = await server('archive', { meshPeers: [servers[0]!.url], storeAll: true });
    const all = [...servers, archive];
    await converged(all);
    await waitFor(
      () => servers.every((c) => c.membership.settled.full.includes(archive.info.id)),
      5000,
      'everyone knows the archive keeps everything',
    );
    const alice = await user(servers[1]!, 'alice');
    const spaces = [];
    for (let i = 0; i < 6; i++) spaces.push((await createSpace(alice, `S${i}`)).space);
    for (const s of spaces) await waitFor(() => archive.store.get(s.key), 5000, 'on the archive');
  });

  it.each([
    ['one with no protocol field', undefined],
    ['one before presence was signed', 2],
  ])('refuses servers that speak the old protocol (%s)', async (_name, protocol) => {
    const a = await server('new');
    const ws = new WebSocket(a.url.replace('http', 'ws') + '/v1/federation');
    const closed = new Promise<string>((resolve) =>
      ws.addEventListener('close', (e) => resolve(e.reason)),
    );
    ws.addEventListener('message', (e) => {
      const hello = JSON.parse(String(e.data)) as { t: string };
      if (hello.t !== 'fed_hello') return;
      const old = createIdentity();
      ws.send(
        JSON.stringify({
          t: 'fed_hello',
          server: { ...a.info, id: old.userId, key: old.publicKey, url: 'http://127.0.0.1:1' },
          challenge: 'c',
          channel: { x25519: '', mlkem: '' },
          ...(protocol ? { protocol } : {}),
        }),
      );
    });
    expect(await closed).toBe(`protocol ${PROTOCOL_VERSION} required`);
  });
});

describe('staying consistent', () => {
  it('reads every owner, so one that lacks a record does not hide it', async () => {
    const servers = await network(6);
    const alice = await user(servers[0]!, 'alice');
    const { space } = await createSpace(alice, 'Swamp');
    await waitFor(
      () => holders(servers, space.key).sort().join() === owners(servers, space).join(),
      8000,
      'stored by its owners',
    );
    const reader = servers.find((c) => !owners(servers, space).includes(c.info.id))!;
    // The owner the reader would ask first has lost its copy.
    const first = reader.membership.view
      .ownersOf(`space:${space.key.slice('space:'.length)}`)
      .find((id) => id !== reader.info.id)!;
    servers.find((c) => c.info.id === first)!.store.delete(space.key);
    const r = await user(reader);
    for (let i = 0; i < 3; i++) {
      const { records } = await r.conn.request('records.get', { keys: [space.key] });
      expect(records.map((x) => x.sig)).toEqual([space.sig]);
    }
  });

  it('keeps sending a deletion until the space owners confirm it', async () => {
    const servers = await network(5);
    const alice = await user(servers[0]!, 'alice');
    const { spaceId, code } = await createSpace(alice, 'Swamp');
    const bob = await user(servers[3]!, 'bob');
    await joinSpace(bob, spaceId, code);
    const memberKey = recordKey.member(spaceId, bob.identity.userId);
    await waitFor(() => holders(servers, memberKey).length >= 2, 5000, 'membership stored');
    // For a second, every delivery of the deletion marker between servers is lost.
    const lostUntil = Date.now() + 1000;
    for (const c of servers) {
      const original = c.dist.onReplicated.bind(c.dist);
      c.dist.onReplicated = async (items, from) => {
        if (
          Date.now() < lostUntil &&
          items.some((i) => i.record.key === recordKey.profile(bob.identity.userId))
        )
          throw new Error('lost on the way');
        return original(items, from);
      };
    }
    await put(
      bob,
      signRecord(bob.identity, 'profile', recordKey.profile(bob.identity.userId), {
        username: DELETED_PROFILE_NAME,
        encKey: bob.identity.encPublicKey,
        deleted: true,
      }),
    );
    await waitFor(() => holders(servers, memberKey).length === 0, 8000, 'membership erased');
  });

  it('keeps a deletion added while earlier ones are being sent', async () => {
    const servers = await network(2);
    const a = servers[0]!;
    const marker = () => {
      const id = createIdentity();
      return signRecord(id, 'profile', recordKey.profile(id.userId), {
        username: DELETED_PROFILE_NAME,
        encKey: id.encPublicKey,
        deleted: true,
      });
    };
    // B holds every shard; it answers slowly and loses the first marker.
    const sent: string[] = [];
    const request = a.mesh.request.bind(a.mesh);
    a.mesh.request = (async (id: string, m: string, p: { records?: SignedRecord[] }) => {
      if (m !== 'rec_store') return request(id as never, m as never, p as never);
      await new Promise((r) => setTimeout(r, 200));
      const key = p.records![0]!.key;
      if (!sent.length) {
        sent.push(key);
        throw new Error('lost');
      }
      sent.push(key);
      return {};
    }) as typeof a.mesh.request;
    const first = marker();
    const second = marker();
    a.dist.trackDeletion(first, ['aaaaaaaaaaaaaaaaaaaaaaaaaa']);
    // Added while the first is still on its way.
    await new Promise((r) => setTimeout(r, 50));
    a.dist.trackDeletion(second, ['bbbbbbbbbbbbbbbbbbbbbbbbbb']);
    await waitFor(() => sent.includes(second.key), 5000, 'second deletion sent');
    await waitFor(() => sent.filter((k) => k === first.key).length === 2, 5000, 'first sent again');
  });

  it('answers a request sent while the link to that server is closing', async () => {
    const [a, b] = await network(2);
    const link = (
      a!.mesh as unknown as {
        links: Map<string, { idle: boolean; ws: { close(code: number, r: string): void } }>;
      }
    ).links.get(b!.info.id)!;
    // The link starts closing (as for idleness); a request goes out right then.
    link.idle = true;
    link.ws.close(4000, 'idle');
    const res = await a!.mesh.request<{ records: unknown[] }>(b!.info.id, 'rec_get', {
      keys: [recordKey.profile(createIdentity().userId)],
    });
    expect(res.records).toEqual([]);
  });

  it('tries an unreachable neighbour again after a while', async () => {
    const servers = await network(6);
    const s0 = servers[0]!;
    const mesh = s0.mesh as unknown as {
      dialing: Map<string, { attempts: number; failedAt?: number }>;
      unreachable(id: string): boolean;
    };
    const other = s0.mesh.knownServers()[0]!;
    mesh.dialing.set(other.url, { attempts: 3, failedAt: Date.now() });
    expect(mesh.unreachable(other.id)).toBe(true);
    // Not forever: after the cooldown it counts as worth dialling again.
    mesh.dialing.set(other.url, { attempts: 3, failedAt: Date.now() - 6 * 60_000 });
    expect(mesh.unreachable(other.id)).toBe(false);
  });

  it('catches up on presence news it missed', async () => {
    const servers = await network(4);
    const [x, o] = [servers[0]!, servers[2]!];
    const watcher = await user(x);
    const target = await user(o);
    await waitFor(
      () => x.presence.publicEntry(target.identity.userId).status === 'online',
      3000,
      'online at x',
    );
    // x misses everything for a moment, including the user going offline.
    const apply = x.presence.applyRemote.bind(x.presence);
    x.presence.applyRemote = () => false;
    target.conn.close();
    await waitFor(() => o.presence.localOf(target.identity.userId).length === 0, 3000);
    await new Promise((r) => setTimeout(r, 500));
    x.presence.applyRemote = apply;
    expect(x.presence.publicEntry(target.identity.userId).status).toBe('online');
    // The next beacon from o says x is behind; x asks o directly.
    await waitFor(
      () => x.presence.publicEntry(target.identity.userId).status === 'offline',
      3000,
      'offline at x',
    );
    void watcher;
  });

  it('hears about a voice room that emptied while it was not listening', async () => {
    const servers = await network(3);
    const alice = await user(servers[0]!, 'alice');
    const { spaceId, voiceChannel } = await createSpace(alice, 'Swamp');
    const sid = sessionIds.voice(spaceId, voiceChannel);
    await alice.conn.request('session.join', { sessionId: sid, caps: caps() });
    const owner = servers.find((c) => c.sessions.ownedState(sid))!;
    const [x, y] = servers.filter((c) => c !== owner) as [Coordinator, Coordinator];
    const occupied = (c: Coordinator) => c.sessions.voiceSnapshot([spaceId]).length > 0;
    await waitFor(() => occupied(x) && occupied(y), 3000, 'occupied everywhere');
    const apply = x.sessions.applyRemoteVoice.bind(x.sessions);
    x.sessions.applyRemoteVoice = () => false;
    await alice.conn.request('session.leave', { sessionId: sid });
    await waitFor(() => !occupied(y), 3000, 'empty at y');
    x.sessions.applyRemoteVoice = apply;
    expect(occupied(x)).toBe(true);
    // x links to y again: y's snapshot includes the room that emptied.
    (x.mesh as unknown as { links: Map<string, { ws: { terminate(): void } }> }).links
      .get(y.info.id)!
      .ws.terminate();
    await waitFor(() => !occupied(x), 5000, 'empty at x');
  });
});

describe('across servers that are not linked', () => {
  /** Two servers of a sparse network with no link between them. */
  /**
   * Twelve servers in one process spend most of their time on each other's
   * signed beacons; under coverage (as CI runs) that starves requests. These
   * tests don't depend on how fast a dead server is noticed.
   */
  const quieter: Partial<CoordinatorConfig> = {
    membership: { beaconMs: 2000, liveMs: 8000, settleMs: 300 },
  };

  function apart(servers: Coordinator[]) {
    for (const x of servers)
      for (const y of servers)
        if (x !== y && !x.mesh.peerIds().includes(y.info.id)) return [x, y] as const;
    throw new Error('every server is linked to every other');
  }

  it('delivers mail held on one server to a device that connects to another', async () => {
    const servers = await network(12, quieter);
    await new Promise((r) => setTimeout(r, 2000));
    const [x, y] = apart(servers);
    const bobId = createIdentity();
    let bob = await connectUser(y, bobId, 'bob');
    const deviceId = peerIds.device(bob.conn.peer);
    const prekey = createPrekey().bundle;
    await put(
      bob,
      signRecord(bobId, 'device', recordKey.device(bobId.userId, deviceId), {
        userId: bobId.userId,
        deviceId,
        name: 'laptop',
        platform: 'bot',
        prekey,
      }),
    );
    bob.conn.close();
    await waitFor(() => y.presence.localOf(bobId.userId).length === 0, 3000, 'bob offline');
    const alice = await user(x, 'alice');
    const box = sealToDevice(
      alice.identity,
      peerIds.device(alice.conn.peer),
      { peer: bob.conn.peer, prekey },
      utf8.encode('{"type":"mail","messages":[]}'),
    );
    const { ids } = await alice.conn.request('mail.put', { items: [{ to: bob.conn.peer, box }] });
    expect(x.store.mailCount({ toUser: bobId.userId })).toBe(1);

    bob = await connectUser(y, bobId, 'bob', deviceId);
    cleanup.push(() => bob.conn.close());
    // Without the device's signature, other servers keep their mail; signed
    // for another server, it isn't answered either.
    await bob.conn.request('mail.fetch', {});
    await bob.conn.request('mail.fetch', {
      proof: signMailProof(bobId, { t: 'mail_fetch', peer: bob.conn.peer, server: x.info.id }),
    });
    await new Promise((r) => setTimeout(r, 1000));
    expect(bob.events.some((e) => e.ev === 'mail')).toBe(false);
    await bob.conn.request('mail.fetch', {
      proof: signMailProof(bobId, { t: 'mail_fetch', peer: bob.conn.peer, server: y.info.id }),
    });
    await waitFor(
      () => bob.events.some((e) => e.ev === 'mail'),
      5000,
      'mail from the other server',
    );
    // An acknowledgement without the device's signature deletes nothing elsewhere.
    await bob.conn.request('mail.ack', { ids });
    await new Promise((r) => setTimeout(r, 1000));
    expect(x.store.mailCount({})).toBe(1);
    await bob.conn.request('mail.ack', {
      ids,
      proof: signMailProof(bobId, { t: 'mail_ack', peer: bob.conn.peer, ids }),
    });
    await waitFor(() => x.store.mailCount({}) === 0, 5000, 'acknowledged everywhere');
  });

  it('finds a device-link code opened on another server', async () => {
    const servers = await network(12, quieter);
    await new Promise((r) => setTimeout(r, 2000));
    const [x, y] = apart(servers);
    const fresh = await user(x);
    const kemKey = createLinkKem().publicKey;
    const commit = linkCommitment('k', 'e', kemKey, linkNonce());
    const { code } = await fresh.conn.request('link.open', {
      encKey: createIdentity().encPublicKey,
      kemKey,
      commit,
    });
    const existing = await user(y);
    const found = await existing.conn.request('link.claim', { code });
    expect(found.peer).toBe(fresh.conn.peer);
    expect(found.kemKey).toBe(kemKey);
    expect(found.commit).toBe(commit);
    // The nonce and the reveal travel between the two servers too.
    const claimed = new Promise<{ by: string; nonce: string }>((r) =>
      fresh.conn.on('link_claimed', r),
    );
    const revealed = new Promise<{ nonce: string }>((r) => existing.conn.on('link_reveal', r));
    const theirs = linkNonce();
    await existing.conn.request('link.nonce', { code, nonce: theirs });
    const c = await claimed;
    expect(c).toMatchObject({ by: existing.conn.peer, nonce: theirs });
    const mine = linkNonce();
    await fresh.conn.request('link.reveal', { code, to: c.by, nonce: mine });
    expect((await revealed).nonce).toBe(mine);
    // One reveal per code.
    await expect(
      fresh.conn.request('link.reveal', { code, to: c.by, nonce: linkNonce() }),
    ).rejects.toThrow();
  });

  it('erases a deleted account everywhere its records live', async () => {
    const servers = await network(6);
    const alice = await user(servers[0]!, 'alice');
    const { spaceId, code } = await createSpace(alice, 'Swamp');
    const bob = await user(servers[4]!, 'bob');
    await joinSpace(bob, spaceId, code);
    const memberKey = recordKey.member(spaceId, bob.identity.userId);
    await waitFor(() => holders(servers, memberKey).length >= 2, 5000, 'membership stored');
    await put(
      bob,
      signRecord(bob.identity, 'profile', recordKey.profile(bob.identity.userId), {
        username: DELETED_PROFILE_NAME,
        encKey: bob.identity.encPublicKey,
        deleted: true,
      }),
    );
    await waitFor(() => holders(servers, memberKey).length === 0, 8000, 'membership erased');
    const reader = await user(servers[2]!);
    const { records } = await reader.conn.request('records.list', {
      prefix: recordKey.memberPrefix(spaceId),
    });
    expect(records.map((r) => r.key)).toEqual([recordKey.member(spaceId, alice.identity.userId)]);
  });
});

describe('the app across a sharded network', () => {
  it('befriends, shares a space and chats with people on other servers', async () => {
    const servers = await network(6);
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, servers[0]!), 'alice');
    const bob = await signUp(makeClient(net, servers[3]!), 'bob');
    const carol = await signUp(makeClient(net, servers[5]!), 'carol');

    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12_000, 'request');
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12_000, 'friends');

    const spaceId = await alice.createSpace('Delta');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(code);
    await carol.joinWithInvite(code);
    for (const c of [alice, bob, carol])
      await waitFor(() => c.state.spaces[spaceId]?.members.length === 3, 12_000, 'members');

    const ch = alice.state.spaces[spaceId]!.channels.find((x) => x.kind === 'text')!.id;
    for (const c of [alice, bob, carol]) await c.openChannel(ch);
    await waitFor(
      () => alice.state.sessions[sessionIds.space(spaceId)]?.peers.length === 2,
      12_000,
      'session up',
    );
    await carol.sendMessage(ch, 'hello from the edge');
    for (const c of [alice, bob]) {
      await waitFor(
        () => (c.state.messages[ch] ?? []).some((m) => m.body === 'hello from the edge'),
        12_000,
        'message',
      );
    }
    // Presence across servers.
    await waitFor(() => alice.state.presence[bob.userId] === 'online', 8000, 'presence');
  });
});

describe('large records between servers', () => {
  it('a server joining catches up on records too large for one frame together', async () => {
    const a = await server('A');
    // Profiles with the largest avatars: about 350 KiB each, 10 MB in all.
    const avatar = `data:image/png;base64,${'A'.repeat(Math.ceil(256 * 1024 * 1.37))}`;
    const keys: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = createIdentity();
      const r = signRecord(id, 'profile', recordKey.profile(id.userId), {
        username: `big${i}`,
        encKey: id.encPublicKey,
        avatar,
      });
      expect(a.records.put(r, { fresh: true, origin: null }).accepted).toBe(true);
      keys.push(r.key);
    }
    const b = await server('B', { meshPeers: [a.url] });
    await converged([a, b]);
    await waitFor(() => keys.every((k) => b.store.get(k)), 20_000, 'B holds every large record');
  }, 60_000);

  it('a replicated batch looks up what it needs in one round, not one record at a time', async () => {
    const [a] = (await network(2)) as [Coordinator, Coordinator];
    // Memberships of 40 spaces nobody here holds; every lookup takes 150 ms.
    const items = Array.from({ length: 40 }, () => {
      const id = createIdentity();
      const spaceId = spaceIdFor(id.publicKey, 'nonce-of-a-space');
      const record = signRecord(id, 'member', recordKey.member(spaceId, id.userId), {
        spaceId,
        userId: id.userId,
      });
      return { seq: 0, record };
    });
    let calls = 0;
    const real = a.mesh.request.bind(a.mesh);
    const lookups = vi.spyOn(a.mesh, 'request').mockImplementation((async (
      ...args: Parameters<typeof real>
    ) => {
      if (args[1] !== 'rec_get') return real(...args);
      calls++;
      await new Promise((r) => setTimeout(r, 150));
      return { records: [] };
    }) as typeof a.mesh.request);
    cleanup.push(() => lookups.mockRestore());
    const started = Date.now();
    await a.dist.onReplicated(items, 'elsewhere');
    expect(calls).toBeGreaterThan(0);
    // One record after another would take 40 × 150 ms at least.
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('gets every record an owner has, however many keys and however large', async () => {
    const servers = await network(3);
    // Profiles near the largest allowed: an owner fits one or two in a frame.
    const avatar = `data:image/png;base64,${'A'.repeat(300_000)}`;
    const records: SignedRecord[] = [];
    for (let i = 0; i < 36; i++) {
      const u = await user(servers[1 + (i % 2)]!, `big${i}`);
      const profile = signRecord(u.identity, 'profile', recordKey.profile(u.identity.userId), {
        username: `big${i}`,
        encKey: u.identity.encPublicKey,
        avatar,
      });
      await put(u, profile);
      records.push(profile);
    }
    // The server holding the fewest asks for those it holds none of: all must come from the others.
    const held = (c: Coordinator) => records.filter((r) => owners(servers, r).includes(c.info.id));
    const reader = servers.reduce((a, b) => (held(b).length < held(a).length ? b : a));
    const away = records.filter((r) => !owners(servers, r).includes(reader.info.id));
    expect(away.length).toBeGreaterThan(3);
    await waitFor(
      () => away.every((r) => holders(servers, r.key).length >= 2),
      30_000,
      'profiles reach their owners',
    );
    const real = reader.mesh.request.bind(reader.mesh);
    const asked = vi.spyOn(reader.mesh, 'request');
    // Slow the second and later questions to a server, so that a lookup which stopped waiting
    // once every server had answered something would come back short.
    const seen = new Set<string>();
    asked.mockImplementation(async (id, m, p, timeout) => {
      if (m === 'rec_get' && seen.has(id)) await new Promise((r) => setTimeout(r, 400));
      seen.add(id);
      return real(id, m, p, timeout);
    });
    const got = await reader.dist.get(away.map((r) => r.key));
    expect(got.map((r) => r.key).sort()).toEqual(away.map((r) => r.key).sort());
    // More than one request to a server: its answers were cut to a frame, and it was asked again.
    expect(asked.mock.calls.filter((c) => c[1] === 'rec_get').length).toBeGreaterThan(2);

    // And far more keys than a request holds are asked in parts, each part within the limit.
    asked.mockClear();
    const absent = Array.from({ length: 2500 }, (_, i) =>
      recordKey.profile(`${'b'.repeat(24)}${String(i).padStart(4, '0')}`),
    );
    expect(await reader.dist.get(absent)).toEqual([]);
    const sizes = asked.mock.calls
      .filter((c) => c[1] === 'rec_get')
      .map((c) => (c[2] as { keys: string[] }).keys.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2500);
  }, 120_000);
});

describe('records from other servers', () => {
  it('ignores a forged account deletion pushed by another server', async () => {
    const [x] = await network(2);
    const victim = await user(x!, 'victim');
    const victimId = victim.identity.userId;
    // A malicious server pushes "deleted" for someone else's account, signed
    // with its own key (it can't sign as the victim).
    const mallory = createIdentity();
    const forged = signRecord(mallory, 'profile', recordKey.profile(victimId), {
      username: DELETED_PROFILE_NAME,
      encKey: mallory.encPublicKey,
      deleted: true,
    });
    await x!.dist.onPush(forged);
    await new Promise((r) => setTimeout(r, 500));
    expect(x!.presence.localOf(victimId).length).toBe(1);
    expect(
      (x!.dist.lookup(recordKey.profile(victimId))?.body as { deleted?: boolean })?.deleted,
    ).not.toBe(true);
  });

  it("doesn't let an owner's forged invite admit someone to a space", async () => {
    const servers = await network(4);
    const alice = await user(servers[0]!, 'alice');
    const { spaceId } = await createSpace(alice);
    const mallory = createIdentity();
    const code = 'malloryinvite';
    // A malicious owner of the invite's shard answers with an invite to
    // Alice's space that Mallory signed herself.
    const forgedInvite = signRecord(mallory, 'invite', recordKey.invite(code), {
      spaceId,
      code,
      expiresAt: null,
    });
    const via = servers.find((c) => !c.dist.ownsShard(`invite:${code}`))!;
    for (const c of servers) {
      const gather = c.mesh.gather.bind(c.mesh);
      c.mesh.gather = (async (ids: string[], m: string, p: { keys?: string[] }) =>
        m === 'rec_get' && p?.keys?.includes(recordKey.invite(code))
          ? [{ records: [forgedInvite] }]
          : gather(ids as never, m as never, p as never)) as typeof c.mesh.gather;
      const requestAny = c.mesh.requestAny.bind(c.mesh);
      c.mesh.requestAny = (async (ids: string[], m: string, p: { keys?: string[] }) =>
        m === 'rec_get' && p?.keys?.includes(recordKey.invite(code))
          ? { records: [forgedInvite] }
          : requestAny(ids as never, m as never, p as never)) as typeof c.mesh.requestAny;
    }
    const m = await user(via, 'mallory');
    const res = await m.conn.request('records.put', {
      record: signRecord(m.identity, 'member', recordKey.member(spaceId, m.identity.userId), {
        spaceId,
        userId: m.identity.userId,
        inviteCode: code,
      }),
    });
    expect(res.accepted).toBe(false);
    expect(via.dist.lookup(recordKey.invite(code))).toBeUndefined();
  });
});

describe('frames from other servers', () => {
  it('passes on only the events servers route, and session states only from their owner', async () => {
    const [x, y] = await network(2);
    const victim = await user(x!, 'victim');
    // A session y doesn't own, so y's session state for it is forged.
    let sid = sessionIds.dm(victim.identity.userId, createIdentity().userId);
    while (x!.sessions.ownerOf(sid) !== x!.info.id)
      sid = sessionIds.dm(victim.identity.userId, createIdentity().userId);
    // "replaced" would stop the victim's app from reconnecting.
    y!.mesh.sendTo(x!.info.id, {
      t: 'route',
      to: victim.conn.peer,
      ev: 'replaced',
      d: { reason: 'evil' },
    } as never);
    // A session state from a server that doesn't own the session.
    y!.mesh.sendTo(x!.info.id, {
      t: 'route',
      to: victim.conn.peer,
      ev: 'session',
      d: { state: { id: sid, epoch: 99, host: 'mallory.dev', backup: null, members: [] } },
    } as never);
    // Malformed: dropped without disturbing the link.
    y!.mesh.sendTo(x!.info.id, { t: 'records', items: 'nonsense', upTo: 'x' } as never);
    await new Promise((r) => setTimeout(r, 800));
    expect(victim.events.map((e) => e.ev)).not.toContain('replaced');
    expect(victim.events.map((e) => e.ev)).not.toContain('session');
    expect(x!.mesh.peerIds()).toContain(y!.info.id);
    // Events servers do route still arrive, from a server the user is also connected to.
    const other = await connectUser(y!, victim.identity, 'victim');
    cleanup.push(() => other.conn.close());
    await waitFor(() => x!.presence.hosts(y!.info.id, victim.identity.userId), 3000, 'presence');
    y!.mesh.sendTo(x!.info.id, {
      t: 'route',
      to: victim.identity.userId,
      ev: 'relay_expired',
      d: { reason: 'grant ended' },
    } as never);
    await waitFor(() => victim.events.some((e) => e.ev === 'relay_expired'), 3000, 'routed');
  });
  it('pages a list through a server that does not hold it, however long it is', async () => {
    const servers = await network(3);
    const bob = createIdentity();
    const reader = await user(servers[0]!);
    // Notes large enough that a handful fill a frame, written by one-time keys.
    const from = createIdentity();
    const prekey = createPrekey().bundle;
    const notes: SignedRecord[] = [];
    for (let i = 0; i < 10; i++) {
      const author = createIdentity();
      const boxes = Array.from({ length: 8 }, () =>
        sealAnonymous(
          from,
          randomDeviceId(),
          { peer: peerIds.make(bob.userId, randomDeviceId()), prekey },
          utf8.encode('x'.repeat(4000)),
        ),
      );
      const note = signRecord(author, 'note', recordKey.note(bob.userId, author.userId), { boxes });
      await put(reader, note);
      notes.push(note);
    }
    const placed = owners(servers, notes[0]!);
    const away = servers.find((c) => !placed.includes(c.info.id))!;
    const owner = await connectUser(away, bob, 'bob');
    cleanup.push(() => owner.conn.close());
    await waitFor(
      async () =>
        (await owner.conn.request('records.list', { prefix: `note:${bob.userId}:` })).records
          .length > 0,
      5000,
      'notes reach the owners',
    );
    // Page by page through the server holding none of them.
    const seen: string[] = [];
    let after: string | undefined;
    for (let rounds = 0; rounds < 30; rounds++) {
      const res = await owner.conn.request('records.list', {
        prefix: `note:${bob.userId}:`,
        ...(after ? { after } : {}),
      });
      expect(Buffer.byteLength(JSON.stringify(res.records))).toBeLessThan(1024 * 1024);
      seen.push(...res.records.map((r) => r.key));
      after = res.records.at(-1)?.key;
      if (!res.more) break;
    }
    expect(seen).toEqual([...seen].sort());
    expect(seen.sort()).toEqual(notes.map((n) => n.key).sort());
  }, 60_000);
  it("asks each server once however many shards a client's lookup spans", async () => {
    const servers = await network(3);
    const owners = await Promise.all(servers.map((c) => user(c)));
    const more = await Promise.all(Array.from({ length: 12 }, (_, i) => user(servers[i % 3]!)));
    const everyone = [...owners, ...more];
    const reader = await user(servers[0]!);
    const asked = vi.spyOn(servers[0]!.mesh, 'request');
    const keys = everyone.map((u) => recordKey.profile(u.identity.userId));
    const res = await reader.conn.request('records.get', { keys });
    expect(res.records.map((r) => r.key).sort()).toEqual(keys.sort());
    // Only the lookups for these keys: the servers ask each other about other things too.
    const lookupsFor = (wanted: string[]) =>
      asked.mock.calls.filter(
        (c) =>
          c[1] === 'rec_get' && (c[2] as { keys: string[] }).keys.some((k) => wanted.includes(k)),
      );
    const lookups = lookupsFor(keys);
    // One question to each of the other two servers, not one to every owner of every user.
    expect(lookups.length).toBeLessThanOrEqual(2);
    expect(lookups.length).toBeGreaterThan(0);

    // Following the voice in many spaces is a single round of questions too.
    const alice = await user(servers[1]!, 'alice');
    const spaces = [];
    for (let i = 0; i < 8; i++) spaces.push((await createSpace(alice, `S${i}`)).spaceId);
    const aliceAtZero = await connectUser(servers[0]!, alice.identity, 'alice');
    cleanup.push(() => aliceAtZero.conn.close());
    asked.mockClear();
    await aliceAtZero.conn.request('voice.watch', { spaceIds: spaces });
    expect(
      lookupsFor(
        spaces.flatMap((id) => [recordKey.space(id), recordKey.member(id, alice.identity.userId)]),
      ).length,
    ).toBeLessThanOrEqual(2);
  }, 60_000);
});
