import { afterEach, describe, expect, it } from 'vitest';
import {
  SecureChannel,
  answerChannel,
  createIdentity,
  createLinkKem,
  createPrekey,
  isSpaceMember,
  linkNonce,
  randomDeviceId,
  randomId,
  sealAnonymous,
  sealForSelf,
  sealLink,
  sealToDevice,
  sign,
  signRecord,
  spaceIdFor,
  userTag,
} from '@crocodile/crypto';
import {
  DELETED_PROFILE_NAME,
  NOTE_TTL_MS,
  SIG_DOMAIN,
  peerIds,
  recordKey,
  sessionIds,
  utf8,
  type PrekeyBundle,
  type ProfileBody,
  type SignedRecord,
} from '@crocodile/protocol';
import { CoordinatorConnection } from '@crocodile/client-core';
import { Coordinator, lanAddress, rendezvousOwner } from '@crocodile/coordinator';
import {
  caps,
  connectUser,
  createSpace,
  expectAccepted,
  joinSpace,
  lastSession,
  startCoordinator,
  waitFor,
  type TestUser,
} from './helpers';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(overrides = {}) {
  const c = await startCoordinator(overrides);
  cleanup.push(() => c.stop());
  return c;
}

async function user(c: Coordinator, name?: string) {
  const u = await connectUser(c, createIdentity(), name);
  cleanup.push(() => u.conn.close());
  return u;
}

describe('records', () => {
  it('stores profiles, finds users by name#tag and rejects forgeries', async () => {
    const c = await server();
    const alice = await user(c, 'Alice');
    const bob = await user(c, 'bob');
    const tag = userTag(alice.identity.userId);
    const found = await bob.conn.request('users.search', { query: `alice#${tag}` });
    expect(found.profiles.map((p) => p.key)).toEqual([recordKey.profile(alice.identity.userId)]);

    const forged = signRecord(bob.identity, 'profile', recordKey.profile(alice.identity.userId), {
      username: 'alice',
      encKey: bob.identity.encPublicKey,
    });
    const res = await bob.conn.request('records.put', { record: forged });
    expect(res.accepted).toBe(false);
  });

  it('delivers friend requests in real time', async () => {
    const c = await server();
    const alice = await user(c);
    const bob = await user(c);
    const req = signRecord(alice.identity, 'friends', recordKey.friends(alice.identity.userId), {
      friends: [bob.identity.userId],
      blocked: [],
    });
    expect((await alice.conn.request('records.put', { record: req })).accepted).toBe(true);
    await waitFor(() => bob.events.find((e) => e.ev === 'record'), 2000, 'friend request event');
    const incoming = await bob.conn.request('friends.incoming', {});
    expect(incoming.records.map((r) => r.key)).toEqual([recordKey.friends(alice.identity.userId)]);
  });

  it('lets invited users join spaces', async () => {
    const c = await server();
    const alice = await user(c);
    const bob = await user(c);
    const { spaceId, code } = await createSpace(alice);
    await joinSpace(bob, spaceId, code);
    const mine = await bob.conn.request('spaces.mine', {});
    expect(mine.spaces.map((s) => s.key)).toEqual([recordKey.space(spaceId)]);
    const members = await alice.conn.request('records.list', {
      prefix: recordKey.memberPrefix(spaceId),
    });
    expect(members.records).toHaveLength(2);
  });
});

describe('server hello', () => {
  /** A WebSocket that lets someone on the path rewrite the server's hello. */
  function tampered(change: (hello: Record<string, unknown>) => Record<string, unknown>) {
    return class extends WebSocket {
      private handler: ((ev: MessageEvent) => void) | null = null;
      override get onmessage() {
        return this.handler;
      }
      override set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        this.handler = fn;
        super.onmessage = (ev: MessageEvent) => {
          let data = ev.data as string;
          const frame = JSON.parse(String(data)) as Record<string, unknown>;
          if (frame.t === 'hello') data = JSON.stringify(change(frame));
          fn?.({ data } as MessageEvent);
        };
      }
    };
  }
  const connect = (c: Coordinator, impl?: typeof WebSocket) =>
    CoordinatorConnection.connect({
      url: c.url,
      identity: createIdentity(),
      deviceId: randomDeviceId(),
      platform: 'bot',
      version: 'test',
      ...(impl ? { WebSocketImpl: impl } : {}),
    });

  it('the STUN servers and operator come signed, and a changed list is not used', async () => {
    const c = await server({
      extraStun: ['stun:stun.example.org:3478'],
      operatorContact: 'ops@example.org',
    });
    const plain = await connect(c);
    expect(plain.stun).toContain('stun:stun.example.org:3478');
    expect(plain.operator).toEqual({ contact: 'ops@example.org' });
    plain.close();

    // Someone on the path points the app at their own STUN server.
    const evil = tampered((h) => ({ ...h, stun: ['stun:watching.example:3478'] }));
    const changed = await connect(c, evil);
    expect(changed.stun).toEqual([]);
    expect(changed.operator).toBeUndefined();
    changed.close();
    // A server from before the full signature: its unsigned list isn't used.
    const old = tampered(({ sigFull: _, ...h }) => ({
      ...h,
      stun: ['stun:watching.example:3478'],
    }));
    const conn = await connect(c, old);
    expect(conn.stun).toEqual([]);
    expect(conn.operator).toBeUndefined();
    conn.close();
  });
});

