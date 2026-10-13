import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { HostRelay } from '@crocodile/relay';
import { fromB64u, type SignalData } from '@crocodile/protocol';
import { FRAME_MAGIC, VIDEO_FRAME_MAGIC, identityFromSeed, randomId } from '@crocodile/crypto';

const here = dirname(fileURLToPath(import.meta.url));
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export async function buildBundles() {
  const common = {
    bundle: true,
    write: false,
    format: 'iife' as const,
    target: 'chrome120',
    logLevel: 'silent' as const,
  };
  const [page, worker] = await Promise.all([
    build({ ...common, entryPoints: [join(here, 'page.ts')] }),
    build({
      ...common,
      entryPoints: [join(here, '../../packages/client-core/src/frame-worker.ts')],
    }),
  ]);
  return { page: page.outputFiles![0]!.text, worker: worker.outputFiles![0]!.text };
}

export async function serveHarness(): Promise<{ url: string; server: Server }> {
  const bundles = await buildBundles();
  const html = readFileSync(join(here, 'index.html'));
  const server = createServer((req, res) => {
    if (req.url === '/page.js')
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundles.page);
    else if (req.url === '/frame-worker.js')
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundles.worker);
    else res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server };
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    executablePath: CHROMIUM,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // Expose real host candidates instead of mDNS names (loopback test).
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
}

/** Wires the page's relay adapter to a real HostRelay running in this Node process. */
export const relayFrames = { total: 0, encrypted: 0 };
/** Video frames the relay forwarded (their last packets), and how many ended in the E2EE trailer. */
export const relayVideo = { frames: 0, encrypted: 0, streams: new Set<string>() };

export async function attachRelayBridge(
  page: Page,
  stunUrls: () => { urls: string }[],
  log = false,
) {
  const relays = new Map<string, { relay: HostRelay; members: Set<string> }>();
  await page.exposeFunction(
    '__relayStart',
    async (opts: {
      seed: string;
      hostPeer: string;
      sessionId: string;
      epoch: number;
      slots: number;
      iceServers: { urls: string }[];
    }) => {
      const handle = randomId(6);
      const entry = { members: new Set<string>(), relay: undefined as unknown as HostRelay };
      entry.relay = new HostRelay({
        sessionId: opts.sessionId,
        epoch: opts.epoch,
        identity: identityFromSeed(fromB64u(opts.seed)),
        hostPeer: opts.hostPeer,
        slots: opts.slots,
        iceServers: stunUrls(),
        includeLoopback: true,
        admit: (u) => entry.members.has(u),
        onUpstreamVideo: (stream, payload, last) => {
          relayVideo.streams.add(stream);
          if (!last) return;
          relayVideo.frames += 1;
          if (payload[payload.length - 1] === VIDEO_FRAME_MAGIC) relayVideo.encrypted += 1;
        },
        onUpstreamFrame: (_from, payload) => {
          relayFrames.total += 1;
          // Every E2EE frame ends with the sender-key trailer magic byte.
          if (payload.length > 25 && payload[payload.length - 1] === FRAME_MAGIC)
            relayFrames.encrypted += 1;
        },
        sendSignal: (to, data) => {
          void page
            .evaluate(
              ([h, t, d]) => window.__relaySignalOut(h as string, t as string, d as never),
              [handle, to, data] as const,
            )
            .catch(() => {});
        },
        log: log
          ? {
              info: (m, e) => console.log('relay', m, e),
              warn: (m, e) => console.log('relay WARN', m, e),
            }
          : undefined,
      });
      relays.set(handle, entry);
      return handle;
    },
  );
  await page.exposeFunction(
    '__relaySignalIn',
    async (handle: string, from: string, data: SignalData) => {
      await relays.get(handle)?.relay.handleSignal(from, data);
    },
  );
  await page.exposeFunction('__relayMembers', async (handle: string, members: string[]) => {
    const e = relays.get(handle);
    if (e) e.members = new Set(members);
  });
  await page.exposeFunction('__relayClose', async (handle: string) => {
    await relays.get(handle)?.relay.close();
    relays.delete(handle);
  });
  return relays;
}
