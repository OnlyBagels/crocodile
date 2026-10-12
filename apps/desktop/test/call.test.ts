import { describe, expect, it } from 'vitest';
import type { SessionView } from '@crocodile/client-core';
import { callPhase, callStatusText, clock, latencyQuality } from '../src/renderer/lib/call';

const session = (over: Partial<SessionView>): SessionView => ({
  id: 'dm:a:b',
  status: 'connected',
  host: 'b',
  backup: null,
  epoch: 1,
  members: ['a', 'b'],
  peers: ['b'],
  speaking: [],
  muted: [],
  deafened: [],
  iAmHost: false,
  relay: null,
  route: 'internet',
  trouble: false,
  connectedAt: 1,
  attempts: [],
  networks: [],
  inCall: ['a'],
  latency: {},
  ...over,
});

describe('call status', () => {
  it('is live only once connected with the other side in it', () => {
    const live = { ringing: false, liveSince: 1000 };
    const notYet = { ringing: false, liveSince: null };
    expect(callPhase(session({}), { ringing: true, liveSince: null })).toBe('ringing');
    expect(callPhase(undefined, notYet)).toBe('connecting');
    expect(callPhase(session({ status: 'connecting' }), notYet)).toBe('connecting');
    expect(callPhase(session({ status: 'no-host' }), notYet)).toBe('no-host');
    // Connected, but alone: the other side hung up or hasn't joined.
    expect(callPhase(session({}), notYet)).toBe('waiting');
    expect(callPhase(session({ inCall: ['a', 'b'] }), live)).toBe('live');
    // A dropped connection isn't talking either, whatever the clock says.
    expect(callPhase(session({ status: 'reconnecting' }), live)).toBe('reconnecting');
  });

  it('says what the call is doing, and counts only live time', () => {
    const now = 10_000_000;
    expect(callStatusText('waiting', { liveSince: null, now, other: 'Bob' })).toBe(
      'Waiting for Bob to join',
    );
    expect(callStatusText('live', { liveSince: now - 65_000, now })).toBe('1:05');
    expect(clock(3_723_000)).toBe('1:02:03');
    expect(callStatusText('ringing', { liveSince: null, now })).toBe('Ringing…');
  });

  it('grades latency as people hear it', () => {
    expect(latencyQuality(40)).toBe('good');
    expect(latencyQuality(180)).toBe('fair');
    expect(latencyQuality(400)).toBe('poor');
  });
});
