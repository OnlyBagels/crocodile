import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CrocodileClient,
  Emitter,
  MemoryKeyValueStore,
  MemoryMessageStore,
  type OutgoingVideo,
  type PlatformAdapter,
  type ScreenRequest,
  type VoiceEngine,
} from '@crocodile/client-core';
import type { Coordinator } from '@crocodile/coordinator';
import { sessionIds, streamIds } from '@crocodile/protocol';
import { FakeRelayNetwork } from './helpers/fake-relay';
import { startCoordinator, waitFor } from './helpers';

/**
 * Video in calls, as the client sees it: what it sends, what it asks the
 * host for, and what it shows. Real media (capture, encryption, the relay
 * forwarding VP8) is covered by tests/browser.test.ts and the relay's tests.
 */

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(overrides = {}) {
  const c = await startCoordinator(overrides);
  cleanup.push(() => c.stop());
  return c;
}

function makeClient(
  net: FakeRelayNetwork,
  coordinator: Coordinator,
  opts: { canHost?: boolean } = {},
) {
  const platform: PlatformAdapter = {
    platform: opts.canHost === false ? 'web' : 'desktop',
    appVersion: 'test',
    kv: new MemoryKeyValueStore(),
    messages: new MemoryMessageStore(),
    ...(opts.canHost === false ? {} : { relay: net.adapter() }),
    capabilities: async () => ({ nat: 'cone', cpuCores: 8 }),
  };
  const client = new CrocodileClient(platform, {
    directories: [],
    preferredServers: [coordinator.url],
    transportFactory: net.transportFactory(),
    log: process.env.DBG ? (m, e) => console.log('client', m, JSON.stringify(e)) : undefined,
  });
  cleanup.push(() => client.shutdown());
  return client;
}

async function signUp(client: CrocodileClient, name: string) {
  await client.init();
  await client.createAccount(name);
  await waitFor(() => client.state.link === 'connected' && client.state.me, 5000, `${name} up`);
  return client;
}

/** A track stand-in: what the client hands to the connection. */
const fakeTrack = (label: string) => ({ label, kind: 'video', stop: () => {} });

/** A voice engine with a camera and a screen, but no real devices. */
function videoVoice() {
  const e = new Emitter<{ video: OutgoingVideo }>();
  let out: OutgoingVideo = { camera: null, screen: null };
  const set = (next: OutgoingVideo) => {
    out = next;
    e.emit('video', out);
  };
  return Object.assign(e, {
    start: async () => {},
    stop: () => {},
    stopSession: () => {},
    setMuted: () => {},
    setDeafened: () => {},
    playSlot: () => {},
    micTrack: () => null,
    frameCrypto: () => undefined,
    canShareScreen: true,
    outgoing: () => out,
    startCamera: async () => set({ ...out, camera: fakeTrack('camera') as never }),
    stopCamera: () => out.camera && set({ ...out, camera: null }),
    startScreen: async (r: ScreenRequest) =>
      set({
        ...out,
        screen: {
          video: fakeTrack('screen') as never,
          audio: r.audio ? (fakeTrack('sound') as never) : null,
          quality: r.quality,
        },
      }),
    stopScreen: () => out.screen && set({ ...out, screen: null }),
  }) as unknown as VoiceEngine;
}

/** A space whose voice room everyone has joined. */
async function room(
  count = 3,
  opts: { before?: (net: FakeRelayNetwork, clients: CrocodileClient[]) => void } = {},
) {
  const coord = await server();
  const net = new FakeRelayNetwork();
  const names = ['alice', 'bob', 'carol', 'dave'].slice(0, count);
  const clients: CrocodileClient[] = [];
  for (const [i, n] of names.entries()) {
    // Alice hosts: she alone can.
    const c = await signUp(makeClient(net, coord, { canHost: i === 0 }), n);
    c.voiceEngine = videoVoice();
    clients.push(c);
  }
  const [owner, ...others] = clients;
  const spaceId = await owner!.createSpace('Swamp');
  const code = await owner!.createInvite(spaceId);
  for (const o of others) await o.joinWithInvite(`croc://join/${code}`);
  await waitFor(
    () => others.every((o) => owner!.state.spaces[spaceId]?.members.includes(o.userId)),
    8000,
    'members',
  );
  const channel = owner!.state.spaces[spaceId]!.channels.find((c) => c.kind === 'voice')!.id;
  const sid = sessionIds.voice(spaceId, channel);
  opts.before?.(net, clients);
  for (const c of clients) await c.joinVoice(spaceId, channel);
  if (opts.before) return { net, clients, sid, spaceId, channel };
  await waitFor(
    () => clients.every((c) => c.state.sessions[sid]?.video.ready),
    10000,
    'video on every connection',
  );
  return { net, clients, sid, spaceId, channel };
}

