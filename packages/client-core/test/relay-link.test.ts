import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity, signSdp } from '@crocodile/crypto';
import type { SignalData } from '@crocodile/protocol';
import { RelayLink, linkStatsFrom, type FailStage } from '../src/relay-link';

/** Enough of RTCPeerConnection for RelayLink; the test drives its states. */
class FakePc {
  static last: FakePc;
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: { sdp: string } | null = null;
  signalingState = 'stable';
  sctp = { maxMessageSize: 65_536 };
  offerSdp = 'v=0 offer';
  transceivers: FakeTransceiver[] = [];
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicecandidate: (() => void) | null = null;
  ontrack: (() => void) | null = null;
  closed = false;
  dc = {
    readyState: 'connecting',
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onmessage: null as ((ev: { data: string }) => void) | null,
    sent: [] as string[],
    send(m: string) {
      this.sent.push(m);
    },
    close() {},
  };
  constructor() {
    FakePc.last = this;
  }
  createDataChannel() {
    return this.dc;
  }
  addTransceiver(kind: string, init: { direction: string }) {
    const t = new FakeTransceiver(kind, init.direction);
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return [];
  }
  async createOffer() {
    return { type: 'offer', sdp: this.offerSdp };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    if (d.type === 'rollback') this.signalingState = 'stable';
    else {
      this.localDescription = d;
      if (d.type === 'offer') this.signalingState = 'have-local-offer';
    }
  }
  async setRemoteDescription() {
    this.signalingState = 'stable';
  }
  async addIceCandidate() {}
  async getStats() {
    return new Map();
  }
  close() {
    this.closed = true;
  }
  ice(state: string) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
  conn(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  open() {
    this.dc.readyState = 'open';
    this.dc.onopen?.();
  }
}

class FakeTransceiver {
  sender = {};
  receiver = {};
  codecs: string[] | null = null;
  stopped = false;
  constructor(
    readonly kind: string,
    readonly direction: string,
  ) {}
  setCodecPreferences(codecs: { mimeType: string }[]) {
    this.codecs = codecs.map((c) => c.mimeType);
  }
  stop() {
    this.stopped = true;
  }
}

const me = createIdentity();
const host = createIdentity();
const self = `${me.userId}.dev1`;
const hostPeer = `${host.userId}.dev1`;

function link(opts: { connectTimeoutMs?: number } = {}) {
  const sent: SignalData[] = [];
  const l = new RelayLink({
    RTCPeerConnection: FakePc as unknown as typeof RTCPeerConnection,
    identity: me,
    self,
    sessionId: 'dm:x',
    epoch: 1,
    host: hostPeer,
    iceServers: [],
    slots: 0,
    sendSignal: async (d) => void sent.push(d),
    ...opts,
  });
  const steps: string[] = [];
  const failed: { reason: string; stage?: FailStage }[] = [];
  l.on('progress', ({ step }) => steps.push(step));
  l.on('failed', (f) => failed.push(f));
  return { l, sent, steps, failed, pc: () => FakePc.last };
}

const answer = () =>
  signSdp(host, 'answer', { sessionId: 'dm:x', epoch: 1, from: hostPeer, to: self }, 'v=0 answer');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A link that is connected to its host. */
async function open() {
  const a = link();
  await a.l.connect();
  await a.l.handleSignal(answer());
  a.pc().ice('connected');
  a.pc().conn('connected');
  a.pc().open();
  return a;
}

describe('connection to the host', () => {
  it('reports each step, and where a failed connection got stuck', async () => {
    vi.useFakeTimers();
    // The host never answers.
    const a = link({ connectTimeoutMs: 1000 });
    await a.l.connect();
    vi.advanceTimersByTime(1000);
    expect(a.steps).toEqual(['offer']);
    expect(a.failed).toEqual([{ reason: 'timed out connecting to host', stage: 'no-answer' }]);

    // It answers, but no network path works.
    const b = link({ connectTimeoutMs: 1000 });
    await b.l.connect();
    await b.l.handleSignal(answer());
    vi.advanceTimersByTime(1000);
    expect(b.steps).toEqual(['offer', 'answer']);
    expect(b.failed[0]!.stage).toBe('no-path');

    // A path, but the channel never opens.
    const c = link({ connectTimeoutMs: 1000 });
    await c.l.connect();
    await c.l.handleSignal(answer());
    c.pc().ice('connected');
    vi.advanceTimersByTime(1000);
    expect(c.steps).toEqual(['offer', 'answer', 'path']);
    expect(c.failed[0]!.stage).toBe('no-channel');

    // An answer signed by someone else.
    const d = link();
    await d.l.connect();
    await d.l.handleSignal(
      signSdp(me, 'answer', { sessionId: 'dm:x', epoch: 1, from: hostPeer, to: self }, 'v=0'),
    );
    expect(d.failed[0]!.stage).toBe('rejected');
  });

  it("counts a connection as lost after a few seconds of 'disconnected', not WebRTC's 30", async () => {
    vi.useFakeTimers();
    const a = link();
    await a.l.connect();
    await a.l.handleSignal(answer());
    a.pc().ice('connected');
    a.pc().conn('connected');
    a.pc().open();
    expect(a.steps).toEqual(['offer', 'answer', 'path', 'open']);
    // A short blip recovers on its own.
    a.pc().conn('disconnected');
    vi.advanceTimersByTime(5000);
    a.pc().conn('connected');
    vi.advanceTimersByTime(10_000);
    expect(a.failed).toEqual([]);
    // A longer one ends the connection, so the session reconnects.
    a.pc().conn('disconnected');
    vi.advanceTimersByTime(8000);
    expect(a.failed).toEqual([
      { reason: 'no answer from the host for a few seconds', stage: 'lost' },
    ]);
    expect(a.pc().closed).toBe(true);
  });

  it('says the host left when it closes the relay', async () => {
    const a = link();
    await a.l.connect();
    await a.l.handleSignal(answer());
    await a.l.handleSignal({ type: 'bye', epoch: 1, dir: 'toClient' });
    expect(a.failed[0]!.stage).toBe('host-left');
  });

  it('adds video offering only what the host forwards, so the offer fits in one message', async () => {
    // Desktop Chromium knows many codecs; a dozen m-lines with all of them
    // made an offer larger than a data channel message.
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: (kind: string) => ({
        codecs:
          kind === 'video'
            ? ['video/VP8', 'video/rtx', 'video/VP9', 'video/H264', 'video/AV1'].map(
                (mimeType) => ({
                  mimeType,
                }),
              )
            : ['audio/opus', 'audio/red', 'audio/G722', 'audio/telephone-event'].map(
                (mimeType) => ({ mimeType }),
              ),
      }),
    });
    const a = await open();
    const media = vi.fn();
    a.l.on('media', media);
    const adding = a.l.addMedia({ video: 3, audio: 2 });
    await vi.waitFor(() => expect(a.pc().dc.sent).toHaveLength(1));
    expect(JSON.parse(a.pc().dc.sent[0]!)).toEqual({ t: 'renegotiate', sdp: 'v=0 offer' });
    const added = a.pc().transceivers;
    expect(added.map((t) => `${t.kind} ${t.direction}`)).toEqual([
      'video sendonly',
      'video sendonly',
      'audio sendonly',
      'video recvonly',
      'video recvonly',
      'video recvonly',
      'audio recvonly',
      'audio recvonly',
    ]);
    for (const t of added)
      expect(t.codecs).toEqual([t.kind === 'video' ? 'video/VP8' : 'audio/opus']);
    a.pc().dc.onmessage?.({ data: JSON.stringify({ t: 'answer', sdp: 'v=0 answer' }) });
    await adding;
    expect(a.l.media).toBe(true);
    expect(media).toHaveBeenCalledOnce();
  });