describe('client sign-in', () => {
  /** A WebSocket that keeps what the client sends. */
  function recording(sent: string[]) {
    return class extends WebSocket {
      override send(data: string) {
        sent.push(data);
        super.send(data);
      }
    };
  }

  it("keeps who the client is out of what travels in the clear, so that a plain ws:// connection doesn't show it", async () => {
    const c = await server();
    const identity = createIdentity();
    const deviceId = randomDeviceId();
    const sent: string[] = [];
    const conn = await CoordinatorConnection.connect({
      url: c.url,
      identity,
      deviceId,
      platform: 'bot',
      version: 'test-version-1',
      WebSocketImpl: recording(sent),
    });
    expect(conn.userId).toBe(identity.userId);
    const seen = sent.join('\n');
    expect(sent.length).toBeGreaterThan(0);
    for (const secret of [
      identity.publicKey,
      identity.userId,
      deviceId,
      'test-version-1',
      'platform',
    ])
      expect(seen).not.toContain(secret);
    expect(Object.keys(JSON.parse(sent[0]!))).toEqual(['t', 'channel', 'sealed']);
    conn.close();
  });

  /**
   * Reads the hello off a raw connection and says what the server does with the frame(s) `answer`
   * gives back.
   */
  async function answerWith(
    c: Coordinator,
    answer: (hello: {
      challenge: string;
      server: { id: string };
      channel: { x25519: string; mlkem: string };
    }) => unknown,
  ) {
    const ws = new WebSocket(c.url.replace(/^http/, 'ws') + '/v1/client');
    return new Promise<{ code: number; got: unknown[] }>((resolve, reject) => {
      const got: unknown[] = [];
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('the server did not close the connection'));
      }, 5000);
      ws.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data));
        got.push(frame);
        if (frame.t === 'hello') {
          const reply = answer(frame);
          for (const f of Array.isArray(reply) ? reply : [reply]) ws.send(JSON.stringify(f));
        }
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        resolve({ code: ev.code, got });
      };
    });
  }

  it('refuses the older form, with the key and device in the clear', async () => {
    const c = await server();
    const identity = createIdentity();
    const result = await answerWith(c, (hello) => {
      const res = answerChannel(hello.channel);
      return {
        t: 'auth',
        key: identity.publicKey,
        device: randomDeviceId(),
        channel: res.answer,
        sig: sign(identity, SIG_DOMAIN.auth, {
          challenge: hello.challenge,
          server: hello.server.id,
          device: 'aaaaaaaa',
          channel: res.answer,
        }),
        client: { platform: 'bot', version: 'old' },
      };
    });
    expect(result.code).toBe(4002);
    expect(result.got.some((f) => (f as { t: string }).t === 'auth_ok')).toBe(false);
  });

  it('closes a sign-in that does not open, that opens to the wrong thing, or whose key exchange is garbage', async () => {
    const c = await server();
    const sealedWith = (
      hello: {
        challenge: string;
        server: { id: string };
        channel: { x25519: string; mlkem: string };
      },
      body: unknown,
    ) => {
      const res = answerChannel(hello.channel);
      const auth = new SecureChannel(
        res.secret,
        `${hello.challenge}|${hello.server.id}|auth`,
        true,
      );
      const { n, c: ct } = auth.seal(body);
      return { t: 'auth', channel: res.answer, sealed: { n, c: ct } };
    };
    // Sealed under a different key exchange than the one it names.
    const unopened = await answerWith(c, (hello) => {
      const other = answerChannel(hello.channel);
      return { ...sealedWith(hello, { key: 'x' }), channel: other.answer };
    });
    expect(unopened.code).toBe(4003);
    // Opens, but is not a sign-in.
    const wrong = await answerWith(c, (hello) => sealedWith(hello, { hello: 'world' }));
    expect(wrong.code).toBe(4002);
    // A key exchange that is not one.
    const garbage = await answerWith(c, () => ({
      t: 'auth',
      channel: { epk: 'AAAA', kem: 'AAAA' },
      sealed: { n: 0, c: 'AAAA' },
    }));
    expect(garbage.code).toBe(4003);
  });

  it('tells a deleted account so only in a sealed frame', async () => {
    const c = await server();
    const user = await connectUser(c, createIdentity(), 'gone');
    const me = user.identity.userId;
    await user.conn.request('records.put', {
      record: signRecord(user.identity, 'profile', recordKey.profile(me), {
        username: DELETED_PROFILE_NAME,
        encKey: user.identity.encPublicKey,
        deleted: true,
      }),
    });
    await waitFor(() => !!c.deletionMarker(me), 3000, 'marker');
    const received: string[] = [];
    class Listening extends WebSocket {
      private handler: ((ev: MessageEvent) => void) | null = null;
      override get onmessage() {
        return this.handler;
      }
      override set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        this.handler = fn;
        super.onmessage = (ev: MessageEvent) => {
          received.push(String(ev.data));
          fn?.(ev);
        };
      }
    }
    await expect(
      CoordinatorConnection.connect({
        url: c.url,
        identity: user.identity,
        deviceId: randomDeviceId(),
        platform: 'bot',
        version: 'test',
        WebSocketImpl: Listening,
      }),
    ).rejects.toThrow(/deleted/);
    const kinds = received.map((f) => (JSON.parse(f) as { t: string }).t);
    expect(kinds).toEqual(['hello', 'x']);
    expect(received.join('')).not.toContain('account_deleted');
  });

  it('refuses a sealed sign-in whose signature is not for this connection', async () => {
    const c = await server();
    const identity = createIdentity();
    const result = await answerWith(c, (hello) => {
      const res = answerChannel(hello.channel);
      const device = randomDeviceId();
      const auth = new SecureChannel(
        res.secret,
        `${hello.challenge}|${hello.server.id}|auth`,
        true,
      );
      // Signed for another challenge: as if recorded from an earlier connection.
      const { n, c: ct } = auth.seal({
        key: identity.publicKey,
        device,
        sig: sign(identity, SIG_DOMAIN.auth, {
          challenge: 'not-this-one',
          server: hello.server.id,
          device,
          channel: res.answer,
        }),
        client: { platform: 'bot', version: 'test' },
      });
      return { t: 'auth', channel: res.answer, sealed: { n, c: ct } };
    });
    expect(result.code).toBe(4003);
    // Nothing but the hello was said in the clear: no error to tell it apart from a success.
    expect(result.got.map((f) => (f as { t: string }).t)).toEqual(['hello']);
  });
});

describe('STUN and TURN addresses', () => {
  it('without a public URL, apps get the address they reached the server on', async () => {
    const c = await server({ stunPort: 0 });
    expect(new URL(c.url).hostname).toBe('127.0.0.1');
    // An app on the LAN reached us at 192.168.1.20: 127.0.0.1 would be its own machine.
    expect(c.publicHost('192.168.1.20')).toBe('192.168.1.20');
    expect(c.publicHost('::ffff:192.168.1.20')).toBe('192.168.1.20');
    expect(c.publicHost('fd00::20')).toBe('[fd00::20]');
    expect(c.stunUrls('192.168.1.20')[0]).toMatch(/^stun:192\.168\.1\.20:\d+$/);
    // A local app keeps the loopback address.
    expect(c.publicHost('127.0.0.1')).toBe('127.0.0.1');

    // With a public URL, that is what everyone gets.
    const named = await server({ publicUrl: 'https://croc.example.org' });
    expect(named.publicHost('192.168.1.20')).toBe('croc.example.org');
  });

  it("a relay with no public address uses the machine's network address", () => {
    expect(
      lanAddress({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
        eth0: [
          { address: 'fe80::1', family: 'IPv6', internal: false } as never,
          { address: '192.168.1.20', family: 'IPv4', internal: false } as never,
        ],
      }),
    ).toBe('192.168.1.20');
    expect(
      lanAddress({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never] }),
    ).toBeUndefined();
  });
});

describe('request limits', () => {
  it('refuses a list limit below one, which would list everything', async () => {
    const c = await server();
    const alice = await user(c);
    await expect(
      alice.conn.request('records.list', { prefix: 'profile:', limit: -1 }),
    ).rejects.toThrow();
  });

  it('caps the prefixes and users one connection follows', async () => {
    const c = await server();
    const alice = await user(c);
    const b32 = 'abcdefghijklmnopqrstuvwxyz234567';
    const id = (n: number) =>
      Array.from({ length: 10 }, (_, i) => b32[Math.floor(n / 32 ** i) % 32]).join('');
    const prefixes = (i: number) =>
      Array.from({ length: 2000 }, (_, j) => recordKey.profile(id(i * 2000 + j)));
    for (let i = 0; i < 10; i++)
      await alice.conn.request('records.subscribe', { prefixes: prefixes(i) });
    await expect(
      alice.conn.request('records.subscribe', { prefixes: prefixes(10) }),
    ).rejects.toThrow(/at most/);
    // Following again what it already follows is fine.
    await alice.conn.request('records.subscribe', { prefixes: prefixes(0) });

    const users = (i: number) => Array.from({ length: 5000 }, (_, j) => id(i * 5000 + j));
    for (let i = 0; i < 4; i++)
      await alice.conn.request('presence.subscribe', { userIds: users(i) });
    await expect(alice.conn.request('presence.subscribe', { userIds: users(4) })).rejects.toThrow(
      /at most/,
    );
  });
});

describe('writes sent twice', () => {
  it('counts the same record sent again as stored, and still refuses a different one', async () => {
    const c = await server();
    const alice = await user(c);
    const key = recordKey.profile(alice.identity.userId);
    const version = Date.now();
    const profile = signRecord(
      alice.identity,
      'profile',
      key,
      { username: 'alice', encKey: alice.identity.encPublicKey },
      version,
    );
    expectAccepted(await alice.conn.request('records.put', { record: profile }));
    // A retry after a lost answer, or a copy that got there first by another path.
    expectAccepted(await alice.conn.request('records.put', { record: profile }));
    const other = signRecord(
      alice.identity,
      'profile',
      key,
      { username: 'mallory', encKey: alice.identity.encPublicKey },
      version,
    );
    expect(await alice.conn.request('records.put', { record: other })).toMatchObject({
      accepted: false,
      reason: 'stale version',
    });
  });
});

