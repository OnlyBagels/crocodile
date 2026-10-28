import { afterEach, describe, expect, it } from 'vitest';
import { createIdentity } from '@crocodile/crypto';
import { GroupKeyring } from '../src/keyring';
import type { RelayGrant, SessionState } from '@crocodile/protocol';
import { Emitter } from '../src/emitter';
import {
  GroupSession,
  type RelayTransport,
  type SessionContext,
  type TransportFactory,
} from '../src/group-session';
import type { RelayLinkEvents } from '../src/relay-link';

/** A connection that never gets anywhere: the session decides what happens to it. */
class StuckTransport extends Emitter<RelayLinkEvents> implements RelayTransport {
  closed = false;
  readonly isOpen = false;
  async connect() {
    this.emit('progress', { step: 'offer' });
  }
  async handleSignal() {}
  send() {
    return false;
  }
  close() {
    this.closed = true;
  }
}

const me = 'aaaaaaaaaaaaaaaaaaaaaaaaaa.dev1';
const sessions: GroupSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.leave();
});

function session(
  relayRequest: () => Promise<RelayGrant>,
  request: (type: string) => Promise<unknown> = async () => ({}),
) {
  const transports: StuckTransport[] = [];
  const factory: TransportFactory = () => {
    const t = new StuckTransport();
    transports.push(t);
    return t;
  };
  const ctx = {
    identity: createIdentity(),
    peer: me,
    link: () => ({ request }),
    caps: async () => ({}),
    platform: {},
    iceServers: () => [],
    relay: { allowed: () => true, request: relayRequest },
    isMemberPeer: () => true,
    isAllowedPeer: () => true,
    refreshPeer: async () => {},
    log: () => {},
  } as unknown as SessionContext;
  const s = new GroupSession('dm:a:b', ctx, factory);
  sessions.push(s);
  return { s, transports };
}

const state = (host: string, epoch: number): SessionState => ({
  id: 'dm:a:b',
  epoch,
  host,
  backup: null,
  members: [],
  relaySlots: 0,
  updatedAt: 0,
});

