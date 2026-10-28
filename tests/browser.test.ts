import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import type { Server } from 'node:http';
import type { Coordinator } from '@crocodile/coordinator';
import {
  attachRelayBridge,
  launchBrowser,
  relayFrames,
  relayVideo,
  serveHarness,
} from './browser/harness';
import { existsSync } from 'node:fs';
import { startCoordinator, waitFor } from './helpers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { CrocodileClient } from '@crocodile/client-core';
import { createCliPlatform } from '../apps/cli/src/platform';

const chromiumPath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const haveChromium = existsSync(chromiumPath);

/**
 * Real-browser end-to-end test: Chromium clients, real WebRTC to a real
 * werift host relay, E2EE voice frames through the encoded-transform worker.
 */
let browser: Browser;
let harness: { url: string; server: Server };
let coord: Coordinator;

beforeAll(async () => {
  if (!haveChromium) return;
  // Everything runs on loopback here, so the relay must be allowed to reach it.
  coord = await startCoordinator({
    stunPort: 0,
    relay: { enabled: true, maxUsers: 25, allowPrivatePeers: true },
  });
  harness = await serveHarness();
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  harness?.server.close();
  await coord?.stop();
});

async function openClient(
  name: string,
  canHost: boolean,
  nat = 'cone',
): Promise<{ page: Page; userId: string }> {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (process.env.DBG) console.log(`[${name} console] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await attachRelayBridge(
    page,
    () => coord.stunUrls().map((urls) => ({ urls })),
    !!process.env.DBG,
  );
  await page.goto(harness.url);
  const userId = await page.evaluate(
    ([server, n, h, nt]) =>
      window.startClient({
        server: server as string,
        name: n as string,
        canHost: h as boolean,
        nat: nt as string,
      }),
    [coord.url, name, canHost, nat] as const,
  );
  return { page, userId };
}

async function until(page: Page, fn: string, timeoutMs = 15_000) {
  await page.waitForFunction(fn, undefined, { timeout: timeoutMs, polling: 100 });
}

describe.skipIf(!haveChromium)('browser end-to-end', () => {
  it('cameras and screens reach those who watch, end-to-end encrypted through the host', async () => {
    const alice = await openClient('vid-alice', true, 'open');
    const bob = await openClient('vid-bob', false);
    const carol = await openClient('vid-carol', false);
    const spaceId = await alice.page.evaluate(() => window.croc.createSpace('Video Swamp'));
    const code = await alice.page.evaluate((s) => window.croc.createInvite(s), spaceId);
    await bob.page.evaluate((c) => window.croc.joinWithInvite(c), code);
    await carol.page.evaluate((c) => window.croc.joinWithInvite(c), code);
    const channel = await alice.page.evaluate(
      (s) => window.croc.state.spaces[s]!.channels.find((c) => c.kind === 'voice')!.id,
      spaceId,
    );
    const sid = `voice:${spaceId}:${channel}`;
    for (const c of [alice, bob, carol])
      await c.page.evaluate(([s, ch]) => window.croc.joinVoice(s as string, ch as string), [
        spaceId,
        channel,
      ] as const);
    // Each connection gets video added once the host says it carries it.
    for (const c of [alice, bob, carol])
      await until(
        c.page,
        `window.croc.state.sessions['${sid}']?.video.ready && window.croc.state.sessions['${sid}'].peers.length === 2`,
        30_000,
      );
    const before = { ...relayVideo };

    // Bob's camera (Chromium's fake one): Alice and Carol decode it.
    await bob.page.evaluate(() => window.croc.setCamera(true));
    // Pictures decoded from what the relay forwarded (so decrypted, too).
    const decoding = async (page: Page, streams: number) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const v = await page.evaluate(() => window.videoStats());
        if (v.filter((s) => s.framesDecoded > 10 && s.width > 0).length >= streams) return v;
        if (Date.now() > deadline) throw new Error(`no video decoded: ${JSON.stringify(v)}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    await decoding(carol.page, 1);
    await decoding(alice.page, 1);
    await until(
      carol.page,
      `window.croc.state.sessions['${sid}'].video.streams.some(s => s.kind === 'camera' && s.state === 'live')`,
    );

    // Alice shares a screen. Only Carol chooses to watch it.
    await alice.page.evaluate(() => window.croc.shareScreen({ quality: 'motion', audio: false }));
    const screen = await alice.page.evaluate(() => `${window.croc.peer}:screen`);
    await until(
      carol.page,
      `window.croc.state.sessions['${sid}'].video.streams.some(s => s.id === '${screen}' && s.state === 'off')`,
    );
    await carol.page.evaluate(
      ([s, id]) => window.croc.watchScreen(s as string, id as string, true),
      [sid, screen] as const,
    );
    await decoding(carol.page, 2);
    // Bob didn't ask for it: he gets Alice's nothing (she has no camera on).
    expect(await bob.page.evaluate(() => window.videoStats().then((v) => v.length))).toBe(0);

    // Everything the relay forwarded was encrypted end to end.
    const frames = relayVideo.frames - before.frames;
    expect(frames).toBeGreaterThan(30);
    expect(relayVideo.encrypted - before.encrypted).toBe(frames);
    for (const c of [alice, bob, carol]) await c.page.evaluate(() => window.croc.shutdown());
  }, 150_000);

  it('voice and text flow through the elected host relay, end-to-end encrypted', async () => {
    const alice = await openClient('alice', true, 'open');
    const bob = await openClient('bob', true, 'cone');
    const carol = await openClient('carol', false);

    const spaceId = await alice.page.evaluate(() => window.croc.createSpace('Browser Swamp'));
    const code = await alice.page.evaluate((s) => window.croc.createInvite(s), spaceId);
    await bob.page.evaluate((c) => window.croc.joinWithInvite(c), code);
    await carol.page.evaluate((c) => window.croc.joinWithInvite(c), code);

    const voiceChannel = await alice.page.evaluate(
      (s) => window.croc.state.spaces[s]!.channels.find((c) => c.kind === 'voice')!.id,
      spaceId,
    );
    const voiceSession = `voice:${spaceId}:${voiceChannel}`;
    for (const c of [alice, bob, carol]) {
      await c.page.evaluate(([s, ch]) => window.croc.joinVoice(s as string, ch as string), [
        spaceId,
        voiceChannel,
      ] as const);
    }
    for (const c of [alice, bob, carol]) {
      await until(
        c.page,
        `window.croc.state.sessions['${voiceSession}']?.status === 'connected' && window.croc.state.sessions['${voiceSession}'].peers.length === 2`,
        25_000,
      );
    }
    const view = await carol.page.evaluate((s) => window.croc.state.sessions[s], voiceSession);
    expect(view!.host).toBe(alice.userId);
    expect(view!.backup).toBe(bob.userId);
    // Read from WebRTC's selected candidate pair: here everyone shares a machine.
    // Chromium may keep a pair whose address it hides: then it's direct, or
    // unknown for a moment, but never across the internet or relayed.
    const deadline = Date.now() + 12_000;
    let route: string | null = null;
    while (!route && Date.now() < deadline) {
      route = await carol.page.evaluate((s) => window.croc.state.sessions[s]!.route, voiceSession);
      if (!route) await new Promise((r) => setTimeout(r, 200));
    }
    expect([null, 'local', 'lan', 'direct']).toContain(route);

    // Everyone's fake microphone emits a tone; listeners must decode real
    // audio, which only happens if frame decryption succeeded.
    for (const c of [bob, carol]) {
      const stats = await waitForAudio(c.page);
      expect(stats.energy).toBeGreaterThan(0.001);
    }
    // The relay only ever saw ciphertext.
    expect(relayFrames.total).toBeGreaterThan(20);
    expect(relayFrames.encrypted).toBe(relayFrames.total);

    // Text over the space's data-channel mesh.
    const textChannel = await alice.page.evaluate(
      (s) => window.croc.state.spaces[s]!.channels.find((c) => c.kind === 'text')!.id,
      spaceId,
    );
    await carol.page.evaluate((ch) => window.croc.openChannel(ch), textChannel);
    await until(
      carol.page,
      `window.croc.state.sessions['space:${spaceId}']?.peers.length === 2`,
      20_000,
    );
    await alice.page.evaluate(
      (ch) => window.croc.sendMessage(ch, 'hello from a real browser'),
      textChannel,
    );
    await until(
      carol.page,
      `(window.croc.state.messages['${textChannel}'] ?? []).some(m => m.body === 'hello from a real browser')`,
    );

    // Host leaves: the backup takes over and voice resumes.
    await alice.page.evaluate(() => window.croc.shutdown());
    await until(
      carol.page,
      `window.croc.state.sessions['${voiceSession}']?.host === '${bob.userId}' && window.croc.state.sessions['${voiceSession}']?.status === 'connected' && window.croc.state.sessions['${voiceSession}'].peers.length === 1`,
      30_000,
    );
    const after = await waitForAudio(carol.page);
    expect(after.energy).toBeGreaterThan(0.001);
  }, 120_000);
});