describe('sessions and host election', () => {
  async function setup() {
    const c = await server();
    const alice = await user(c);
    const bob = await user(c);
    const carol = await user(c);
    const s = await createSpace(alice);
    await joinSpace(bob, s.spaceId, s.code);
    await joinSpace(carol, s.spaceId, s.code);
    return { c, alice, bob, carol, ...s, sessionId: sessionIds.voice(s.spaceId, s.voiceChannel) };
  }

  it('elects the best-connected member as host and a runner-up as backup', async () => {
    const { alice, bob, carol, sessionId } = await setup();
    await bob.conn.request('session.join', { sessionId, caps: caps({ nat: 'cone' }) });
    const { state } = await alice.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    // Bob was first and healthy, so he stays host: no flapping when a better peer joins.
    expect(state.host).toBe(bob.conn.peer);
    expect(state.backup).toBe(alice.conn.peer);
    await carol.conn.request('session.join', {
      sessionId,
      caps: caps({ platform: 'web', canHost: false }),
    });
    const seen = await waitFor(() => {
      const st = lastSession(bob, sessionId);
      return st && st.members.length === 3 ? st : null;
    });
    expect(seen.host).toBe(bob.conn.peer);
    expect(seen.backup).toBe(alice.conn.peer);
  });

  it('moves the host away from a symmetric NAT when someone others can reach joins', async () => {
    const { alice, bob, sessionId } = await setup();
    // Bob calls first from a strict network and is elected while alone.
    const first = await bob.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'symmetric' }),
    });
    expect(first.state.host).toBe(bob.conn.peer);
    const { state } = await alice.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    expect(state.host).toBe(alice.conn.peer);
    expect(state.backup).toBe(bob.conn.peer);
    expect(state.epoch).toBe(first.state.epoch + 1);
  });

  it('fails over to the backup when the host disconnects', async () => {
    const { alice, bob, carol, sessionId } = await setup();
    const first = await alice.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    await carol.conn.request('session.join', { sessionId, caps: caps({ nat: 'symmetric' }) });
    expect(first.state.host).toBe(alice.conn.peer);
    alice.conn.close();
    const st = await waitFor(
      () => {
        const s = lastSession(carol, sessionId);
        return s && s.host === bob.conn.peer ? s : null;
      },
      3000,
      'failover',
    );
    expect(st.epoch).toBe(first.state.epoch + 1);
    expect(st.backup).toBe(carol.conn.peer);
  });

  it('fails over when members report the host unreachable', async () => {
    const { alice, bob, carol, sessionId } = await setup();
    const { state } = await alice.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    await carol.conn.request('session.join', { sessionId, caps: caps() });
    await bob.conn.request('session.report', {
      sessionId,
      epoch: state.epoch,
      issue: 'host_unreachable',
    });
    const st = await waitFor(
      () => {
        const s = lastSession(carol, sessionId);
        return s && s.host !== alice.conn.peer ? s : null;
      },
      3000,
      'report failover',
    );
    expect(st.host).toBe(bob.conn.peer);
    expect(st.members).toHaveLength(3);
  });

  it('keeps a reported host when nobody else can host, rather than leaving no host', async () => {
    const { alice, bob, sessionId } = await setup();
    const { state } = await alice.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    await bob.conn.request('session.join', {
      sessionId,
      caps: caps({ platform: 'web', canHost: false }),
    });
    await bob.conn.request('session.report', {
      sessionId,
      epoch: state.epoch,
      issue: 'host_unreachable',
    });
    await new Promise((r) => setTimeout(r, 200));
    // Bob may still get through another way (the relay), but only with a host.
    expect(lastSession(bob, sessionId)!.host).toBe(alice.conn.peer);
  });

  it('routes signalling only between session members and rejects outsiders', async () => {
    const { c, alice, bob, sessionId } = await setup();
    const outsider = await user(c);
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    const data = { type: 'bye' as const, epoch: 1, dir: 'toRelay' as const };
    const r = await bob.conn.request('signal.send', { to: alice.conn.peer, sessionId, data });
    expect(r.delivered).toBe(true);
    await waitFor(() => alice.events.find((e) => e.ev === 'signal'));
    await expect(
      outsider.conn.request('session.join', { sessionId, caps: caps() }),
    ).rejects.toThrow(/not a member/);
    await expect(
      outsider.conn.request('signal.send', { to: alice.conn.peer, sessionId, data }),
    ).rejects.toThrow(/join the session/);
  });

  it('publishes voice channel occupancy to watchers', async () => {
    const { alice, bob, spaceId, voiceChannel, sessionId } = await setup();
    const snap = await bob.conn.request('voice.watch', { spaceIds: [spaceId] });
    expect(snap.voice).toEqual([]);
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    const ev = await waitFor(() => bob.events.find((e) => e.ev === 'voice'));
    expect(ev.d).toMatchObject({
      spaceId,
      channelId: voiceChannel,
      members: [alice.identity.userId],
    });
  });
});

