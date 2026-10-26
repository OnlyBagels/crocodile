import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createChannelKeys,
  createIdentity,
  keyMatchesUserId,
  sign,
  verifyPayload,
} from '@crocodile/crypto';
import {
  PROTOCOL_VERSION,
  SIG_DOMAIN,
  presenceSigned,
  voiceSigned,
  type FedPresence,
} from '@crocodile/protocol';
import { Coordinator, rendezvousOwner } from '@crocodile/coordinator';
import { connectUser, meshLinkTo, startCoordinator, waitFor } from './helpers';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(overrides = {}) {
  const c = await startCoordinator(overrides);
  cleanup.push(() => c.stop());
  return c;
}

/** `victim` is linked to an honest server and to a rogue one. */
async function threeServers() {
  const victim = await server({ name: 'victim' });
  const honest = await server({ name: 'honest', meshPeers: [victim.url] });
  const rogue = await server({ name: 'rogue', meshPeers: [victim.url] });
  await waitFor(
    () =>
      victim.mesh.peerIds().length === 2 &&
      rogue.mesh.peerIds().includes(victim.info.id) &&
      honest.mesh.peerIds().includes(victim.info.id),
    5000,
    'mesh links',
  );
  return { victim, honest, rogue };
}

const cursorOf = (c: Coordinator, serverId: string) =>
  Number(c.records.store.getMeta(`cursor:${serverId}`) ?? 0);

describe('a mesh link keeps the identity it authenticated with', () => {
  it('closes a link that sends a second hello and credits nothing to the identity in it', async () => {
    const { victim, honest, rogue } = await threeServers();
    const toVictim = meshLinkTo(rogue, victim.info.id);
    const offer = { x25519: 'a'.repeat(43), mlkem: 'b'.repeat(100) };

    toVictim.send({
      t: 'fed_hello',
      server: honest.info,
      challenge: 'c',
      channel: offer,
      protocol: 99,
    });
    // Would move the honest server's catch-up cursor if it were credited to it.
    toVictim.send({ t: 'records', items: [], upTo: 5_000_000 });

    await waitFor(
      () => !victim.mesh.peerIds().includes(rogue.info.id),
      3000,
      'the rogue link to be dropped',
    );
    expect(cursorOf(victim, honest.info.id)).toBe(0);
    // The honest server's own link is untouched.
    expect(victim.mesh.peerIds()).toContain(honest.info.id);
  });

  it('closes a link that introduces itself twice before it has authenticated', async () => {
    const victim = await server({ name: 'victim' });
    const honest = await server({ name: 'honest' });
    const ws = new WebSocket(victim.url.replace(/^http/, 'ws') + '/v1/federation');
    const received: string[] = [];
    ws.addEventListener('message', (e) => received.push(JSON.parse(String(e.data)).t));
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener('close', (e) => resolve(e.code)),
    );
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const hello = () =>
      JSON.stringify({
        t: 'fed_hello',
        server: honest.info,
        challenge: 'c',
        channel: createChannelKeys().offer,
        protocol: PROTOCOL_VERSION,
      });
    ws.send(hello());
    await waitFor(() => received.includes('fed_auth'), 3000, 'the answer to the first hello');
    ws.send(hello());
    expect(await closed).toBe(1008);
    expect(received.filter((t) => t === 'fed_auth')).toHaveLength(1);
  });
});

type Entry = FedPresence['entries'][number];
const entry = (userId: string, devices = ['d1']): Entry => ({
  userId,
  status: 'online',
  since: Date.now(),
  devices,
});

/** A presence frame as `from` itself would sign it. */
function presenceFrom(from: Coordinator, seq: number, entries: Entry[], full = false) {
  const parts = { origin: from.info.id, seq, full, entries };
  return {
    t: 'presence',
    ...parts,
    key: from.info.key,
    sig: sign(from.identity, SIG_DOMAIN.presence, presenceSigned(parts)),
  };
}