  it('goes back to voice only when video could not be added', async () => {
    vi.useFakeTimers();
    // An offer the channel can't carry is not sent at all.
    const a = await open();
    a.pc().offerSdp = 'x'.repeat(70_000);
    await expect(a.l.addMedia({ video: 9, audio: 2 })).rejects.toThrow(/too large/);
    expect(a.pc().dc.sent).toEqual([]);
    expect(a.pc().signalingState).toBe('stable');
    expect(a.pc().transceivers.every((t) => t.stopped)).toBe(true);
    expect(a.l.media).toBe(false);
    // Nothing is left waiting for an answer to go unhandled later.
    await vi.advanceTimersByTimeAsync(20_000);

    // The host never answers.
    const b = await open();
    const adding = b.l.addMedia({ video: 1, audio: 1 });
    const failed = expect(adding).rejects.toThrow('the host did not answer');
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(b.pc().signalingState).toBe('stable');
    expect(b.l.isOpen).toBe(true);
  });

  it('summarises WebRTC stats for the debug panel', () => {
    const stats = new Map<string, Record<string, unknown>>([
      [
        't',
        {
          id: 't',
          type: 'transport',
          selectedCandidatePairId: 'p',
          bytesSent: 900,
          bytesReceived: 1200,
        },
      ],
      [
        'p',
        {
          id: 'p',
          type: 'candidate-pair',
          localCandidateId: 'l',
          remoteCandidateId: 'r',
          currentRoundTripTime: 0.042,
        },
      ],
      [
        'l',
        {
          id: 'l',
          type: 'local-candidate',
          candidateType: 'srflx',
          protocol: 'udp',
          address: '198.51.100.7',
        },
      ],
      [
        'r',
        {
          id: 'r',
          type: 'remote-candidate',
          candidateType: 'host',
          protocol: 'udp',
          address: '203.0.113.9',
        },
      ],
      [
        'a1',
        {
          id: 'a1',
          type: 'inbound-rtp',
          kind: 'audio',
          packetsReceived: 500,
          packetsLost: 5,
          jitter: 0.004,
        },
      ],
      [
        'a2',
        {
          id: 'a2',
          type: 'inbound-rtp',
          kind: 'audio',
          packetsReceived: 100,
          packetsLost: 1,
          jitter: 0.012,
        },
      ],
    ]);
    expect(linkStatsFrom(stats as unknown as RTCStatsReport)).toEqual({
      route: 'internet',
      local: { type: 'srflx', protocol: 'udp', address: '198.51.100.7' },
      remote: { type: 'host', protocol: 'udp', address: '203.0.113.9' },
      rttMs: 42,
      bytesSent: 900,
      bytesReceived: 1200,
      audio: { packetsReceived: 600, packetsLost: 6, jitterMs: 12 },
    });
  });
});