describe('coordination mesh', () => {
  async function mesh() {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(
      () => a.mesh.peerIds().length === 1 && b.mesh.peerIds().length === 1,
      5000,
      'mesh link',
    );
    return { a, b };
  }

  it('replicates records and presence across servers', async () => {
    const { a, b } = await mesh();
    const alice = await user(a, 'alice');
    const bob = await user(b, 'bob');
    await waitFor(
      () => b.records.get(recordKey.profile(alice.identity.userId)),
      3000,
      'replication',
    );
    const found = await bob.conn.request('users.search', { query: 'alice' });
    expect(found.profiles).toHaveLength(1);
    const { presence } = await bob.conn.request('presence.subscribe', {
      userIds: [alice.identity.userId],
    });
    expect(presence[0]?.status).toBe('online');
    alice.conn.close();
    await waitFor(
      () =>
        bob.events.find(
          (e) => e.ev === 'presence' && (e.d as { status: string }).status === 'offline',
        ),
      3000,
      'offline',
    );
  });

  it('catches up on records written while a server was offline', async () => {
    const a = await server({ name: 'A' });
    const alice = await user(a, 'alice');
    const s = await createSpace(alice);
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => b.records.get(`invite:${s.code}`), 3000, 'backlog sync');
    expect(isSpaceMember(b.records, s.spaceId, alice.identity.userId)).toBe(true);
  });

  it('runs sessions across servers and keeps the host when the owner server dies', async () => {
    const { a, b } = await mesh();
    const alice = await user(a);
    const bob = await user(b);
    const s = await createSpace(alice);
    await waitFor(() => b.records.get(`invite:${s.code}`), 3000, 'invite replicated');
    await joinSpace(bob, s.spaceId, s.code);
    await waitFor(
      () => isSpaceMember(a.records, s.spaceId, bob.identity.userId),
      3000,
      'member replicated',
    );

    // Pick a session id owned by whichever server we will keep alive, then kill the owner.
    const sessionId = `voice:${s.spaceId}:${s.voiceChannel}`;
    const r1 = await alice.conn.request('session.join', { sessionId, caps: caps({ nat: 'open' }) });
    const r2 = await bob.conn.request('session.join', { sessionId, caps: caps() });
    expect(r2.state.host).toBe(alice.conn.peer);
    expect(r2.state.id).toBe(r1.state.id);

    const sig = await bob.conn.request('signal.send', {
      to: alice.conn.peer,
      sessionId,
      data: { type: 'bye', epoch: 1, dir: 'toRelay' },
    });
    expect(sig.delivered).toBe(true);

    const owner = a.sessions.ownerOf(sessionId) === a.info.id ? a : b;
    const survivor = owner === a ? b : a;
    const survivingUser: TestUser = owner === a ? bob : alice;
    if (owner === b) {
      // Bob's server owns it; killing B disconnects Bob, so Alice alone remains, still host.
      await b.stop();
      const st = await waitFor(
        () => {
          const x = survivor.sessions.ownedState(sessionId);
          return x && x.members.length === 1 ? x : null;
        },
        5000,
        'rebuild',
      );
      expect(st.host).toBe(alice.conn.peer);
      expect(st.epoch).toBe(r2.state.epoch);
    } else {
      // Alice's server owns it and Alice is host: killing A drops Alice, Bob takes over.
      await a.stop();
      const st = await waitFor(
        () => {
          const x = survivor.sessions.ownedState(sessionId);
          return x && x.host === bob.conn.peer ? x : null;
        },
        5000,
        'takeover',
      );
      expect(st.members.map((m) => m.peer)).toEqual([survivingUser.conn.peer]);
    }
  });

  it('keeps the host when only its coordination server dies and it reconnects elsewhere', async () => {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    const c = await server({ name: 'C', meshPeers: [a.url, b.url] });
    await waitFor(() => [a, b, c].every((x) => x.mesh.peerIds().length === 2), 5000, 'full mesh');

    const owner = await user(a);
    const s = await createSpace(owner);
    // Find a voice session owned by A (rendezvous hashing picks the owner).
    let sessionId = `voice:${s.spaceId}:${s.voiceChannel}`;
    const channels = [...s.space.body.channels];
    for (let i = 0; a.sessions.ownerOf(sessionId) !== a.info.id && i < 50; i++) {
      const id = randomId();
      channels.push({ id, name: `v${i}`, kind: 'voice' });
      sessionId = `voice:${s.spaceId}:${id}`;
    }
    await owner.conn.request('records.put', {
      record: signRecord(
        owner.identity,
        'space',
        `space:${s.spaceId}`,
        { ...s.space.body, channels },
        Date.now() + 1,
      ),
    });
    expect(a.sessions.ownerOf(sessionId)).toBe(a.info.id);

    const hostId = createIdentity();
    await waitFor(() => b.records.get(`invite:${s.code}`), 3000, 'replicated');
    const host = await connectUser(b, hostId, 'host', 'hostdevicex');
    cleanup.push(() => host.conn.close());
    await joinSpace(host, s.spaceId, s.code);
    await waitFor(() => isSpaceMember(a.records, s.spaceId, hostId.userId), 3000);
    const first = await host.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    await owner.conn.request('session.join', { sessionId, caps: caps({ nat: 'symmetric' }) });
    expect(first.state.host).toBe(host.conn.peer);

    // B dies; the host's app fails over to C and re-joins with the same identity.
    await b.stop();
    const again = await connectUser(c, hostId, 'host', 'hostdevicex');
    cleanup.push(() => again.conn.close());
    await waitFor(
      () => isSpaceMember(c.records, s.spaceId, hostId.userId),
      3000,
      'membership on C',
    );
    const rejoined = await again.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    expect(rejoined.state.host).toBe(host.conn.peer);
    expect(rejoined.state.epoch).toBe(first.state.epoch);
  });

  it("re-joins again when a session's new owner was briefly unreachable", async () => {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    const c = await server({ name: 'C', meshPeers: [a.url, b.url] });
    await waitFor(() => [a, b, c].every((x) => x.mesh.peerIds().length === 2), 5000, 'full mesh');

    const owner = await user(a);
    const s = await createSpace(owner);
    // A session owned by C that falls to A once C is gone.
    let sessionId = `voice:${s.spaceId}:${s.voiceChannel}`;
    const channels = [...s.space.body.channels];
    const fits = () =>
      a.sessions.ownerOf(sessionId) === c.info.id &&
      rendezvousOwner(sessionId, [a.info.id, b.info.id]) === a.info.id;
    for (let i = 0; !fits() && i < 100; i++) {
      const id = randomId();
      channels.push({ id, name: `v${i}`, kind: 'voice' });
      sessionId = `voice:${s.spaceId}:${id}`;
    }
    expect(fits()).toBe(true);
    await owner.conn.request('records.put', {
      record: signRecord(
        owner.identity,
        'space',
        `space:${s.spaceId}`,
        { ...s.space.body, channels },
        Date.now() + 1,
      ),
    });
    await waitFor(() => b.records.get(`invite:${s.code}`), 3000, 'replicated');
    const bob = await user(b);
    await joinSpace(bob, s.spaceId, s.code);
    await waitFor(() => isSpaceMember(c.records, s.spaceId, bob.identity.userId), 3000);
    await bob.conn.request('session.join', { sessionId, caps: caps() });

    // C dies; B's first re-join with A is lost on the way.
    let dropped = 0;
    const sendTo = b.mesh.sendTo.bind(b.mesh);
    b.mesh.sendTo = ((id: string, frame: { t: string }) => {
      if (frame.t === 'session_op' && id === a.info.id && dropped++ === 0) return false;
      return sendTo(id as never, frame as never);
    }) as typeof b.mesh.sendTo;
    await c.stop();
    const st = await waitFor(
      () => a.sessions.ownedState(sessionId),
      8000,
      'A rebuilt the session from the re-join',
    );
    expect(st.members.map((m) => m.peer)).toEqual([bob.conn.peer]);
    expect(dropped).toBeGreaterThan(1);
  });
});

describe('opt-in server relay', () => {
  it('issues time-limited grants to session members, capped per server', async () => {
    const c = await server({ relay: { enabled: true, maxUsers: 1 }, stunPort: 0 });
    const alice = await user(c);
    const bob = await user(c);
    const outsider = await user(c);
    const s = await createSpace(alice);
    await joinSpace(bob, s.spaceId, s.code);
    const sessionId = `space:${s.spaceId}`;
    await expect(alice.conn.request('relay.request', { sessionId })).rejects.toThrow(
      /join the session/,
    );
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    await bob.conn.request('session.join', { sessionId, caps: caps() });

    const { grant } = await alice.conn.request('relay.request', { sessionId });
    expect(grant.urls[0]).toMatch(/^turn:/);
    expect(grant.expiresAt - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    expect(grant.expiresAt - Date.now()).toBeGreaterThan(59 * 60_000);
    // Asking again does not extend the window.
    const again = await alice.conn.request('relay.request', { sessionId });
    expect(again.grant.expiresAt).toBe(grant.expiresAt);
    // Capacity: one user at a time on this server.
    await expect(bob.conn.request('relay.request', { sessionId })).rejects.toThrow(/capacity/);
    await expect(outsider.conn.request('relay.request', { sessionId })).rejects.toThrow();
    await alice.conn.request('relay.release', {});
    const forBob = await bob.conn.request('relay.request', { sessionId });
    expect(forBob.grant.username).toContain(bob.identity.userId);
  });

  it('ends grants after the window and tells the user', async () => {
    const c = await server({ stunPort: 0 });
    c.turn!.limits.maxGrantMs = 300;
    const alice = await user(c);
    const s = await createSpace(alice);
    const sessionId = `space:${s.spaceId}`;
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    await alice.conn.request('relay.request', { sessionId });
    await waitFor(() => alice.events.find((e) => e.ev === 'relay_expired'), 3000, 'expiry event');
    expect(c.relayStats().activeUsers).toBe(0);
  });

  it('extends a grant asked for again near its end, so a relayed call carries on', async () => {
    const c = await server({ stunPort: 0 });
    c.turn!.limits.maxGrantMs = 1500;
    const alice = await user(c);
    const s = await createSpace(alice);
    const sessionId = `space:${s.spaceId}`;
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    const first = (await alice.conn.request('relay.request', { sessionId })).grant;
    await new Promise((r) => setTimeout(r, 800));
    const renewed = (await alice.conn.request('relay.request', { sessionId })).grant;
    expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt);
    // The first window's end passes without the relay being taken away.
    await new Promise((r) => setTimeout(r, first.expiresAt - Date.now() + 300));
    expect(alice.events.some((e) => e.ev === 'relay_expired')).toBe(false);
    expect(c.relayStats().activeUsers).toBe(1);
    await waitFor(() => alice.events.find((e) => e.ev === 'relay_expired'), 3000, 'renewed end');
  });
});

