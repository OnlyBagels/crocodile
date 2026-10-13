import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startStunServer } from '@crocodile/coordinator';
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  useAudioLevelIndication,
  useNACK,
  usePLI,
  type RTCDataChannel,
  type RTCRtpTransceiver,
} from 'werift';
import { createIdentity, signSdp, verifySdp, type Identity } from '@crocodile/crypto';
import {
  SCREEN_AUDIO_SLOTS,
  VIDEO_SLOTS,
  type RelayToClient,
  type SignalData,
} from '@crocodile/protocol';
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
  /** Adds video to the connection, as the app does once the host offers it. */
  addVideo(): Promise<VideoPeer>;
}

interface VideoPeer {
  camera: RTCRtpTransceiver;
  screen: RTCRtpTransceiver;
  screenAudio: RTCRtpTransceiver;
  slots: RTCRtpTransceiver[];
  video: { slot: number; seq: number; payload: Buffer }[];
  sound: { slot: number; payload: Buffer }[];
  /** Picture loss reports (key frame requests) the relay sent us, per source. */
  plis: { camera: number; screen: number };
  /** Sends one packet of a VP8 frame (a key frame or not) from the camera or screen. */
  sendVideo(kind: 'camera' | 'screen', opts: { key: boolean; body?: Buffer }): void;
  sendScreenAudio(payload: Buffer): void;
}

const VP8 = () =>
  new RTCRtpCodecParameters({
    mimeType: 'video/VP8',
    clockRate: 90000,
    rtcpFeedback: [useNACK(), usePLI()],
  });

/** A VP8 packet: payload descriptor with a 15-bit picture id, then the frame. */
function vp8(pictureId: number, key: boolean, body: Buffer) {
  return Buffer.concat([
    Buffer.from([0x90, 0x80, 0x80 | ((pictureId >> 8) & 0x7f), pictureId & 0xff, key ? 0 : 1]),
    body,
  ]);
}

