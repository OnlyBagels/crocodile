import { afterEach, describe, expect, it } from 'vitest';
import { createIdentity } from '@crocodile/crypto';
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

function session(relayRequest: () => Promise<RelayGrant>) {
  const transports: StuckTransport[] = [];
  const factory: TransportFactory = () => {
    const t = new StuckTransport();
    transports.push(t);
    return t;
  };
  const ctx = {
    identity: createIdentity(),
    peer: me,
    link: () => ({ request: async () => ({}) }),
    platform: {},
    iceServers: () => [],
    relay: { allowed: () => true, request: relayRequest },
    isMemberPeer: () => true,
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
});