describe('encrypted client channel', () => {
  it('refuses plaintext requests after authentication', async () => {
    const c = await server();
    const alice = await user(c);
    // Reach into the raw socket: a plaintext frame must kill the connection.
    const raw = (alice.conn as unknown as { ws: WebSocket }).ws;
    const closed = new Promise<number>((r) => raw.addEventListener('close', (e) => r(e.code)));
    raw.send(JSON.stringify({ t: 'req', id: 99, m: 'servers.list', p: {} }));
    expect(await closed).toBe(1008);
  });
});

describe('opt-in mailbox', () => {
  /** A user with a published device record (so others can mail it). */
  async function withDevice(c: Coordinator) {
    const u = await user(c);
    const prekey = createPrekey().bundle;
    const device = peerIds.device(u.conn.peer);
    const rec = signRecord(u.identity, 'device', recordKey.device(u.identity.userId, device), {
      userId: u.identity.userId,
      deviceId: device,
      name: 'test',
      platform: 'bot',
      prekey,
    });
    expect((await u.conn.request('records.put', { record: rec })).accepted).toBe(true);
    return { ...u, device, prekey };
  }
  const box = (from: TestUser, to: { conn: TestUser['conn']; prekey: PrekeyBundle }) =>
    sealToDevice(
      from.identity,
      peerIds.device(from.conn.peer),
      { peer: to.conn.peer, prekey: to.prekey },
      utf8.encode('{"type":"mail","messages":[]}'),
    );

  it('holds sealed items for a device until it fetches and acknowledges them', async () => {
    const c = await server();
    const alice = await withDevice(c);
    const bob = await withDevice(c);
    const res = await alice.conn.request('mail.put', {
      items: [{ to: bob.conn.peer, box: box(alice, bob) }],
    });
    expect(res.ids).toHaveLength(1);
    expect(res.expiresAt).toBeGreaterThan(Date.now());
    // Bob is online, so it is pushed right away and kept until acknowledged.
    await waitFor(() => bob.events.some((e) => e.ev === 'mail'), 3000, 'mail event');
    expect(c.store.mailCount({ toUser: bob.identity.userId })).toBe(1);
    await bob.conn.request('mail.fetch', {});
    await bob.conn.request('mail.ack', { ids: res.ids });
    expect(c.store.mailCount({})).toBe(0);
  });

  it('rejects boxes that claim another sender, and servers can turn it off', async () => {
    const c = await server();
    const alice = await withDevice(c);
    const bob = await withDevice(c);
    const mallory = await withDevice(c);
    await expect(
      mallory.conn.request('mail.put', { items: [{ to: bob.conn.peer, box: box(alice, bob) }] }),
    ).rejects.toThrow(/does not match/);

    const off = await server({ mailbox: { ...c.config.mailbox, enabled: false } });
    const a2 = await withDevice(off);
    const b2 = await withDevice(off);
    await expect(
      a2.conn.request('mail.put', { items: [{ to: b2.conn.peer, box: box(a2, b2) }] }),
    ).rejects.toThrow(/does not keep mail/);
  });

  it('forgets items after the time limit', async () => {
    const c = await server({
      mailbox: { enabled: true, ttlMs: 50, maxPerRecipient: 10, maxPerSender: 10, maxTotal: 100 },
    });
    const alice = await withDevice(c);
    const bob = await withDevice(c);
    await alice.conn.request('mail.put', { items: [{ to: bob.conn.peer, box: box(alice, bob) }] });
    await new Promise((r) => setTimeout(r, 80));
    expect(c.store.mailFor(bob.conn.peer, Date.now(), 10)).toHaveLength(0);
    expect(c.store.mailExpire(Date.now())).toBe(1);
  });
});

describe('abuse limits', () => {
  it('caps concurrent connections from one address', async () => {
    const c = await server({ maxConnectionsPerIp: 2 });
    await user(c);
    await user(c);
    await expect(user(c)).rejects.toThrow();
  });

  it('refuses new clients when the server is at capacity', async () => {
    const c = await server({ capacity: 1 });
    const first = await user(c);
    await expect(user(c)).rejects.toThrow();
    // The same device reconnecting still fits: it replaces its old connection.
    const again = await connectUser(c, first.identity, undefined, first.conn.peer.split('.')[1]);
    cleanup.push(() => again.conn.close());
    expect(c.presence.localCount).toBe(1);
  });

  it('never exceeds capacity when many clients log in at once', async () => {
    const c = await server({ capacity: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => connectUser(c, createIdentity())),
    );
    for (const r of results) if (r.status === 'fulfilled') cleanup.push(() => r.value.conn.close());
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(c.presence.localCount).toBe(2);
  });

  it('refuses to start with a limit that would switch a protection off', () => {
    for (const bad of [{ maxConnectionsPerIp: NaN }, { capacity: 0 }, { maxConnectionsPerIp: 1.5 }])
      expect(() => new Coordinator({ name: 'x', storage: 'memory', ...bad })).toThrow(
        /positive whole number/,
      );
  });
});

describe('record quotas', () => {
  const put = (u: TestUser, record: SignedRecord) => u.conn.request('records.put', { record });
  const space = (u: TestUser, name = 'Swamp') => {
    const nonce = randomId();
    const spaceId = spaceIdFor(u.identity.publicKey, nonce);
    const body = { name, owner: u.identity.userId, nonce, admins: [], bans: [], channels: [] };
    return {
      spaceId,
      body,
      record: signRecord(u.identity, 'space', recordKey.space(spaceId), body),
    };
  };

  it('limits how many spaces one account can create, but not updates to them', async () => {
    const c = await server({ quotas: { spacesPerUser: 2 } });
    const alice = await user(c);
    const first = space(alice);
    expectAccepted(await put(alice, first.record));
    expectAccepted(await put(alice, space(alice).record));
    const third = await put(alice, space(alice).record);
    expect(third.accepted).toBe(false);
    expect(third.reason).toMatch(/quota reached: at most 2 spaces/);
    // Renaming an existing space still works.
    const renamed = signRecord(
      alice.identity,
      'space',
      recordKey.space(first.spaceId),
      { ...first.body, name: 'Renamed' },
      first.record.version + 1,
    );
    expectAccepted(await put(alice, renamed));
    // Other accounts have their own budget.
    const bob = await user(c);
    expectAccepted(await put(bob, space(bob).record));
  });

  it('limits devices per account and invites per space', async () => {
    const c = await server({ quotas: { devicesPerUser: 2, invitesPerSpace: 2 } });
    const alice = await user(c);
    const device = () => {
      const deviceId = randomDeviceId();
      return signRecord(
        alice.identity,
        'device',
        recordKey.device(alice.identity.userId, deviceId),
        {
          userId: alice.identity.userId,
          deviceId,
          name: 'test',
          platform: 'bot' as const,
          prekey: createPrekey().bundle,
        },
      );
    };
    expectAccepted(await put(alice, device()));
    expectAccepted(await put(alice, device()));
    expect((await put(alice, device())).reason).toMatch(/at most 2 devices/);

    const s = space(alice);
    expectAccepted(await put(alice, s.record));
    const invite = () => {
      const code = randomId(6);
      return signRecord(alice.identity, 'invite', recordKey.invite(code), {
        spaceId: s.spaceId,
        code,
        expiresAt: null,
      });
    };
    expectAccepted(await put(alice, invite()));
    expectAccepted(await put(alice, invite()));
    expect((await put(alice, invite())).reason).toMatch(/at most 2 invites per space/);
  });

  it('limits active memberships; leaving frees a place', async () => {
    const c = await server({ quotas: { membershipsPerUser: 1 } });
    // Owners are members of their own space, so each owner gets one space here.
    const one = await createSpace(await user(c), 'One');
    const two = await createSpace(await user(c), 'Two');
    const alice = await user(c);
    await joinSpace(alice, one.spaceId, one.code);
    const member = (spaceId: string, code: string, left?: boolean) =>
      signRecord(alice.identity, 'member', recordKey.member(spaceId, alice.identity.userId), {
        spaceId,
        userId: alice.identity.userId,
        inviteCode: code,
        ...(left ? { left } : {}),
      });
    expect((await put(alice, member(two.spaceId, two.code))).reason).toMatch(/at most 1 spaces/);
    expectAccepted(await put(alice, member(one.spaceId, one.code, true)));
    expectAccepted(await put(alice, member(two.spaceId, two.code)));
    // Rejoining the first space would make two again.
    expect((await put(alice, member(one.spaceId, one.code))).reason).toMatch(/quota reached/);
  });

  it('refuses leave records for memberships that never existed', async () => {
    const c = await server();
    const alice = await user(c);
    const spaceId = spaceIdFor(createIdentity().publicKey, 'some-nonce');
    const leave = signRecord(
      alice.identity,
      'member',
      recordKey.member(spaceId, alice.identity.userId),
      { spaceId, userId: alice.identity.userId, left: true },
    );
    const res = await put(alice, leave);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('not a member of this space');
  });

  it('does not drop records replicated from a server with a looser limit', async () => {
    const a = await server({ name: 'A', quotas: { spacesPerUser: 5 } });
    const b = await server({ name: 'B', meshPeers: [a.url], quotas: { spacesPerUser: 1 } });
    await waitFor(() => b.mesh.peerIds().length === 1, 5000, 'mesh link');
    const alice = await user(a);
    const spaces = [space(alice), space(alice), space(alice)];
    for (const s of spaces) expectAccepted(await put(alice, s.record));
    await waitFor(
      () => spaces.every((s) => b.records.get(recordKey.space(s.spaceId))),
      3000,
      'replication',
    );
  });

  it('refuses to start with a quota that is not a positive whole number', () => {
    expect(
      () => new Coordinator({ name: 'x', storage: 'memory', quotas: { spacesPerUser: 0 } }),
    ).toThrow(/quotas.spacesPerUser must be a positive whole number/);
  });
});