const lastMedia = (p: { inbox: RelayToClient[] }) =>
  p.inbox.filter((m): m is Extract<RelayToClient, { t: 'media' }> => m.t === 'media').at(-1);

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
      video: [VP8()],
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
    async addVideo() {
      const camera = pc.addTransceiver('video', { direction: 'sendonly' });
      const screen = pc.addTransceiver('video', { direction: 'sendonly' });
      const screenAudio = pc.addTransceiver('audio', { direction: 'sendonly' });
      const video: VideoPeer['video'] = [];
      const sound: VideoPeer['sound'] = [];
      const slots: RTCRtpTransceiver[] = [];
      for (let i = 0; i < VIDEO_SLOTS; i++) {
        const t = pc.addTransceiver('video', { direction: 'recvonly' });
        slots.push(t);
        t.onTrack.subscribe((track) =>
          track.onReceiveRtp.subscribe((rtp) =>
            video.push({ slot: i, seq: rtp.header.sequenceNumber, payload: rtp.payload }),
          ),
        );
      }
      for (let i = 0; i < SCREEN_AUDIO_SLOTS; i++) {
        const t = pc.addTransceiver('audio', { direction: 'recvonly' });
        t.onTrack.subscribe((track) =>
          track.onReceiveRtp.subscribe((rtp) => sound.push({ slot: i, payload: rtp.payload })),
        );
      }
      const plis = { camera: 0, screen: 0 };
      camera.sender.onPictureLossIndication.subscribe(() => plis.camera++);
      screen.sender.onPictureLossIndication.subscribe(() => plis.screen++);
      await pc.setLocalDescription(await pc.createOffer());
      const answers = inbox.filter((m) => m.t === 'answer').length;
      dc.send(JSON.stringify({ t: 'renegotiate', sdp: pc.localDescription!.sdp }));
      const answer = await waitFor(
        () =>
          inbox.filter((m) => m.t === 'answer').length > answers &&
          (inbox.filter((m) => m.t === 'answer').at(-1) as { sdp: string }),
      );
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      const seqs = { camera: 1, screen: 1 };
      const pics = { camera: 100, screen: 5000 };
      let audioSeq = 1;
      return {
        camera,
        screen,
        screenAudio,
        slots,
        video,
        sound,
        plis,
        sendVideo(kind, { key, body }) {
          const header = new RtpHeader({
            sequenceNumber: seqs[kind]++,
            timestamp: seqs[kind] * 3000,
            payloadType: 96,
            marker: true,
          });
          const payload = vp8(pics[kind]++, key, body ?? Buffer.from(`frame-${kind}-0123456789`));
          void (kind === 'camera' ? camera : screen).sender.sendRtp(new RtpPacket(header, payload));
        },
        sendScreenAudio(payload) {
          const header = new RtpHeader({
            sequenceNumber: audioSeq++,
            timestamp: audioSeq * 960,
            payloadType: 111,
            marker: false,
          });
          void screenAudio.sender.sendRtp(new RtpPacket(header, payload));
        },
      };
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

  it('sends a camera only to those who watch it, from a key frame on', async () => {
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
    const a = await joinRelay(relay, host, host, deliver);
    const b = await joinRelay(relay, host, createIdentity(), deliver);
    const c = await joinRelay(relay, host, createIdentity(), deliver);
    // The host says it carries video; members add it to their connections.
    const hello = c.inbox.find((m) => m.t === 'hello') as Extract<RelayToClient, { t: 'hello' }>;
    expect(hello.media).toEqual({ video: VIDEO_SLOTS, audio: SCREEN_AUDIO_SLOTS });
    const [av, bv, cv] = await Promise.all([a.addVideo(), b.addVideo(), c.addVideo()]);

    const cam = `${P(b.identity)}:camera`;
    b.dc.send(JSON.stringify({ t: 'state', muted: false, deafened: false, camera: true }));
    await waitFor(() => c.inbox.some((m) => m.t === 'peer_state' && m.peer.camera));
    c.dc.send(JSON.stringify({ t: 'watch', streams: [cam] }));
    await waitFor(() => lastMedia(c)?.video[0] === cam);
    expect(lastMedia(c)!.paused).toEqual([]);

    // Until a key frame, nothing reaches C (it couldn't decode it), and the
    // relay asks B's camera for one.
    await waitFor(() => {
      bv.sendVideo('camera', { key: false });
      return bv.plis.camera > 0;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(cv.video).toHaveLength(0);
    bv.sendVideo('camera', { key: true, body: Buffer.from('key-frame-opaque') });
    for (let i = 0; i < 4; i++) bv.sendVideo('camera', { key: false, body: Buffer.from(`d${i}`) });
    await waitFor(() => cv.video.length >= 5);
    expect(cv.video.every((v) => v.slot === 0)).toBe(true);
    // The frame is untouched past the descriptor; sequence numbers run on.
    expect(cv.video[0]!.payload.subarray(5).toString()).toBe('key-frame-opaque');
    const seqs = cv.video.map((v) => v.seq);
    expect(seqs.slice(1).every((s, i) => s === ((seqs[i]! + 1) & 0xffff))).toBe(true);
    // A didn't ask for it.
    expect(av.video).toHaveLength(0);

    // C's decoder lost the picture: the relay asks B's camera again.
    const before = bv.plis.camera;
    await new Promise((r) => setTimeout(r, 350));
    const ssrc = (cv.slots[0]!.receiver.tracks[0] as { ssrc: number }).ssrc;
    await cv.slots[0]!.receiver.sendRtcpPLI(ssrc);
    await waitFor(() => bv.plis.camera > before);

    // B turns the camera off: C's slot is freed.
    b.dc.send(JSON.stringify({ t: 'state', muted: false, deafened: false }));
    await waitFor(() => lastMedia(c)?.video[0] === null);
  });

  it("brings a watched screen's sound along with it", async () => {
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
    const a = await joinRelay(relay, host, host, deliver);
    const b = await joinRelay(relay, host, createIdentity(), deliver);
    const [av, bv] = await Promise.all([a.addVideo(), b.addVideo()]);
    const screen = `${P(a.identity)}:screen`;
    a.dc.send(
      JSON.stringify({ t: 'state', muted: false, deafened: false, screen: { audio: true } }),
    );
    await waitFor(() => b.inbox.some((m) => m.t === 'peer_state' && m.peer.screen?.audio));
    // Not watching: no sound either.
    for (let i = 0; i < 5; i++) av.sendScreenAudio(Buffer.from('music'));
    await new Promise((r) => setTimeout(r, 200));
    expect(bv.sound).toHaveLength(0);
    b.dc.send(JSON.stringify({ t: 'watch', streams: [screen] }));
    await waitFor(() => lastMedia(b)?.audio[0] === screen && lastMedia(b)?.video[0] === screen);
    await waitFor(() => {
      av.sendScreenAudio(Buffer.from('music'));
      return bv.sound.length > 3;
    });
    expect(bv.sound.every((s) => s.slot === 0 && s.payload.toString() === 'music')).toBe(true);
  });

  it("holds back what doesn't fit in the host's upload, and says so", async () => {
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
      // Room for one camera.
      videoKbps: 1200,
    });
    closers.push(() => relay.close());
    const a = await joinRelay(relay, host, host, deliver);
    const b = await joinRelay(relay, host, createIdentity(), deliver);
    const c = await joinRelay(relay, host, createIdentity(), deliver);
    await Promise.all([a.addVideo(), b.addVideo(), c.addVideo()]);
    for (const p of [a, b])
      p.dc.send(JSON.stringify({ t: 'state', muted: false, deafened: false, camera: true }));
    await waitFor(
      () => c.inbox.filter((m) => m.t === 'peer_state' && m.peer.camera).length >= 2,
    );
    const first = `${P(b.identity)}:camera`;
    const second = `${P(a.identity)}:camera`;
    c.dc.send(JSON.stringify({ t: 'watch', streams: [first, second] }));
    await waitFor(() => lastMedia(c)?.video.includes(first));
    expect(lastMedia(c)!.video).not.toContain(second);
    expect(lastMedia(c)!.paused).toEqual([second]);
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
