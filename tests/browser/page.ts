/**
 * Browser test harness: a real CrocodileClient running in Chromium with real
 * WebRTC, microphone (Chromium's fake device) and the E2EE frame worker. The
 * host relay runs in Node behind exposed bindings, exactly like the desktop
 * app runs it in a utility process behind IPC.
 */
import {
  CrocodileClient,
  MemoryFileBlockStore,
  MemoryKeyValueStore,
  MemoryMessageStore,
  VoiceEngine,
  networkVerdict,
  probeNetwork,
  routeFromStats,
  type HostRelayAdapter,
  type RelayHandle,
} from '@crocodile/client-core';
import { toB64u, type SignalData } from '@crocodile/protocol';

declare global {
  interface Window {
    croc: CrocodileClient;
    routeFromStats: typeof routeFromStats;
    checkNetwork(stun: string[]): Promise<string>;
    __relayStart(opts: {
      seed: string;
      hostPeer: string;
      sessionId: string;
      epoch: number;
      slots: number;
      iceServers: { urls: string }[];
    }): Promise<string>;
    __relaySignalIn(handle: string, from: string, data: SignalData): Promise<void>;
    __relayMembers(handle: string, members: string[]): Promise<void>;
    __relayClose(handle: string): Promise<void>;
    __relaySignalOut(handle: string, to: string, data: SignalData): void;
    startClient(opts: {
      server: string;
      name: string;
      canHost: boolean;
      nat: string;
    }): Promise<string>;
    audioStats(): Promise<
      { packets: number; energy: number; concealed: number; samples: number }[]
    >;
  }
}

const outbound = new Map<string, (to: string, data: SignalData) => void>();
window.__relaySignalOut = (handle, to, data) => outbound.get(handle)?.(to, data);

const relay: HostRelayAdapter = {
  async start(opts) {
    const handle = await window.__relayStart({
      seed: toB64u(opts.identity.seed),
      hostPeer: opts.hostPeer,
      sessionId: opts.sessionId,
      epoch: opts.epoch,
      slots: opts.slots,
      iceServers: opts.iceServers,
    });
    outbound.set(handle, opts.sendSignal);
    const push = () => void window.__relayMembers(handle, opts.members());
    push();
    const timer = setInterval(push, 500);
    return {
      handleSignal: (from, data) => {
        push();
        void window.__relaySignalIn(handle, from, data);
      },
      close: async () => {
        clearInterval(timer);
        outbound.delete(handle);
        await window.__relayClose(handle);
      },
    } satisfies RelayHandle;
  },
};

const peerConnections: RTCPeerConnection[] = [];
class TrackedPC extends RTCPeerConnection {
  constructor(config?: RTCConfiguration) {
    super(config);
    peerConnections.push(this);
  }
}

/** Deterministic "microphone": a 440 Hz tone (Chromium's fake device may be silent). */
async function toneMicrophone(): Promise<MediaStream> {
  const ctx = new AudioContext();
  await ctx.resume().catch(() => {});
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.3;
  osc.frequency.value = 440;
  const dst = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dst);
  osc.start();
  return dst.stream;
}

window.routeFromStats = routeFromStats;
window.checkNetwork = async (stun) => networkVerdict(await probeNetwork(RTCPeerConnection, stun));

window.startClient = async ({ server, name, canHost, nat }) => {
  const client = new CrocodileClient(
    {
      platform: canHost ? 'desktop' : 'web',
      appVersion: 'browser-test',
      kv: new MemoryKeyValueStore(),
      messages: new MemoryMessageStore(),
      files: new MemoryFileBlockStore(),
      ...(canHost ? { relay } : {}),
      rtc: {
        RTCPeerConnection: TrackedPC,
        getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      },
      capabilities: async () => ({ nat: nat as never, cpuCores: 8 }),
    },
    {
      directories: [],
      preferredServers: [server],
      log: (m, e) => console.log(`[${name}] ${m} ${JSON.stringify(e ?? {})}`),
    },
  );
  client.voiceEngine = new VoiceEngine(
    {
      getUserMedia: () => toneMicrophone(),
      createFrameWorker: () => new Worker('/frame-worker.js'),
    },
    { vadThresholdDb: -100 },
  );
  window.croc = client;
  await client.init();
  await client.createAccount(name);
  return client.userId;
};

window.audioStats = async () => {
  const out: { packets: number; energy: number; concealed: number; samples: number }[] = [];
  for (const pc of peerConnections) {
    if (pc.connectionState === 'closed') continue;
    const stats = await pc.getStats();
    stats.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        out.push({
          packets: s.packetsReceived ?? 0,
          energy: s.totalAudioEnergy ?? 0,
          concealed: s.concealedSamples ?? 0,
          samples: s.totalSamplesReceived ?? 0,
        });
      }
    });
  }
  return out;
};