describe('account deletion', () => {
  it('erases the account on every server, signs out its devices and refuses it afterwards', async () => {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => b.mesh.peerIds().length === 1, 5000, 'mesh link');

    const alice = await user(a, 'alice');
    const me = alice.identity.userId;
    const deviceId = peerIds.device(alice.conn.peer);
    const prekey = createPrekey().bundle;
    const put = (u: TestUser, record: SignedRecord) => u.conn.request('records.put', { record });
    expectAccepted(
      await put(
        alice,
        signRecord(alice.identity, 'device', recordKey.device(me, deviceId), {
          userId: me,
          deviceId,
          name: 'laptop',
          platform: 'bot',
          prekey,
        }),
      ),
    );
    const bob = await user(a, 'bob');
    expectAccepted(
      await put(
        alice,
        signRecord(alice.identity, 'friends', recordKey.friends(me), {
          friends: [bob.identity.userId],
          blocked: [],
        }),
      ),
    );
    const space = await createSpace(bob, 'Swamp');
    await joinSpace(alice, space.spaceId, space.code);
    // Mail waiting for her.
    const bobDevice = peerIds.device(bob.conn.peer);
    expectAccepted(
      await put(
        bob,
        signRecord(bob.identity, 'device', recordKey.device(bob.identity.userId, bobDevice), {
          userId: bob.identity.userId,
          deviceId: bobDevice,
          name: 'phone',
          platform: 'bot',
          prekey: createPrekey().bundle,
        }),
      ),
    );
    alice.conn.close();
    await waitFor(() => a.presence.localOf(me).length === 0, 3000, 'alice offline');
    const sealed = sealToDevice(
      bob.identity,
      bobDevice,
      { peer: alice.conn.peer, prekey },
      utf8.encode('{"type":"mail","messages":[]}'),
    );
    await bob.conn.request('mail.put', { items: [{ to: alice.conn.peer, box: sealed }] });
    expect(a.store.mailCount({ toUser: me })).toBe(1);

    const keys = [
      recordKey.device(me, deviceId),
      recordKey.friends(me),
      recordKey.member(space.spaceId, me),
    ];
    await waitFor(() => keys.every((k) => b.records.get(k)), 3000, 'replicated to B');

    // Two devices online when she deletes the account from one of them.
    const phone = await connectUser(a, alice.identity, 'alice');
    const laptop = await connectUser(a, alice.identity, 'alice');
    const closes: number[] = [];
    laptop.conn.on('close', ({ code }) => closes.push(code));
    const marker = signRecord(alice.identity, 'profile', recordKey.profile(me), {
      username: DELETED_PROFILE_NAME,
      encKey: alice.identity.encPublicKey,
      deleted: true,
    });
    expectAccepted(await put(phone, marker));

    for (const c of [a, b]) {
      await waitFor(
        () => (c.records.get(recordKey.profile(me))?.body as ProfileBody).deleted,
        3000,
        `marker on ${c.config.name}`,
      );
      for (const k of keys) expect(c.records.get(k), `${k} on ${c.config.name}`).toBeUndefined();
    }
    expect(a.store.mailCount({ toUser: me })).toBe(0);
    // Signed out everywhere, and can't sign in again.
    await waitFor(() => closes.includes(4010), 3000, 'laptop signed out');
    await expect(connectUser(a, alice.identity, 'alice')).rejects.toThrow(/deleted/);
    // A stale copy of her old records can't come back through the mesh.
    const old = signRecord(
      alice.identity,
      'friends',
      recordKey.friends(me),
      { friends: [], blocked: [] },
      Date.now() - 60_000,
    );
    expect(b.records.put(old, { fresh: false, origin: 'peer' }).reason).toBe('account was deleted');
    // Bob's own records are untouched.
    expect(a.records.get(recordKey.space(space.spaceId))).toBeDefined();
  });
});