const base32 = (n: number) =>
  Array.from(randomBytes(n), (b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('');
const online = (c: Coordinator, userId: string) =>
  c.presence.publicEntry(userId).status === 'online';

describe('presence from other servers', () => {
  /** Alice is on the honest server; the victim has heard so. */
  async function withAlice() {
    const net = await threeServers();
    const alice = await connectUser(net.honest, createIdentity(), 'alice');
    cleanup.push(() => alice.conn.close());
    await waitFor(() => online(net.victim, alice.identity.userId), 3000, 'alice to be online');
    return {
      ...net,
      alice: alice.identity.userId,
      toVictim: meshLinkTo(net.rogue, net.victim.info.id),
    };
  }

  /** Frames on one link are handled in order: once this one has landed, so have the ones before it. */
  async function barrier(net: Awaited<ReturnType<typeof withAlice>>) {
    const marker = createIdentity().userId;
    net.toVictim.send(presenceFrom(net.rogue, Date.now(), [entry(marker)]));
    await waitFor(() => online(net.victim, marker), 3000, 'the marker to land');
  }

  it('does not let a server take over the users of another with a made-up frame', async () => {
    const net = await withAlice();
    for (const seq of [1e15, Date.now() + 60_000]) {
      net.toVictim.send({
        t: 'presence',
        origin: net.honest.info.id,
        seq,
        full: true,
        entries: [],
        key: net.honest.info.key,
        sig: 'x'.repeat(86),
      });
    }
    await barrier(net);
    expect(online(net.victim, net.alice)).toBe(true);
  });

  it('does not let a server claim a user under the name of another', async () => {
    const net = await withAlice();
    const target = createIdentity().userId;
    const parts = {
      origin: net.honest.info.id,
      seq: Date.now(),
      full: false,
      entries: [entry(target)],
    };
    // Signed by nobody, and signed by the rogue server but under the honest one's id.
    net.toVictim.send({ t: 'presence', ...parts, key: net.honest.info.key, sig: 'x'.repeat(86) });
    net.toVictim.send({
      t: 'presence',
      ...parts,
      key: net.rogue.info.key,
      sig: sign(net.rogue.identity, SIG_DOMAIN.presence, presenceSigned(parts)),
    });
    await barrier(net);
    expect(net.victim.presence.remoteServersOf(target)).toEqual([]);
  });

  it('takes a server at its word about its own users, but not a sequence number from the far future', async () => {
    const net = await withAlice();
    const fine = createIdentity().userId;
    const poisoned = createIdentity().userId;
    net.toVictim.send(presenceFrom(net.rogue, 1e15, [entry(poisoned)]));
    net.toVictim.send(presenceFrom(net.rogue, Date.now(), [entry(fine)]));
    await waitFor(() => online(net.victim, fine), 3000, 'its own user to land');
    expect(online(net.victim, poisoned)).toBe(false);
  });

  it('does not bring back a user who has gone when it catches a new neighbour up', async () => {
    const honest = await server({ name: 'honest' });
    const alice = await connectUser(honest, createIdentity(), 'alice');
    const bob = await connectUser(honest, createIdentity(), 'bob');
    cleanup.push(() => alice.conn.close());
    const [a, b] = [alice.identity.userId, bob.identity.userId];
    const victim = await server({ name: 'victim', meshPeers: [honest.url] });
    await waitFor(() => online(victim, a) && online(victim, b), 3000, 'both to be online');
    bob.conn.close();
    await waitFor(() => !online(victim, b), 3000, 'bob to go');

    // What the victim would tell a server that has just linked to it.
    const late = await server({ name: 'late' });
    for (const f of victim.presence.snapshot()) {
      expect(keyMatchesUserId(f.key, f.origin)).toBe(true);
      expect(verifyPayload(f.key, SIG_DOMAIN.presence, presenceSigned(f), f.sig)).toBe(true);
      late.presence.applyRemote(f);
    }
    expect(online(late, b)).toBe(false);

    // And a server that links to it for real ends up with the current picture.
    const linked = await server({ name: 'linked', meshPeers: [victim.url] });
    await waitFor(() => online(linked, a), 5000, 'alice to be seen');
    expect(online(linked, b)).toBe(false);
  });
});

describe('voice occupancy from other servers', () => {
  /** A voice session the victim sees `rogue` as the owner of, or not. */
  function sessionOwnedBy(net: Awaited<ReturnType<typeof threeServers>>, byRogue: boolean) {
    for (;;) {
      const spaceId = base32(16);
      const channelId = base32(16);
      const sessionId = `voice:${spaceId}:${channelId}`;
      const owner = rendezvousOwner(sessionId, net.victim.membership.liveIds());
      if ((owner === net.rogue.info.id) === byRogue)
        return { spaceId, channelId, sessionId, owner };
    }
  }

  function voiceFrom(
    from: Coordinator,
    s: { spaceId: string; channelId: string; sessionId: string },
    at: number,
  ) {
    const user = createIdentity().userId;
    const parts = {
      sessionId: s.sessionId,
      occ: { spaceId: s.spaceId, channelId: s.channelId, members: [user], host: user },
      owner: from.info.id,
      at,
    };
    return {
      t: 'voice',
      ...parts,
      key: from.info.key,
      sig: sign(from.identity, SIG_DOMAIN.voice, voiceSigned(parts)),
    };
  }

  it('shows an occupied room only when its owner said so, recently, in a frame it signed', async () => {
    const net = await threeServers();
    const toVictim = meshLinkTo(net.rogue, net.victim.info.id);
    const mine = sessionOwnedBy(net, true);
    const notMine = sessionOwnedBy(net, false);
    const stale = sessionOwnedBy(net, true);
    const forged = sessionOwnedBy(net, false);
    const shown = (s: { spaceId: string }) => net.victim.sessions.voiceSnapshot([s.spaceId]).length;

    // Made up in the name of the real owner, with nothing signed.
    const f = voiceFrom(net.rogue, forged, Date.now());
    toVictim.send({ ...f, owner: forged.owner, key: net.honest.info.key, sig: 'x'.repeat(86) });
    // Signed by the rogue server for a room that is not its to announce.
    toVictim.send(voiceFrom(net.rogue, notMine, Date.now()));
    // Signed, its room, but announced twenty minutes ago.
    toVictim.send(voiceFrom(net.rogue, stale, Date.now() - 20 * 60_000));
    toVictim.send(voiceFrom(net.rogue, mine, Date.now()));
    await waitFor(() => shown(mine), 3000, 'its own room to land');
    expect(shown(forged)).toBe(0);
    expect(shown(notMine)).toBe(0);
    expect(shown(stale)).toBe(0);
  });
});
