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

  it('continues the counter after every connection was lost, since listeners refuse counters they have passed', () => {
    vi.useFakeTimers();
    const keyring = new GroupKeyring({ autoRatchet: false });
    const scopes = new FrameScopes();
    const frame = new Uint8Array(60);
    scopes.update('conn-1', keyring.frameKeys());
    const last = counterOf(scopes.get('conn-1')!.sender!.encrypt(frame));
    const video = scopes.get('conn-1')!.video!;
    // The connection drops and the next one is made only afterwards.
    scopes.drop('conn-1');
    vi.advanceTimersByTime(10_000);
    scopes.update('conn-2', keyring.frameKeys());
    expect(counterOf(scopes.get('conn-2')!.sender!.encrypt(frame))).toBe((last + 1) >>> 0);
    expect(scopes.get('conn-2')!.video).toBe(video);
    keyring.dispose();
  });

  it('forgets our key once the call has been left, or the key replaced', () => {
    vi.useFakeTimers();
    const keyring = new GroupKeyring({ autoRatchet: false });
    const scopes = new FrameScopes();
    const senders = () => (scopes as unknown as { senders: Map<number, unknown> }).senders;
    scopes.update('conn-1', keyring.frameKeys());
    scopes.drop('conn-1');
    expect(senders().size).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(senders().size).toBe(0);
    // A replaced key's sender goes with the connection that used it.
    scopes.update('conn-2', keyring.frameKeys());
    keyring.rotate();
    scopes.update('conn-3', keyring.frameKeys());
    scopes.drop('conn-2');
    expect([...senders().keys()]).toEqual([keyring.kid]);
    keyring.dispose();
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