describe('sealed friends lists and notes', () => {
  /** A note to `to`, sealed to one of their devices by `from`, signed by a one-time key. */
  function noteTo(to: TestUser, from = createIdentity(), version = Date.now()) {
    const author = createIdentity();
    const box = sealAnonymous(
      from,
      randomDeviceId(),
      { peer: to.conn.peer, prekey: createPrekey().bundle },
      utf8.encode('{"type":"friend"}'),
    );
    return signRecord(
      author,
      'note',
      recordKey.note(to.identity.userId, author.userId),
      { boxes: [box] },
      version,
    );
  }

  it('stores a sealed friends list without learning anything from it', async () => {
    const c = await server();
    const alice = await user(c);
    const bob = await user(c);
    const key = recordKey.friends(alice.identity.userId);
    const list = signRecord(alice.identity, 'friends', key, {
      sealed: sealForSelf(alice.identity, 'friends', utf8.encode(bob.identity.userId), key),
    });
    expectAccepted(await alice.conn.request('records.put', { record: list }));
    expect(JSON.stringify(c.records.get(key))).not.toContain(bob.identity.userId);
    expect((await bob.conn.request('friends.incoming', {})).records).toEqual([]);
    expect(bob.events.some((e) => e.ev === 'record')).toBe(false);
    // Only Alice may write her list, sealed or not.
    const forged = signRecord(bob.identity, 'friends', key, { sealed: 'AAAA' });
    expect((await bob.conn.request('records.put', { record: forged })).accepted).toBe(false);
  });

  it('gives notes to their recipient alone, without saying who sent them', async () => {
    const { a, b } = await (async () => {
      const a = await server({ name: 'A' });
      const b = await server({ name: 'B', meshPeers: [a.url] });
      await waitFor(() => b.mesh.peerIds().length === 1, 5000, 'mesh link');
      return { a, b };
    })();
    const alice = await user(a);
    const bob = await user(b);
    const eve = await user(b);
    await eve.conn.request('records.subscribe', { prefixes: ['note:', 'not'] });
    const note = noteTo(bob, alice.identity);
    expectAccepted(await alice.conn.request('records.put', { record: note }));
    // Replicated, and pushed to Bob's devices on his server.
    await waitFor(
      () =>
        bob.events.find(
          (e) => e.ev === 'record' && (e.d as { record: SignedRecord }).record.key === note.key,
        ),
      3000,
      'note pushed to bob',
    );
    const stored = JSON.stringify(b.records.get(note.key));
    expect(stored).not.toContain(alice.identity.userId);
    expect(stored).not.toContain(alice.identity.publicKey);
    expect(
      (
        await bob.conn.request('records.list', {
          prefix: recordKey.notePrefix(bob.identity.userId),
        })
      ).records,
    ).toHaveLength(1);
    // Nobody else sees Bob's notes: not by key, not by prefix, not by subscription.
    expect((await eve.conn.request('records.get', { keys: [note.key] })).records).toEqual([]);
    expect((await eve.conn.request('records.list', { prefix: 'note:' })).records).toEqual([]);
    expect((await eve.conn.request('records.list', { prefix: 'not' })).records).toEqual([]);
    expect(
      eve.events.some(
        (e) => e.ev === 'record' && (e.d as { record: SignedRecord }).record.kind === 'note',
      ),
    ).toBe(false);

    // Only Bob deletes it, and the deletion replicates.
    const del = (by: TestUser) =>
      signRecord(by.identity, 'note', note.key, { boxes: [], deleted: true }, note.version + 1);
    expect((await eve.conn.request('records.put', { record: del(eve) })).accepted).toBe(false);
    expectAccepted(await bob.conn.request('records.put', { record: del(bob) }));
    await waitFor(
      () => (a.records.get(note.key)?.body as { deleted?: boolean }).deleted,
      3000,
      'deletion replicated',
    );
    // A note can't be written twice, nor a missing one deleted.
    expect((await alice.conn.request('records.put', { record: note })).accepted).toBe(false);
    const ghost = signRecord(
      bob.identity,
      'note',
      recordKey.note(bob.identity.userId, createIdentity().userId),
      { boxes: [], deleted: true },
    );
    expect(await bob.conn.request('records.put', { record: ghost })).toMatchObject({
      accepted: false,
      reason: 'no such note',
    });
  });

  it('refuses an empty note, which would only fill the quota', async () => {
    const c = await server();
    const alice = await user(c);
    const bob = await user(c);
    const author = createIdentity();
    const empty = signRecord(author, 'note', recordKey.note(bob.identity.userId, author.userId), {
      boxes: [],
    });
    expect(await alice.conn.request('records.put', { record: empty })).toMatchObject({
      accepted: false,
      reason: 'a note carries at least one box',
    });
  });

  it('limits unread notes per recipient and expires old ones', async () => {
    const c = await server({ quotas: { notesPerUser: 2 } });
    const alice = await user(c);
    const bob = await user(c);
    const first = noteTo(bob);
    for (const n of [first, noteTo(bob)])
      expectAccepted(await alice.conn.request('records.put', { record: n }));
    expect(await alice.conn.request('records.put', { record: noteTo(bob) })).toMatchObject({
      accepted: false,
    });
    // Reading one frees a place.
    expectAccepted(
      await bob.conn.request('records.put', {
        record: signRecord(
          bob.identity,
          'note',
          first.key,
          { boxes: [], deleted: true },
          first.version + 1,
        ),
      }),
    );
    expectAccepted(await alice.conn.request('records.put', { record: noteTo(bob) }));

    // Old ones go, the deletion marker included, and can't come back.
    expect(c.records.expireNotes(Date.now() + NOTE_TTL_MS + 60_000)).toBe(3);
    expect(c.store.listPrefix('note:', 100)).toEqual([]);
    const stale = noteTo(bob, createIdentity(), Date.now() - NOTE_TTL_MS - 60_000);
    expect(c.records.put(stale, { fresh: false, origin: 'peer' }).reason).toBe('note expired');
  });

  it('lets copies of notes from other owners in past the quota, but only twice over', async () => {
    const c = await server({ quotas: { notesPerUser: 2 } });
    const bob = await user(c);
    const copies = Array.from({ length: 6 }, () => noteTo(bob));
    const results = copies.map((n) => c.records.put(n, { fresh: false, origin: 'peer' }));
    expect(results.map((r) => r.accepted)).toEqual([true, true, true, true, false, false]);
    expect(results[4]!.reason).toMatch(/quota reached/);
    expect(c.store.countByTerm(`note-to:${bob.identity.userId}`)).toBe(4);
    // A deletion marker takes no place, so it is let in at the ceiling: for a note that is not
    // here (or the note would come back), and for one that is.
    const marker = (n: ReturnType<typeof noteTo>) =>
      signRecord(bob.identity, 'note', n.key, { boxes: [], deleted: true }, n.version + 1);
    const unseen = noteTo(bob);
    expect(c.records.put(marker(unseen), { fresh: false, origin: 'peer' }).accepted).toBe(true);
    // It is not counted, so a note is still refused after it.
    expect(c.store.countByTerm(`note-to:${bob.identity.userId}`)).toBe(4);
    expect(c.records.put(noteTo(bob), { fresh: false, origin: 'peer' }).reason).toMatch(
      /quota reached/,
    );
    // One for a note that is held takes that note's place.
    expect(c.records.put(marker(copies[0]!), { fresh: false, origin: 'peer' }).accepted).toBe(true);
    expect(c.store.countByTerm(`note-to:${bob.identity.userId}`)).toBe(3);
  });

  it("writes only a user's own records for them, notes apart", async () => {
    const c = await server();
    const alice = await user(c);
    const mallory = await user(c);
    // Mallory sends in a profile signed by someone else's key (here, a stranger's).
    const stranger = createIdentity();
    const profile = signRecord(stranger, 'profile', recordKey.profile(stranger.userId), {
      username: 'stranger',
      encKey: stranger.encPublicKey,
    });
    await expect(mallory.conn.request('records.put', { record: profile })).rejects.toThrow(
      /written by their author/,
    );
    expect(c.records.get(profile.key)).toBeUndefined();
    // Nor a device, nor a space, signed by someone else.
    const device = signRecord(stranger, 'device', recordKey.device(stranger.userId, 'dev1'), {
      userId: stranger.userId,
      deviceId: 'dev1',
      name: 'x',
      platform: 'bot',
      prekey: createPrekey().bundle,
    });
    await expect(mallory.conn.request('records.put', { record: device })).rejects.toThrow(
      /written by their author/,
    );
    const nonce = randomId(8);
    const spaceId = spaceIdFor(stranger.publicKey, nonce);
    const space = signRecord(stranger, 'space', recordKey.space(spaceId), {
      name: 'x',
      owner: stranger.userId,
      nonce,
      admins: [],
      bans: [],
      channels: [],
    });
    await expect(mallory.conn.request('records.put', { record: space })).rejects.toThrow(
      /written by their author/,
    );
    // Nor anything else of someone else's: the check comes before the record is looked at.
    for (const kind of ['friends', 'member', 'invite'] as const) {
      const other = signRecord(stranger, kind, `${kind}:${stranger.userId}`, {} as never);
      await expect(mallory.conn.request('records.put', { record: other })).rejects.toThrow(
        /written by their author/,
      );
    }
    // A note is signed by a key of its own and may come from anyone.
    expectAccepted(await mallory.conn.request('records.put', { record: noteTo(alice) }));
    // And a user's own go in as before.
    const own = signRecord(
      mallory.identity,
      'profile',
      recordKey.profile(mallory.identity.userId),
      {
        username: 'mallory2',
        encKey: mallory.identity.encPublicKey,
      },
    );
    expectAccepted(await mallory.conn.request('records.put', { record: own }));
  });

  it('erases notes to a deleted account', async () => {
    const c = await server();
    const alice = await user(c);
    const bob = await user(c);
    const n = noteTo(bob);
    expectAccepted(await alice.conn.request('records.put', { record: n }));
    expectAccepted(
      await bob.conn.request('records.put', {
        record: signRecord(bob.identity, 'profile', recordKey.profile(bob.identity.userId), {
          username: DELETED_PROFILE_NAME,
          encKey: bob.identity.encPublicKey,
          deleted: true,
        }),
      }),
    );
    expect(c.records.get(n.key)).toBeUndefined();
    expect((await alice.conn.request('records.put', { record: noteTo(bob) })).accepted).toBe(false);
  });
});

