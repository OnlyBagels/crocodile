import { describe, expect, it } from 'vitest';
import type { SessionView } from '@crocodile/client-core';
import { attemptSummary, dmStatusLabel } from '../src/renderer/lib/connection';

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
  networks: {},
  ...over,
});

describe('conversation list status', () => {
  it('says how the connection stands, not just that the friend is online', () => {
    expect(dmStatusLabel(true, session({}))).toBe('Online · direct');
    expect(dmStatusLabel(true, session({ route: 'lan' }))).toBe('Online · same network');
    expect(dmStatusLabel(true, session({ route: 'relay' }))).toBe('Online · relayed');
    expect(dmStatusLabel(true, session({ route: null }))).toBe('Online · connected');
    expect(dmStatusLabel(true, session({ status: 'connecting', route: null }))).toBe(
      'Online · connecting…',
    );
    expect(dmStatusLabel(true, session({ status: 'reconnecting', route: null }))).toBe(
      'Online · reconnecting…',
    );
    // Online, but no connection works: never "peer-to-peer".
    expect(dmStatusLabel(true, session({ status: 'reconnecting', trouble: true }))).toBe(
      "Online · can't connect directly",
    );
    // No conversation open with them: presence is all we know.
    expect(dmStatusLabel(true, undefined)).toBe('Online');
  });

  it('when hosting, reports whether they are connected, not our route to our own relay', () => {
    expect(dmStatusLabel(true, session({ iAmHost: true, route: 'local' }))).toBe(
      'Online · connected',
    );
    expect(dmStatusLabel(true, session({ iAmHost: true, route: 'local', peers: [] }))).toBe(
      'Online',
    );
  });

  it('keeps someone who appears offline offline, even with a connection', () => {
    // Invisible people show as offline; a connection mustn't give them away.
    expect(dmStatusLabel(false, session({}))).toBe('Offline · delivers when online');
    expect(dmStatusLabel(false, undefined)).toBe('Offline · delivers when online');
  });

  it('sums up an attempt, including how long a lost connection lasted', () => {
    const steps = (open: number) => [
      { step: 'offer' as const, at: 0 },
      { step: 'open' as const, at: open },
    ];
    expect(attemptSummary({ startedAt: 0, host: 'b', viaRelay: false, steps: [] })).toBe('Trying…');
    expect(
      attemptSummary({
        startedAt: 0,
        host: 'b',
        viaRelay: false,
        steps: steps(1000),
        end: { at: 1000 + 12 * 60_000, ok: false, stage: 'lost', reason: 'x' },
      }),
    ).toBe('Worked for 12 min, then was lost');
    expect(
      attemptSummary({
        startedAt: 0,
        host: 'b',
        viaRelay: false,
        steps: [],
        end: { at: 5, ok: false, stage: 'no-path', reason: 'x' },
      }),
    ).toBe('No network path worked');
  });
});