const grant = (ms: number): RelayGrant => ({
  urls: ['turn:example.org:7443?transport=udp'],
  username: 'u',
  credential: 'c',
  expiresAt: Date.now() + ms,
  server: 'Test',
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('group session', () => {
  it('ends an attempt the session moved on from, instead of leaving it "trying"', () => {
    const { s, transports } = session(async () => grant(60_000));
    s.applyState(state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1));
    // The host changes before the first attempt got anywhere.
    s.applyState(state('cccccccccccccccccccccccccc.dev1', 2));
    expect(transports[0]!.closed).toBe(true);
    expect(s.attempts).toHaveLength(2);
    expect(s.attempts[0]!.end).toMatchObject({ ok: false, stage: 'superseded' });
    expect(s.attempts[1]!.end).toBeUndefined();
  });

  /** A server that refuses a relay until it has seen the join, and counts the joins. */
  function joinFirst() {
    const sent: string[] = [];
    let joined = false;
    const made = session(
      async () => {
        if (!joined) throw new Error('join the session first');
        return grant(60_000);
      },
      async (type) => {
        sent.push(type);
        if (type !== 'session.join') return {};
        await wait(20);
        joined = true;
        return { state: state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1) };
      },
    );
    return { ...made, joins: () => sent.filter((t) => t === 'session.join').length };
  }

  it('joins the session first when asked for a relay before it has', async () => {
    const { s, joins } = joinFirst();
    await s.useServerRelay();
    expect(s.relayGrant).not.toBeNull();
    expect(joins()).toBe(1);
  });

  it('shares a join that is already under way, and does not join again once joined', async () => {
    const { s, joins } = joinFirst();
    const joining = s.join();
    await s.useServerRelay();
    await joining;
    expect(s.relayGrant).not.toBeNull();
    expect(joins()).toBe(1);
    await s.useServerRelay();
    expect(joins()).toBe(1);
  });

  it('does not bring back a session that was left', async () => {
    const { s, joins } = joinFirst();
    await s.leave();
    await s.useServerRelay();
    expect(s.relayGrant).toBeNull();
    expect(joins()).toBe(0);
  });

  it('does not take a relay for a joined session that was left', async () => {
    const { s } = joinFirst();
    await s.join();
    await s.leave();
    await s.useServerRelay();
    expect(s.relayGrant).toBeNull();
  });

  it('sends its own join after a leave instead of sharing the one already under way', async () => {
    const { s, joins } = joinFirst();
    const before = s.join();
    await wait(5);
    await s.leave();
    const after = s.join();
    await Promise.all([before, after]);
    expect(joins()).toBe(2);
    expect(s.relayGrant).toBeNull();
    await s.useServerRelay();
    expect(s.relayGrant).not.toBeNull();
  });

  it('does not keep a grant that arrives after the session was left', async () => {
    const { s } = session(async () => {
      await wait(30);
      return grant(60_000);
    });
    s.applyState(state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1));
    const asking = s.useServerRelay();
    await s.leave();
    await asking;
    expect(s.relayGrant).toBeNull();
  });

  it('sends a join on a new connection even while one sent on the old one is in flight', async () => {
    const { s, joins } = joinFirst();
    const old = s.join();
    await Promise.all([old, s.join({ fresh: true })]);
    expect(joins()).toBe(2);
  });

  it('lets every caller see a failed join, and sends the next one anew', async () => {
    let joins = 0;
    const { s } = session(
      async () => grant(60_000),
      async (type) => {
        if (type !== 'session.join') return {};
        if (joins++ > 0) return { state: state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1) };
        await wait(10);
        throw new Error('link down');
      },
    );
    const results = await Promise.allSettled([s.join(), s.join()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(joins).toBe(1);
    await s.join();
    expect(joins).toBe(2);
  });

  it('sends no join for a session that was left before it went out', async () => {
    const { s, joins } = joinFirst();
    const joining = s.join();
    await s.leave();
    await joining;
    expect(joins()).toBe(0);
  });

  it('waits for a join under way on a new connection before asking for a relay', async () => {
    const { s, joins } = joinFirst();
    s.applyState(state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1));
    void s.join({ fresh: true });
    await s.useServerRelay();
    expect(s.relayGrant).not.toBeNull();
    expect(joins()).toBe(1);
  });

  it('does not take a relay when it was left while joining', async () => {
    const { s } = joinFirst();
    const asking = s.useServerRelay();
    await s.leave();
    await asking;
    expect(s.relayGrant).toBeNull();
  });

  it('tries a failed relay renewal again before the grant runs out', async () => {
    const answers = [grant(600), 'fail', grant(60_000)] as const;
    let asked = 0;
    const { s } = session(async () => {
      const a = answers[Math.min(asked++, answers.length - 1)]!;
      if (a === 'fail') throw new Error('link down');
      return a;
    });
    s.applyState(state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1));
    await s.useServerRelay();
    const first = s.relayGrant!.expiresAt;
    await wait(700);
    expect(asked).toBe(3);
    expect(s.relayGrant!.expiresAt).toBeGreaterThan(first);
  });

  it('drops a grant at its end even when the server never says so', async () => {
    let asked = 0;
    const { s, transports } = session(async () => {
      if (asked++ === 0) return grant(400);
      throw new Error('link down');
    });
    s.applyState(state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1));
    await s.useServerRelay();
    expect(s.relayGrant).not.toBeNull();
    const before = transports.length;
    await wait(600);
    expect(s.relayGrant).toBeNull();
    // The connection, which depended on the relay, was set up again without it.
    expect(transports.length).toBe(before + 1);
  });

  describe('who the relay we host admits', () => {
    const bob = 'bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1';
    async function admitted(sessionId: string) {
      let members: (() => string[]) | undefined;
      const ctx = {
        identity: createIdentity(),
        peer: me,
        link: () => ({ request: async () => ({}) }),
        platform: {
          relay: {
            start: async (opts: { members: () => string[] }) => {
              members = opts.members;
              return { handleSignal() {}, close() {} };
            },
          },
        },
        iceServers: () => [],
        relay: { allowed: () => false, request: async () => grant(1000) },
        // Bob belongs but we have blocked him.
        isMemberPeer: () => true,
        isAllowedPeer: (_: string, peer: string) => peer !== bob,
        refreshPeer: async () => {},
        log: () => {},
      } as unknown as SessionContext;
      const s = new GroupSession(sessionId, ctx, () => new StuckTransport());
      sessions.push(s);
      const caps = { nat: 'open' as const, canHost: true };
      s.applyState({
        ...state(me, 1),
        id: sessionId,
        members: [
          { peer: me, caps },
          { peer: bob, caps },
        ],
      } as unknown as SessionState);
      await wait(20);
      return members!();
    }

    it('in a direct conversation, not the one we blocked', async () => {
      expect(await admitted('dm:a:b')).toEqual([me]);
    });

    it('in a space, a blocked member too: the others are relayed to them', async () => {
      expect(await admitted('space:abc')).toEqual([me, bob]);
    });
  });

  it('does not connect to the other side of a direct conversation that we blocked', async () => {
    const bob = 'bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1';
    const transports: StuckTransport[] = [];
    const requests: string[] = [];
    const ctx = {
      identity: createIdentity(),
      peer: me,
      link: () => ({
        request: async (m: string) => {
          requests.push(m);
          return {};
        },
      }),
      platform: {},
      iceServers: () => [],
      relay: { allowed: () => false, request: async () => grant(1000) },
      isMemberPeer: () => true,
      isAllowedPeer: () => false,
      refreshPeer: async () => {},
      log: () => {},
    } as unknown as SessionContext;
    const s = new GroupSession('dm:a:b', ctx, () => {
      const t = new StuckTransport();
      transports.push(t);
      return t;
    });
    sessions.push(s);
    s.applyState(state(bob, 1));
    await wait(20);
    expect(transports).toHaveLength(0);
    expect(s.status).toBe('reconnecting');
    // The server knows nothing of blocks, so it is not told.
    expect(requests).not.toContain('session.report');
  });

  it('stops hearing a peer at once when their key is only in its grace period', () => {
    const alice = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    bob.addPeerKey('alice.d1', alice.exportMine());
    bob.peerLeft('alice.d1');
    expect(bob.hasKeyFrom('alice.d1')).toBe(false);
    expect(bob.peersWithKeys()).toEqual(['alice.d1']);
    let latest = bob.frameKeys();
    bob.on('changed', (k) => (latest = k));
    bob.forgetPeer('alice.d1');
    expect(latest.peers).toEqual([]);
    expect(bob.peersWithKeys()).toEqual([]);
  });
});
