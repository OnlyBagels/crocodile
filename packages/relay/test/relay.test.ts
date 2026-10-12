import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startStunServer } from '@crocodile/coordinator';
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  useAudioLevelIndication,
  type RTCDataChannel,
} from 'werift';
import { createIdentity, signSdp, verifySdp, type Identity } from '@crocodile/crypto';
import type { RelayToClient, SignalData } from '@crocodile/protocol';
import { HostRelay } from '../src';

/** Peer id of an identity's (single) test device. */
const P = (id: Identity) => `${id.userId}.testdevicex`;
const SESSION = 'voice:aaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbb';
const SLOTS = 3;

interface TestPeer {
  identity: Identity;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  inbox: RelayToClient[];
  received: { slot: number; payload: Buffer }[];
  send(payload: Buffer, level: number): void;
}

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

// werift falls back to Google's STUN server when given none, which stalls
// gathering in sandboxes without internet; point it at a local responder.
let stunPort = 0;
const stun = () => [{ urls: `stun:127.0.0.1:${stunPort}` }];
beforeAll(async () => {
  const socket = await startStunServer(0, '127.0.0.1');
  stunPort = (socket.address() as AddressInfo).port;
  return () => socket.close();
});

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function joinRelay(
  relay: HostRelay,
  host: Identity,
  identity: Identity,
  deliver: Map<string, (d: SignalData) => void>,
): Promise<TestPeer> {
  const pc = new RTCPeerConnection({
    codecs: {
      audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 })],
    },
    headerExtensions: { audio: [useAudioLevelIndication()] },
    iceAdditionalHostAddresses: ['127.0.0.1'],
    iceServers: stun(),
  });
  closers.push(() => pc.close());
  const up = pc.addTransceiver('audio', { direction: 'sendonly' });
  const received: TestPeer['received'] = [];
  for (let i = 0; i < SLOTS; i++) {
    const t = pc.addTransceiver('audio', { direction: 'recvonly' });
    t.onTrack.subscribe((track) =>
      track.onReceiveRtp.subscribe((rtp) => received.push({ slot: i, payload: rtp.payload })),
    );
  }
  const dc = pc.createDataChannel('croc');
  const inbox: RelayToClient[] = [];
  dc.onMessage.subscribe((m) => inbox.push(JSON.parse(m.toString())));

  const early: unknown[] = [];
  let answered = false;
  deliver.set(P(identity), async (data) => {
    if (data.type === 'answer') {
      expect(verifySdp(data, { sessionId: SESSION, from: P(host), to: P(identity) })).toBe(true);
      await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      answered = true;
      for (const c of early.splice(0)) await pc.addIceCandidate(c as never);
    } else if (data.type === 'candidate') {
      if (answered) await pc.addIceCandidate(data.candidate as never);
      else early.push(data.candidate);
    }
  });
  pc.onIceCandidate.subscribe((c) => {
    if (c?.candidate) {
      void relay.handleSignal(P(identity), {
        type: 'candidate',
        epoch: 1,
        dir: 'toRelay',
        candidate: {
          candidate: c.candidate,
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
        },
      });
    }
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await relay.handleSignal(
    P(identity),
    signSdp(
      identity,
      'offer',
      { sessionId: SESSION, epoch: 1, from: P(identity), to: P(host) },
      pc.localDescription!.sdp,
    ),
  );
  await waitFor(() => dc.readyState === 'open' && inbox.some((m) => m.t === 'hello'));

  const extId = Number(
    pc.localDescription!.sdp.match(
      /a=extmap:(\d+) urn:ietf:params:rtp-hdrext:ssrc-audio-level/,
    )![1],
  );
  let seq = 1;
  let ts = 0;
  return {
    identity,
    pc,
    dc,
    inbox,
    received,
    send(payload, level) {
      const header = new RtpHeader({
        sequenceNumber: seq++,
        timestamp: (ts += 960),
        payloadType: 111,
        marker: false,
      });
      header.extensions = [{ id: extId, payload: Buffer.from([level]) }];
      void up.sender.sendRtp(new RtpPacket(header, payload));
    },
  };
}

describe('HostRelay', () => {
  it('routes data channel messages and forwards the active speaker to others', async () => {
    const host = createIdentity();
    const deliver = new Map<string, (d: SignalData) => void>();
    const relay = new HostRelay({
      sessionId: SESSION,
      epoch: 1,
      identity: host,
      hostPeer: P(host),
      slots: SLOTS,
      iceServers: stun(),
      includeLoopback: true,
      sendSignal: (to, data) => void deliver.get(to)?.(data),
    });
    closers.push(() => relay.close());

    const a = await joinRelay(relay, host, host, deliver); // the host's own client
    const b = await joinRelay(relay, host, createIdentity(), deliver);
    const c = await joinRelay(relay, host, createIdentity(), deliver);
    expect(relay.connectedPeerIds()).toHaveLength(3);
    const helloC = c.inbox.find((m) => m.t === 'hello') as Extract<RelayToClient, { t: 'hello' }>;
    expect(helloC.peers.map((p) => p.id).sort()).toEqual([P(a.identity), P(b.identity)].sort());
    expect(helloC.host).toBe(P(host));

    b.dc.send(JSON.stringify({ t: 'bcast', d: { k: 'x' } }));
    c.dc.send(JSON.stringify({ t: 'direct', to: P(a.identity), d: { k: 'secret' } }));
    await waitFor(() => a.inbox.some((m) => m.t === 'msg' && m.direct));
    await waitFor(() => c.inbox.some((m) => m.t === 'msg' && m.from === P(b.identity)));
    expect(b.inbox.some((m) => m.t === 'msg' && m.direct)).toBe(false);

    // Wait for media to connect, then have A talk.
    const frame = Buffer.from('opaque-e2ee-frame-payload-0123456789');
    await waitFor(() => {
      a.send(frame, 20);
      return b.received.length > 3 && c.received.length > 3;
    });
    expect(b.received.at(-1)!.payload.equals(frame)).toBe(true);
    expect(a.received).toHaveLength(0);
    const slots = b.inbox.filter((m) => m.t === 'slots').at(-1) as Extract<
      RelayToClient,
      { t: 'slots' }
    >;
    expect(slots.map).toContain(P(a.identity));
    await waitFor(() => b.inbox.some((m) => m.t === 'speaking' && m.users.includes(P(a.identity))));

    // Silence from a speaker without a slot is not forwarded.
    const before = a.received.length;
    for (let i = 0; i < 5; i++) b.send(Buffer.from('quiet'), 127);
    await new Promise((r) => setTimeout(r, 200));
    expect(a.received.length).toBe(before);

    // Deafened listeners get nothing.
    c.dc.send(JSON.stringify({ t: 'state', muted: false, deafened: true }));
    await waitFor(() => b.inbox.some((m) => m.t === 'peer_state' && m.peer.deafened));
    const cCount = c.received.length;
    for (let i = 0; i < 5; i++) a.send(frame, 20);
    await new Promise((r) => setTimeout(r, 200));
    expect(c.received.length).toBe(cCount);

    // Whether a member is in the call, and its latency to the host, reach everyone.
    c.dc.send(JSON.stringify({ t: 'state', muted: false, deafened: true, voice: true, rtt: 42 }));
    await waitFor(() =>
      b.inbox.some((m) => m.t === 'peer_state' && m.peer.voice === true && m.peer.rtt === 42),
    );

    // Leaving members say goodbye through signalling (crashes are caught by ICE consent checks).
    await relay.handleSignal(P(c.identity), { type: 'bye', epoch: 1, dir: 'toRelay' });
    await c.pc.close();
    await waitFor(() => a.inbox.some((m) => m.t === 'peer_leave' && m.peer === P(c.identity)));
  });

  it('keeps a member whose new offer replaced one still being answered', async () => {
    const host = createIdentity();
    let toBob: (d: SignalData) => void = () => {};
    const relay = new HostRelay({
      sessionId: SESSION,
      epoch: 1,
      identity: host,
      hostPeer: P(host),
      slots: SLOTS,
      iceServers: stun(),
      includeLoopback: true,
      sendSignal: (_to, data) => toBob(data),
    });
    closers.push(() => relay.close());
    const bob = createIdentity();
    const offer = (sdp: string) =>
      signSdp(bob, 'offer', { sessionId: SESSION, epoch: 1, from: P(bob), to: P(host) }, sdp);
    // Two offers from Bob's app, the second sent before the first is answered.
    const second = new RTCPeerConnection({
      iceServers: stun(),
      iceAdditionalHostAddresses: ['127.0.0.1'],
    });
    closers.push(() => second.close());
    second.addTransceiver('audio', { direction: 'sendonly' });
    for (let i = 0; i < SLOTS; i++) second.addTransceiver('audio', { direction: 'recvonly' });
    const dc = second.createDataChannel('croc');
    await second.setLocalDescription(await second.createOffer());
    let answered = false;
    const early: unknown[] = [];
    toBob = (data) => {
      if (data.type === 'answer') {
        void second.setRemoteDescription({ type: 'answer', sdp: data.sdp }).then(async () => {
          answered = true;
          for (const c of early.splice(0)) await second.addIceCandidate(c as never);
        });
      } else if (data.type === 'candidate') {
        if (answered) void second.addIceCandidate(data.candidate as never).catch(() => {});
        else early.push(data.candidate);
      }
    };
    second.onIceCandidate.subscribe((c) => {
      if (c?.candidate)
        void relay.handleSignal(P(bob), {
          type: 'candidate',
          epoch: 1,
          dir: 'toRelay',
          candidate: {
            candidate: c.candidate,
            sdpMid: c.sdpMid ?? null,
            sdpMLineIndex: c.sdpMLineIndex ?? null,
          },
        });
    });
    // The relay fails to take the first offer a moment after the second came.
    const proto = RTCPeerConnection.prototype;
    const setRemote = proto.setRemoteDescription;
    proto.setRemoteDescription = async function (this: RTCPeerConnection, d) {
      if (d.sdp?.includes('a=x-test-fail')) {
        await new Promise((r) => setTimeout(r, 100));
        throw new Error('cannot answer this offer');
      }
      return setRemote.call(this, d);
    };
    closers.push(async () => void (proto.setRemoteDescription = setRemote));
    void relay.handleSignal(P(bob), offer(`${second.localDescription!.sdp}a=x-test-fail\r\n`));
    void relay.handleSignal(P(bob), offer(second.localDescription!.sdp));
    await waitFor(() => dc.readyState === 'open');
    await new Promise((r) => setTimeout(r, 1000));
    expect(relay.connectedPeerIds()).toEqual([P(bob)]);
  });

  it('rejects offers whose signature does not match the sender', async () => {
    const host = createIdentity();
    const mallory = createIdentity();
    const victim = createIdentity();
    const sent: SignalData[] = [];
    const relay = new HostRelay({
      sessionId: SESSION,
      epoch: 1,
      identity: host,
      hostPeer: P(host),
      slots: 1,
      iceServers: [],
      sendSignal: (_to, d) => sent.push(d),
    });
    closers.push(() => relay.close());
    const offer = signSdp(
      mallory,
      'offer',
      { sessionId: SESSION, epoch: 1, from: P(mallory), to: P(host) },
      'v=0',
    );
    await relay.handleSignal(P(victim), offer);
    expect(relay.peerIds()).toEqual([]);
    expect(sent).toEqual([]);
  });
});