async function waitForAudio(page: Page) {
  const deadline = Date.now() + 20_000;
  let best = { packets: 0, energy: 0, concealed: 0, samples: 0 };
  let baseline: number | null = null;
  while (Date.now() < deadline) {
    const all = await page.evaluate(() => window.audioStats());
    const energy = all.reduce((n, s) => n + s.energy, 0);
    if (baseline === null) baseline = energy;
    best = {
      packets: all.reduce((n, s) => n + s.packets, 0),
      energy: energy - baseline,
      concealed: 0,
      samples: 0,
    };
    if (best.energy > 0.001) return best;
    await new Promise((r) => setTimeout(r, 250));
  }
  return best;
}

describe.skipIf(!haveChromium)('network check in Chromium', () => {
  it('files cross between Chromium and the command line tool (werift), both ways', async () => {
    const home = mkdtempSync(join(tmpdir(), 'croc-cli-browser-'));
    const ref: { c?: CrocodileClient } = {};
    const { platform, kv } = createCliPlatform({
      dir: home,
      version: 'test',
      stun: () => ref.c?.stunUrls ?? [],
    });
    const cli = new CrocodileClient(platform, { directories: [], preferredServers: [coord.url] });
    ref.c = cli;
    try {
      await cli.init();
      await cli.createAccount('terminal');
      const { page, userId: browserUser } = await openClient('Dana', true);
      await waitFor(() => cli.state.link === 'connected', 10_000, 'cli connected');

      // Command line → browser.
      const data = randomBytes(1_500_000);
      const sha = createHash('sha256').update(data).digest('hex');
      const dm = await cli.openDm(browserUser);
      const id = await cli.sendFile(dm, {
        name: 'from-terminal.bin',
        size: data.length,
        type: 'application/octet-stream',
        read: async (o, l) => new Uint8Array(data.subarray(o, o + l)),
      });
      // They are strangers: the conversation waits as a request until it is taken up.
      await until(page, `window.croc.state.dmRequests.includes(${JSON.stringify(cli.userId)})`);
      await page.evaluate((u) => window.croc.acceptDmRequest(u), cli.userId);
      await until(page, `!!window.croc.state.files[${JSON.stringify(id)}]`, 20_000);
      await page.evaluate((fid) => window.croc.downloadFile(fid), id);
      await until(
        page,
        `window.croc.state.files[${JSON.stringify(id)}]?.status === 'done'`,
        30_000,
      );
      const got = await page.evaluate(async (fid) => {
        const parts: Uint8Array[] = [];
        await window.croc.readFile(fid, (p) => void parts.push(p));
        const all = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
        const h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
        return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
      }, id);
      expect(got).toBe(sha);

      // Browser → command line.
      const back = await page.evaluate(async (cliUser) => {
        const bytes = new Uint8Array(800_000).map((_, i) => (i * 13) & 0xff);
        const ch = await window.croc.openDm(cliUser);
        return window.croc.sendFile(ch, {
          name: 'from-browser.bin',
          size: bytes.length,
          type: 'application/octet-stream',
          read: async (o, l) => bytes.slice(o, o + l),
        });
      }, cli.userId);
      await waitFor(() => cli.state.files[back], 20_000, 'cli knows');
      await cli.downloadFile(back);
      await waitFor(() => cli.state.files[back]?.status === 'done', 30_000, 'cli has it');
      const parts: Uint8Array[] = [];
      await cli.readFile(back, (p) => void parts.push(p));
      const all = Buffer.concat(parts);
      expect(all.length).toBe(800_000);
      expect(all.every((b, i) => b === ((i * 13) & 0xff))).toBe(true);
    } finally {
      // As the command closes: write the pending state before it goes.
      await cli.shutdown();
      kv.flush();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  it("finds nothing wrong with a machine that talks to the server's STUN ports directly", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(harness.url);
    const stun = coord.stunUrls();
    expect(stun).toHaveLength(2);
    const verdict = await page.evaluate((s) => window.checkNetwork(s), stun);
    // No NAT in between: the answers match our own address. Never "limited"
    // (two sockets' mappings compared) or "blocked".
    expect(['good', 'unknown']).toContain(verdict);
    await context.close();
  }, 30_000);
});

describe.skipIf(!haveChromium)('server relay with Chromium', () => {
  it("Chromium's TURN client relays through a coordinator's TURN server", async () => {
    const turn = coord.turn!;
    const creds = turn.credentials('aaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now() + 60_000);
    const { RTCPeerConnection: NodePC } = await import('werift');
    const direct = new NodePC({
      iceServers: [{ urls: `stun:127.0.0.1:${turn.port}` }],
      iceAdditionalHostAddresses: ['127.0.0.1'],
    });
    const got: string[] = [];
    direct.onDataChannel.subscribe((ch) => ch.onMessage.subscribe((m) => got.push(m.toString())));
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(harness.url);
    // Offer from a relay-only browser peer; answer from Node; trickle both ways.
    await page.exposeFunction('__toNode', async (kind: string, payload: string) => {
      if (kind === 'offer') {
        await direct.setRemoteDescription({ type: 'offer', sdp: payload });
        await direct.setLocalDescription(await direct.createAnswer());
        await page.evaluate(
          (sdp) => (window as unknown as { __answer(s: string): Promise<void> }).__answer(sdp),
          direct.localDescription!.sdp,
        );
      } else if (kind === 'cand') {
        await direct.addIceCandidate(JSON.parse(payload)).catch(() => {});
      }
    });
    direct.onIceCandidate.subscribe((c) => {
      if (c)
        void page.evaluate(
          (x) => (window as unknown as { __cand(s: string): void }).__cand(x),
          JSON.stringify(c.toJSON()),
        );
    });
    const types = await page.evaluate(
      async ({ url, username, credential }) => {
        const w = window as unknown as {
          __toNode(k: string, p: string): Promise<void>;
          __answer(s: string): Promise<void>;
          __cand(s: string): void;
        };
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: url, username, credential }],
          iceTransportPolicy: 'relay',
        });
        const dc = pc.createDataChannel('relay-test');
        const pending: RTCIceCandidateInit[] = [];
        let remote = false;
        w.__cand = (s) =>
          remote ? void pc.addIceCandidate(JSON.parse(s)) : void pending.push(JSON.parse(s));
        w.__answer = async (sdp) => {
          await pc.setRemoteDescription({ type: 'answer', sdp });
          remote = true;
          for (const c of pending) await pc.addIceCandidate(c);
        };
        const localTypes: string[] = [];
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            localTypes.push(e.candidate.type ?? '');
            void w.__toNode('cand', JSON.stringify(e.candidate.toJSON()));
          }
        };
        await pc.setLocalDescription(await pc.createOffer());
        await w.__toNode('offer', pc.localDescription!.sdp);
        await new Promise<void>((resolve, reject) => {
          dc.onopen = () => resolve();
          setTimeout(() => reject(new Error('data channel did not open via TURN')), 15_000);
        });
        dc.send('hello through the relay');
        const win = window as unknown as {
          routeFromStats(s: RTCStatsReport): string | null;
        };
        return { localTypes, route: win.routeFromStats(await pc.getStats()) };
      },
      {
        url: `turn:127.0.0.1:${turn.port}?transport=udp`,
        username: creds.username,
        credential: creds.credential,
      },
    );
    expect(types.localTypes.every((t) => t === 'relay')).toBe(true);
    expect(types.route).toBe('relay');
    await waitFor(() => got.includes('hello through the relay'), 5000, 'relayed message');
    expect(turn.activeUsers().has('aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    await direct.close();
    await context.close();
  }, 60_000);
});