type Inner = {
  sessions: Map<string, { videoSlots: (string | null)[]; screenAudioSlots: (string | null)[] }>;
};
const slotsOf = (c: CrocodileClient, sid: string) => (c as unknown as Inner).sessions.get(sid)!;
const streamsOf = (c: CrocodileClient, sid: string) => c.state.sessions[sid]?.video.streams ?? [];

describe('video calls', () => {
  it('shows a camera to everyone in the room until it is turned off', async () => {
    const { net, clients, sid } = await room();
    const [alice, bob, carol] = clients as [CrocodileClient, CrocodileClient, CrocodileClient];
    await bob.setCamera(true);
    expect(bob.state.camera).toBe(true);
    // Bob's connection sends it; Bob sees his own picture.
    expect(net.outgoing.get(`${bob.peer}:camera`)).toMatchObject({ label: 'camera' });
    expect(streamsOf(bob, sid)).toEqual([
      expect.objectContaining({ userId: bob.userId, kind: 'camera', mine: true, state: 'live' }),
    ]);
    // Everyone else asks for it and gets a slot for it.
    const cam = streamIds.make(bob.peer, 'camera');
    for (const c of [alice, carol]) {
      await waitFor(() => slotsOf(c, sid).videoSlots.includes(cam), 5000, 'slot for the camera');
      expect(streamsOf(c, sid)).toEqual([
        expect.objectContaining({ id: cam, userId: bob.userId, kind: 'camera', mine: false }),
      ]);
    }
    await bob.setCamera(false);
    expect(net.outgoing.get(`${bob.peer}:camera`)).toBeNull();
    for (const c of [alice, carol])
      await waitFor(() => streamsOf(c, sid).length === 0, 5000, 'camera gone');
  });

  it('sends a shared screen, with its sound, only to those who choose to watch', async () => {
    const { net, clients, sid } = await room();
    const [alice, bob, carol] = clients as [CrocodileClient, CrocodileClient, CrocodileClient];
    await alice.shareScreen({ quality: 'motion', audio: true });
    expect(alice.state.screenShare).toEqual({ quality: 'motion', audio: true });
    expect(net.outgoing.get(`${alice.peer}:screenAudio`)).toMatchObject({ label: 'sound' });
    const screen = streamIds.make(alice.peer, 'screen');
    // Offered, not sent.
    await waitFor(() => streamsOf(bob, sid).some((s) => s.id === screen), 5000, 'offered');
    expect(streamsOf(bob, sid)[0]).toMatchObject({ kind: 'screen', audio: true, state: 'off' });
    bob.watchScreen(sid, screen, true);
    await waitFor(() => slotsOf(bob, sid).videoSlots.includes(screen), 5000, 'bob watches');
    expect(slotsOf(bob, sid).screenAudioSlots).toContain(screen);
    expect(streamsOf(bob, sid)[0]!.state).not.toBe('off');
    await new Promise((r) => setTimeout(r, 200));
    expect(slotsOf(carol, sid).videoSlots).not.toContain(screen);
    // Bob stops watching; Alice stops sharing.
    bob.watchScreen(sid, screen, false);
    await waitFor(() => !slotsOf(bob, sid).videoSlots.includes(screen), 5000, 'stopped');
    alice.stopScreenShare();
    expect(alice.state.screenShare).toBeNull();
    expect(net.outgoing.get(`${alice.peer}:screen`)).toBeNull();
  });

  it("says what the host can't send for now", async () => {
    const { net, clients, sid } = await room();
    const [alice, bob, carol] = clients as [CrocodileClient, CrocodileClient, CrocodileClient];
    net.videoRoom = 1;
    await alice.setCamera(true);
    await bob.setCamera(true);
    await waitFor(
      () => streamsOf(carol, sid).filter((s) => !s.mine).length === 2,
      5000,
      'two cameras',
    );
    await waitFor(
      () => streamsOf(carol, sid).filter((s) => s.state === 'paused').length === 1,
      5000,
      'one paused',
    );
  });

  it('turns camera and screen off when leaving the call', async () => {
    const { net, clients } = await room(2);
    const bob = clients[1]!;
    await bob.setCamera(true);
    await bob.shareScreen({ quality: 'text', audio: false });
    await bob.leaveVoice();
    expect(bob.state.camera).toBe(false);
    expect(bob.state.screenShare).toBeNull();
    await expect(bob.setCamera(true)).rejects.toThrow(/Join a call/);
    void net;
  });

  it('keeps a call through the server relay voice-only', async () => {
    const coord = await server({ relay: { enabled: true, maxUsers: 5 }, stunPort: 0 });
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord, { canHost: false }), 'bob');
    for (const c of [alice, bob]) c.voiceEngine = videoVoice();
    await bob.updateSettings({ allowServerRelay: true });
    // Nothing gets through to Bob directly: his call goes through the server.
    net.blocked.add(bob.userId);
    const spaceId = await alice.createSpace('Swamp');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(`croc://join/${code}`);
    await waitFor(() => alice.state.spaces[spaceId]?.members.includes(bob.userId), 8000);
    const channel = alice.state.spaces[spaceId]!.channels.find((c) => c.kind === 'voice')!.id;
    const sid = sessionIds.voice(spaceId, channel);
    await alice.joinVoice(spaceId, channel);
    await bob.joinVoice(spaceId, channel);
    await waitFor(() => bob.state.sessions[sid]?.video.blocked === 'relayed', 20000, 'relayed');
    await alice.setCamera(true);
    await bob.setCamera(true);
    await new Promise((r) => setTimeout(r, 300));
    // Bob neither sends video nor asks for any: the server carries voice only.
    expect(net.outgoing.get(`${bob.peer}:camera`) ?? null).toBeNull();
    expect(slotsOf(bob, sid).videoSlots.filter(Boolean)).toEqual([]);
    expect(bob.state.sessions[sid]!.video.streams.every((s) => !s.mine)).toBe(true);
  });

  it('sends video only once the call is known to go directly, and stops if it moves to a server relay', async () => {
    const { net, clients, sid } = await room(2, {
      // ICE hasn't said how Bob's connection travels yet.
      before: (n, [, b]) => void n.routes.set(b!.peer, null),
    });
    const [alice, bob] = clients as [CrocodileClient, CrocodileClient];
    await waitFor(() => alice.state.sessions[sid]?.video.ready, 10000, 'alice ready');
    await bob.setCamera(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(bob.state.sessions[sid]!.video.ready).toBe(false);
    expect(net.outgoing.get(`${bob.peer}:camera`) ?? null).toBeNull();
    // A direct path: the camera goes out.
    net.routes.delete(bob.peer);
    await waitFor(() => net.outgoing.get(`${bob.peer}:camera`), 8000, 'camera sent');
    expect(bob.state.sessions[sid]!.video.ready).toBe(true);
    // Well after connecting, ICE moves to the server relay: video stops.
    await new Promise((r) => setTimeout(r, 9000));
    net.routes.set(bob.peer, 'relay');
    await waitFor(() => bob.state.sessions[sid]?.video.blocked === 'relayed', 8000, 'relayed');
    expect(net.outgoing.get(`${bob.peer}:camera`)).toBeNull();
  });

  it("shows a stream new in a slot only once its own picture arrives, not the slot's last one", async () => {
    // Node has no MediaStream; a stand-in that just holds the track.
    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(readonly tracks: unknown[]) {}
      },
    );
    cleanup.push(() => vi.unstubAllGlobals());
    const { net, clients, sid } = await room();
    const [alice, bob, carol] = clients as [CrocodileClient, CrocodileClient, CrocodileClient];
    const stateOf = (stream: string) => streamsOf(alice, sid).find((s) => s.id === stream)?.state;
    // Alice's slots carry nothing new for now.
    net.framesDecoded.set(alice.peer, 10);
    await bob.setCamera(true);
    const bobCam = streamIds.make(bob.peer, 'camera');
    await waitFor(() => slotsOf(alice, sid).videoSlots[0] === bobCam, 5000, 'in a slot');
    await new Promise((r) => setTimeout(r, 500));
    expect(stateOf(bobCam)).toBe('loading');
    net.framesDecoded.set(alice.peer, 11);
    await waitFor(() => stateOf(bobCam) === 'live', 3000, 'bob shows');
    // Bob's camera goes; Carol's takes the same slot (and track).
    await bob.setCamera(false);
    await carol.setCamera(true);
    const carolCam = streamIds.make(carol.peer, 'camera');
    await waitFor(() => slotsOf(alice, sid).videoSlots[0] === carolCam, 5000, 'carol in slot 0');
    await new Promise((r) => setTimeout(r, 500));
    expect(stateOf(carolCam)).toBe('loading');
    net.framesDecoded.set(alice.peer, 12);
    await waitFor(() => stateOf(carolCam) === 'live', 3000, 'carol shows');
  });

  it("keeps the call voice-only with a host whose app can't carry video", async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord, { canHost: false }), 'bob');
    net.noVideoHosts.add(alice.userId);
    for (const c of [alice, bob]) c.voiceEngine = videoVoice();
    const spaceId = await alice.createSpace('Swamp');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(`croc://join/${code}`);
    await waitFor(() => alice.state.spaces[spaceId]?.members.includes(bob.userId), 8000);
    const channel = alice.state.spaces[spaceId]!.channels.find((c) => c.kind === 'voice')!.id;
    const sid = sessionIds.voice(spaceId, channel);
    await alice.joinVoice(spaceId, channel);
    await bob.joinVoice(spaceId, channel);
    await waitFor(() => bob.state.sessions[sid]?.video.blocked === 'old-host', 8000, 'old host');
    await bob.setCamera(true);
    await new Promise((r) => setTimeout(r, 200));
    // Nothing goes out: there's nowhere for it to go.
    expect(net.outgoing.get(`${bob.peer}:camera`)).toBeUndefined();
    expect(bob.state.sessions[sid]!.video.ready).toBe(false);
  });

  it('starts a video call with the camera on, and says so to the one it rings', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    for (const c of [alice, bob]) c.voiceEngine = videoVoice();
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12000, 'friends');
    await alice.callDm(bob.userId, { video: true });
    // Alice sees herself while it rings; Bob is told it's a video call.
    expect(alice.state.camera).toBe(true);
    expect(alice.state.outgoingCall).toMatchObject({ to: bob.userId, video: true });
    await waitFor(() => bob.state.incomingCall, 12000, 'rings');
    expect(bob.state.incomingCall).toMatchObject({ from: alice.userId, video: true });
    // She sees her own camera while it rings.
    const ringing = alice.state.outgoingCall!.sessionId;
    await waitFor(
      () => streamsOf(alice, ringing).some((v) => v.mine && v.kind === 'camera'),
      10000,
      'own camera while ringing',
    );
    // Bob answers with his camera on too: each gets the other's.
    await bob.callDm(alice.userId, { video: true });
    expect(bob.state.camera).toBe(true);
    const sid = alice.state.voiceSession!;
    await waitFor(
      () =>
        slotsOf(bob, sid).videoSlots.includes(streamIds.make(alice.peer, 'camera')) &&
        slotsOf(alice, sid).videoSlots.includes(streamIds.make(bob.peer, 'camera')),
      10000,
      'both cameras',
    );
    // A plain call rings as one.
    await alice.leaveVoice();
    await waitFor(() => !bob.state.voiceSession, 6000, 'ended');
    await alice.callDm(bob.userId);
    await waitFor(() => bob.state.incomingCall, 12000, 'rings again');
    expect(bob.state.incomingCall!.video).toBeUndefined();
    expect(alice.state.camera).toBe(false);
    // And stays a call: nothing from the last one ends it.
    await new Promise((r) => setTimeout(r, 4000));
    expect(alice.state.voiceSession).toBe(sid);
    expect(alice.state.outgoingCall).not.toBeNull();
  });

  it("doesn't ring for a video call hung up while the camera was still opening", async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    for (const c of [alice, bob]) c.voiceEngine = videoVoice();
    // Alice's camera takes its time, as at a permission prompt.
    let open!: () => void;
    const engine = alice.voiceEngine as unknown as { startCamera: () => Promise<boolean> };
    engine.startCamera = () => new Promise((r) => (open = () => r(false)));
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12000, 'friends');
    const calling = alice.callDm(bob.userId, { video: true });
    await waitFor(() => alice.state.voiceSession && open, 8000, 'camera opening');
    await alice.leaveVoice();
    open();
    await calling;
    await new Promise((r) => setTimeout(r, 1500));
    expect(alice.state.voiceSession).toBeNull();
    expect(alice.state.outgoingCall).toBeNull();
    expect(bob.state.incomingCall).toBeNull();
  });

  it('works in a DM call too', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    for (const c of [alice, bob]) c.voiceEngine = videoVoice();
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12000, 'friends');
    await alice.callDm(bob.userId);
    await waitFor(() => bob.state.incomingCall, 12000, 'rings');
    await bob.callDm(alice.userId);
    const sid = alice.state.voiceSession!;
    await waitFor(
      () => alice.state.sessions[sid]?.video.ready && bob.state.sessions[sid]?.video.ready,
      10000,
      'video ready',
    );
    await alice.setCamera(true);
    const cam = streamIds.make(alice.peer, 'camera');
    await waitFor(() => slotsOf(bob, sid).videoSlots.includes(cam), 5000, 'bob gets it');
  });
});
