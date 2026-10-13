import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { RTCPeerConnection } from 'werift';
import { startStunServer } from '@crocodile/coordinator';
import { webrtcFileLinks, type FileLinkChannel } from '@crocodile/client-core';

/**
 * File links over real WebRTC, with werift at both ends: the stack a Node
 * client (the command line tool) uses. Chromium is covered by the Electron
 * smoke test.
 */

let stunPort = 0;
beforeAll(async () => {
  const socket = await startStunServer(0, '127.0.0.1');
  stunPort = (socket.address() as AddressInfo).port;
  return () => socket.close();
});

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

/** werift with only loopback addresses, so tests don't depend on the machine's network. */
class LoopbackPC extends RTCPeerConnection {
  constructor(config: ConstructorParameters<typeof RTCPeerConnection>[0] = {}) {
    super({ ...config, iceAdditionalHostAddresses: ['127.0.0.1'] });
  }
}
const factory = webrtcFileLinks(LoopbackPC as unknown as typeof globalThis.RTCPeerConnection);

async function pair() {
  const iceServers = [{ urls: `stun:127.0.0.1:${stunPort}` }];
  const a = factory({ self: 'a', remote: 'b', iceServers });
  const b = factory({ self: 'b', remote: 'a', iceServers });
  closers.push(
    () => a.close(),
    () => b.close(),
  );
  const offer = await a.createOffer();
  const answer = await b.acceptOffer(offer);
  await a.acceptAnswer(answer);
  return Promise.all([a.ready, b.ready]);
}

function collect(ch: FileLinkChannel) {
  const got: (string | Uint8Array)[] = [];
  ch.on('message', (m) => got.push(m));
  return got;
}

describe('file links (werift)', () => {
  it('opens a data channel and carries text and 48 KiB binary frames in order', async () => {
    const [a, b] = await pair();
    const got = collect(b);
    a.send('{"t":"hashes"}');
    const frames = Array.from({ length: 40 }, (_, i) => new Uint8Array(48 * 1024 + 9).fill(i));
    for (const f of frames) {
      while (a.bufferedAmount > 1024 * 1024) await new Promise((r) => setTimeout(r, 10));
      expect(a.send(f)).toBe(true);
    }
    const start = Date.now();
    while (got.length < 41 && Date.now() - start < 15_000)
      await new Promise((r) => setTimeout(r, 20));
    expect(got[0]).toBe('{"t":"hashes"}');
    expect(got.slice(1).map((m) => (m as Uint8Array)[0])).toEqual(frames.map((_, i) => i));
    expect((got[1] as Uint8Array).length).toBe(48 * 1024 + 9);
  });

  it('closing one side closes the other', async () => {
    const [a, b] = await pair();
    let closed = false;
    b.on('close', () => (closed = true));
    a.close();
    const start = Date.now();
    while (!closed && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
  });

  it('is never handed a TURN server', () => {
    let seen: RTCConfiguration | undefined;
    class Spy {
      constructor(config: RTCConfiguration) {
        seen = config;
      }
      close() {}
    }
    const link = webrtcFileLinks(Spy as unknown as typeof globalThis.RTCPeerConnection)({
      self: 'a',
      remote: 'b',
      iceServers: [
        { urls: 'stun:example.org:3478' },
        { urls: 'turn:example.org:3478' },
        { urls: 'turns:example.org:443' },
      ],
    });
    link.close();
    expect(seen?.iceServers).toEqual([{ urls: 'stun:example.org:3478' }]);
  });
});
