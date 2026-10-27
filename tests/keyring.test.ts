import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupKeyring } from '@crocodile/client-core';

afterEach(() => vi.useRealTimers());

describe('keys from other members', () => {
  function pair() {
    const alice = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    return { alice, bob, kids: () => bob.frameKeys().peers.map((p) => p.kid) };
  }

  it('does not take back a key the sender has replaced, when it is sent again', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { alice, bob, kids } = pair();
    const first = alice.exportMine();
    expect(bob.addPeerKey('alice.d1', first, 1000)).toBe(true);
    const second = alice.rotate();
    expect(bob.addPeerKey('alice.d1', second, 2000)).toBe(true);
    // The replaced key is dropped after a short grace...
    vi.setSystemTime(Date.now() + 11_000);
    expect(kids()).toEqual([second.kid]);
    // ...and a copy of the message that carried it, replayed later, doesn't bring it back.
    expect(bob.addPeerKey('alice.d1', first, 3000)).toBe(false);
    expect(kids()).toEqual([second.kid]);
  });

  it('refuses a key sealed before the newest one taken from that member', () => {
    const { alice, bob, kids } = pair();
    const first = alice.exportMine();
    const second = alice.rotate();
    expect(bob.addPeerKey('alice.d1', second, 2000)).toBe(true);
    // Delivered late: it would make the old key the current one and let the new one lapse.
    expect(bob.addPeerKey('alice.d1', first, 1000)).toBe(false);
    expect(kids()).toEqual([second.kid]);
  });

  it('takes the same key sent again, and a key after a member has been away', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { alice, bob, kids } = pair();
    const key = alice.exportMine();
    expect(bob.addPeerKey('alice.d1', key, 1000)).toBe(true);
    expect(bob.addPeerKey('alice.d1', key, 2000)).toBe(true);
    // Away and back with the key they had: it was never replaced.
    bob.peerLeft('alice.d1');
    vi.setSystemTime(Date.now() + 11_000);
    expect(kids()).toEqual([]);
    expect(bob.addPeerKey('alice.d1', key, 3000)).toBe(true);
    expect(kids()).toEqual([key.kid]);
  });
});
