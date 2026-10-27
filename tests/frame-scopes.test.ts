import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameScopes, GroupKeyring, vp8ClearBytes } from '@crocodile/client-core';
import { AudioReceiver, importChain } from '@crocodile/crypto';

afterEach(() => vi.useRealTimers());

const counterOf = (f: Uint8Array) =>
  new DataView(f.buffer, f.byteOffset + f.length - 11, 11).getUint32(6);

describe('voice frame keys in the worker', () => {
  it('continues the frame counter when a call reconnects, instead of reusing nonces', () => {
    const keyring = new GroupKeyring({ autoRatchet: false });
    const scopes = new FrameScopes();
    const frame = new Uint8Array(60);
    // First connection.
    scopes.update('conn-1', keyring.frameKeys());
    const a = [1, 2, 3].map(() => scopes.get('conn-1')!.sender!.encrypt(frame));
    // The call reconnects: a new connection gets a new scope with the same keys.
    scopes.update('conn-2', keyring.frameKeys());
    const b = scopes.get('conn-2')!.sender!.encrypt(frame);
    const counters = [...a, b].map(counterOf);
    expect(new Set(counters).size).toBe(4);
    expect(counters[3]).toBe((counters[2]! + 1) >>> 0);
    // Listeners still decrypt both.
    const mine = keyring.exportMine();
    const rx = new AudioReceiver(keyring.kid, importChain(mine.audio));
    expect(rx.decrypt(a[0]!)).toEqual(frame);
    expect(rx.decrypt(b)).toEqual(frame);

    // Dropping the old connection keeps the sender the new one uses.
    scopes.drop('conn-1');
    scopes.update('conn-3', keyring.frameKeys());
    expect(counterOf(scopes.get('conn-3')!.sender!.encrypt(frame))).toBe((counters[3]! + 1) >>> 0);
    keyring.dispose();
  });

  it('refuses a recorded frame again after the listener reconnects, and hears the sender after a reconnect', () => {
    vi.useFakeTimers();
    const alice = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    bob.addPeerKey('alice.d1', alice.exportMine());
    const scopes = new FrameScopes();
    const frame = new Uint8Array(60).fill(7);
    scopes.update('alice-1', alice.frameKeys());
    scopes.update('bob-1', bob.frameKeys());
    const recorded = scopes.get('alice-1')!.sender!.encrypt(frame);
    expect(scopes.get('bob-1')!.receivers.get(alice.kid)!.decrypt(recorded)).toEqual(frame);
    // The host cuts Bob's connection and he reconnects: the frame it recorded is still refused.
    scopes.drop('bob-1');
    scopes.update('bob-2', bob.frameKeys());
    const bobHears = (f: Uint8Array) => scopes.get('bob-2')!.receivers.get(alice.kid)!.decrypt(f);
    expect(bobHears(recorded)).toBeNull();
    // Alice reconnects too (moving her chain on, as a new connection does), and Bob, who stayed,
    // still hears her.
    scopes.drop('alice-1');
    alice.advanceAudio();
    scopes.update('alice-2', alice.frameKeys());
    bob.addPeerKey('alice.d1', alice.exportMine());
    scopes.update('bob-2', bob.frameKeys());
    expect(bobHears(scopes.get('alice-2')!.sender!.encrypt(frame))).toEqual(frame);
    alice.dispose();
    bob.dispose();
  });

  it('forgets the counters a listener took once the call has been left for longer than a generation', () => {
    vi.useFakeTimers();
    const alice = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    bob.addPeerKey('alice.d1', alice.exportMine());
    const scopes = new FrameScopes();
    scopes.update('alice', alice.frameKeys());
    scopes.update('bob-1', bob.frameKeys());
    const frame = new Uint8Array(60).fill(7);
    const recorded = scopes.get('alice')!.sender!.encrypt(frame);
    expect(scopes.get('bob-1')!.receivers.get(alice.kid)!.decrypt(recorded)).toEqual(frame);
    scopes.drop('bob-1');
    vi.advanceTimersByTime(10_000);
    scopes.update('bob-2', bob.frameKeys());
    expect(scopes.get('bob-2')!.receivers.get(alice.kid)!.decrypt(recorded)).toBeNull();
    scopes.drop('bob-2');
    scopes.drop('alice');
    vi.advanceTimersByTime(60_000);
    scopes.update('bob-3', bob.frameKeys());
    // Nothing is kept of the call any more (documented: it starts from the key as last sent).
    expect(scopes.get('bob-3')!.receivers.get(alice.kid)!.decrypt(recorded)).toEqual(frame);
    alice.dispose();
    bob.dispose();
  });

  it("forgets a replaced sender key's counters after a wait, whichever connection updates meanwhile", () => {
    vi.useFakeTimers();
    const alice = new GroupKeyring({ autoRatchet: false });
    const carol = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    bob.addPeerKey('alice.d1', alice.exportMine());
    const other = new GroupKeyring({ autoRatchet: false });
    other.addPeerKey('carol.d1', carol.exportMine());
    const scopes = new FrameScopes();
    scopes.update('bob-1', bob.frameKeys());
    const kept = scopes.get('bob-1')!.receivers.get(alice.kid)!;
    // Another session in the same worker updates while Bob's connection is being remade.
    scopes.drop('bob-1');
    vi.advanceTimersByTime(10_000);
    scopes.update('other', other.frameKeys());
    scopes.update('bob-2', bob.frameKeys());
    expect(scopes.get('bob-2')!.receivers.get(alice.kid)).toBe(kept);
    // After the wait, nothing of it is left.
    scopes.drop('bob-2');
    vi.advanceTimersByTime(60_000);
    scopes.update('other', other.frameKeys());
    scopes.update('bob-3', bob.frameKeys());
    expect(scopes.get('bob-3')!.receivers.get(alice.kid)).not.toBe(kept);
    for (const k of [alice, bob, carol, other]) k.dispose();
  });

  it('follows a sender whose key was sent again after a long quiet, without a new connection', () => {
    const alice = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    bob.addPeerKey('alice.d1', alice.exportMine());
    const scopes = new FrameScopes();
    scopes.update('bob', bob.frameKeys());
    // Alice is muted for twenty minutes of her audio chain, then speaks, and her key is sent again.
    for (let i = 0; i < 40; i++) alice.advanceAudio();
    bob.addPeerKey('alice.d1', alice.exportMine());
    scopes.update('bob', bob.frameKeys());
    scopes.update('alice', alice.frameKeys());
    const frame = new Uint8Array(60).fill(3);
    const heard = scopes
      .get('bob')!
      .receivers.get(alice.kid)!
      .decrypt(scopes.get('alice')!.sender!.encrypt(frame));
    expect(heard).toEqual(frame);
    // Video follows the same way.
    const seen = scopes
      .get('bob')!
      .videoReceivers.get(alice.kid)!
      .decrypt(scopes.get('alice')!.video!.encrypt(frame, vp8ClearBytes(true)));
    expect(seen).toEqual(frame);
    alice.dispose();
    bob.dispose();
  });

  it('takes the newer audio position from a key sent again, so a new connection can still decrypt', () => {
    const alice = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    bob.addPeerKey('alice.d1', alice.exportMine());
    // Twenty minutes of voice later: Alice's audio chain moved on, her text didn't.
    for (let i = 0; i < 20; i++) alice.advanceAudio();
    // Bob reconnects after a host failover and Alice sends her key again.
    bob.addPeerKey('alice.d1', alice.exportMine());
    const scopes = new FrameScopes();
    scopes.update('alice', alice.frameKeys());
    scopes.update('bob-after-failover', bob.frameKeys());
    const frame = new Uint8Array(60);
    const sent = scopes.get('alice')!.sender!.encrypt(frame);
    const receiver = scopes.get('bob-after-failover')!.receivers.get(alice.kid)!;
    expect(receiver.decrypt(sent)).toEqual(frame);
    alice.dispose();
    bob.dispose();
  });

  it("encrypts video with the sender's key, one counter for camera and screen, readable by members", () => {
    const alice = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    bob.addPeerKey('alice.d1', alice.exportMine());
    const scopes = new FrameScopes();
    scopes.update('alice', alice.frameKeys());
    scopes.update('bob', bob.frameKeys());
    const frame = Uint8Array.from({ length: 500 }, (_, i) => i & 0xff);
    const video = scopes.get('alice')!.video!;
    const cam = video.encrypt(frame, vp8ClearBytes(true));
    const screen = video.encrypt(frame, vp8ClearBytes(false));
    const vcounter = (f: Uint8Array) =>
      new DataView(f.buffer, f.byteOffset + f.length - 12, 12).getUint32(6);
    expect(vcounter(screen)).toBe((vcounter(cam) + 1) >>> 0);
    // The VP8 header stays as it was: 10 bytes of a key frame, 3 of another.
    expect(cam.subarray(0, 10)).toEqual(frame.subarray(0, 10));
    expect(screen.subarray(0, 3)).toEqual(frame.subarray(0, 3));
    const rx = scopes.get('bob')!.videoReceivers.get(alice.kid)!;
    expect(rx.decrypt(cam)).toEqual(frame);
    expect(rx.decrypt(screen)).toEqual(frame);
    // Audio receivers don't take video frames.
    expect(scopes.get('bob')!.receivers.get(alice.kid)!.decrypt(cam)).toBeNull();
    alice.dispose();
    bob.dispose();
  });
});