describe('account deletion, answered', () => {
  it('answers the request that deleted the account before signing the device out', async () => {
    const c = await server();
    const alice = await user(c);
    // A slow write (owners elsewhere to reach first, a busy server).
    const put = c.dist.putFromClient.bind(c.dist);
    c.dist.putFromClient = async (record) => {
      const res = await put(record);
      await new Promise((r) => setTimeout(r, 400));
      return res;
    };
    const closed = new Promise<number>((resolve) =>
      alice.conn.on('close', ({ code }) => resolve(code)),
    );
    const marker = signRecord(alice.identity, 'profile', recordKey.profile(alice.identity.userId), {
      username: DELETED_PROFILE_NAME,
      encKey: alice.identity.encPublicKey,
      deleted: true,
    });
    expectAccepted(await alice.conn.request('records.put', { record: marker }));
    expect(await closed).toBe(4010);
  });
});

describe('operator contact', () => {
  it('tells apps and /v1/info who runs the server, outside the signed server info', async () => {
    const c = await server({ operatorContact: 'https://example.org/privacy/' });
    const u = await user(c);
    expect(u.conn.operator).toEqual({ contact: 'https://example.org/privacy/' });
    const info = (await (await fetch(`${c.url}/v1/info`)).json()) as {
      server: object;
      operator?: { contact: string };
    };
    expect(info.operator).toEqual({ contact: 'https://example.org/privacy/' });
    // Older apps and directories verify the signed ServerInfo without knowing
    // new fields, so the contact must stay out of it.
    expect(JSON.stringify(info.server)).not.toContain('example.org/privacy');
  });

  it('refuses a malformed contact at startup', async () => {
    await expect(startCoordinator({ operatorContact: 'javascript:alert(1)' })).rejects.toThrow(
      /operatorContact/,
    );
  });
});

describe('version', () => {
  it('reports the version it was released as', async () => {
    const c = await server({ version: '0.2.1' });
    expect(c.info.version).toBe('0.2.1');
    const health = (await (await fetch(`${c.url}/health`)).json()) as { version: string };
    expect(health.version).toBe('0.2.1');
  });

  it('refuses a version longer than ServerInfo allows', async () => {
    expect((await server({ version: 'v'.repeat(32) })).info.version).toHaveLength(32);
    await expect(startCoordinator({ version: 'v'.repeat(33) })).rejects.toThrow(/version/);
  });
});

describe('device linking', () => {
  it('holds the link steps to their order and to the devices in them', async () => {
    const c = await server();
    const fresh = await user(c);
    const encKey = fresh.identity.encPublicKey;
    // An ML-KEM key of the wrong length never gets a code.
    await expect(
      fresh.conn.request('link.open', { encKey, kemKey: 'A'.repeat(1578), commit: linkNonce() }),
    ).rejects.toThrow();
    const kemKey = createLinkKem().publicKey;
    const { code } = await fresh.conn.request('link.open', { encKey, kemKey, commit: linkNonce() });
    const existing = await user(c);
    await existing.conn.request('link.claim', { code });
    // The account can't go out before the existing device's nonce has.
    const box = sealLink(existing.identity, { encKey, kemKey }, new Uint8Array(32));
    await expect(existing.conn.request('link.send', { code, box })).rejects.toThrow(/nonce/);
    const claimed = new Promise<{ by: string }>((r) => fresh.conn.on('link_claimed', r));
    await existing.conn.request('link.nonce', { code, nonce: linkNonce() });
    const { by } = await claimed;
    expect(by).toBe(existing.conn.peer);
    // The new device's nonce goes only to the device that claimed the code.
    const other = await user(c);
    await expect(
      fresh.conn.request('link.reveal', { code, to: other.conn.peer, nonce: linkNonce() }),
    ).rejects.toThrow(/another device/);
    await fresh.conn.request('link.reveal', { code, to: by, nonce: linkNonce() });
    // It reveals once; a second nonce can't replace the first.
    await expect(
      fresh.conn.request('link.reveal', { code, to: by, nonce: linkNonce() }),
    ).rejects.toThrow(/already revealed/);
    await existing.conn.request('link.send', { code, box });
    // Once the account is sent the link is spent: no more nonces.
    await expect(existing.conn.request('link.nonce', { code, nonce: linkNonce() })).rejects.toThrow(
      /claim the code first/,
    );
  });

  it('limits code lookups per connection, whatever origin the frames name', async () => {
    const c = await server();
    let looked = 0;
    const findLink = c.findLink.bind(c);
    c.findLink = (code) => {
      looked++;
      return findLink(code);
    };
    const onFlood = (
      c.mesh as unknown as { onFlood(f: unknown, from: string, link: object): void }
    ).onFlood.bind(c.mesh);
    const link = {};
    // A server that names a new origin in every frame still has one budget.
    for (let i = 0; i < 200; i++) {
      onFlood(
        {
          t: 'flood',
          id: `q${i}`,
          origin: `origin-${i}`,
          hops: 9,
          f: { t: 'link_query', qid: `q${i}`, code: 'ABCD-EFGH' },
        },
        'peer',
        link,
      );
    }
    expect(looked).toBeGreaterThan(0);
    expect(looked).toBeLessThan(100);
    // Another connection has a budget of its own.
    const before = looked;
    onFlood(
      {
        t: 'flood',
        id: 'other',
        origin: 'o',
        hops: 9,
        f: { t: 'link_query', qid: 'other', code: 'ABCD-EFGH' },
      },
      'peer2',
      {},
    );
    expect(looked).toBe(before + 1);
  });

  it('gives the steps after a claim a budget of their own', async () => {
    const c = await server();
    const fresh = await user(c);
    const kemKey = createLinkKem().publicKey;
    const { code } = await fresh.conn.request('link.open', {
      encKey: fresh.identity.encPublicKey,
      kemKey,
      commit: linkNonce(),
    });
    const existing = await user(c);
    // Steps that fail still cost, and they don't draw on the budget for guessing codes.
    const tries = [];
    for (let i = 0; i < 12; i++) {
      tries.push(
        existing.conn
          .request(i % 2 ? 'link.nonce' : 'link.reveal', {
            code,
            to: fresh.conn.peer,
            nonce: linkNonce(),
          })
          .then(
            () => 'ok',
            (e: Error) => e.message,
          ),
      );
    }
    const results = await Promise.all(tries);
    expect(results.filter((m) => /too many attempts/.test(m)).length).toBeGreaterThan(0);
    // Guesses at codes are still five a burst.
    const guesses = await Promise.all(
      Array.from({ length: 8 }, () =>
        existing.conn.request('link.claim', { code: 'WRONGCODE' }).then(
          () => 'ok',
          (e: Error) => e.message,
        ),
      ),
    );
    expect(guesses.filter((m) => /too many attempts/.test(m))).toHaveLength(3);
  });
});
