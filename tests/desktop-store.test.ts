import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Browser, Page } from 'playwright-core';
import { createChatMessage, createIdentity } from '@crocodile/crypto';
import type { ChatMessage } from '@crocodile/protocol';
import { launchBrowser } from './browser/harness';

const here = dirname(fileURLToPath(import.meta.url));
const haveChromium = existsSync(process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium');

let browser: Browser;
let server: Server;
let page: Page;

beforeAll(async () => {
  if (!haveChromium) return;
  const bundle = await build({
    entryPoints: [join(here, 'browser/store-page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'chrome120',
    logLevel: 'silent',
  });
  const js = bundle.outputFiles[0]!.text;
  server = createServer((req, res) => {
    if (req.url === '/store.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    else
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><script src="/store.js"></script>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser();
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  await page.waitForFunction(() => !!window.store);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe.runIf(haveChromium)('desktop message store', () => {
  it('pages through messages that share a time without skipping any', async () => {
    const me = createIdentity();
    const ch = 'chan-paging';
    const base = 1_700_000_000_000;
    const all: ChatMessage[] = [];
    // 120 messages, 50 of them at one moment, across a page boundary.
    for (let i = 0; i < 120; i++)
      all.push(
        createChatMessage(me, { ch, body: `m${i}` }, i >= 20 && i < 70 ? base + 20 : base + i),
      );
    await page.evaluate(async (list) => {
      for (const m of list) await window.store.put(m);
    }, all);

    const seen = await page.evaluate(async (channel) => {
      const out: string[] = [];
      let before: { ts: number; id: string } | undefined;
      for (;;) {
        const got = await window.store.page(channel, {
          before: before?.ts,
          beforeId: before?.id,
          limit: 30,
        });
        if (got.length === 0) break;
        out.unshift(...got.map((m) => m.body));
        before = { ts: got[0]!.ts, id: got[0]!.id };
      }
      return out;
    }, ch);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);

    // History from a moment includes messages at that moment.
    const since = await page.evaluate(
      (channel) => window.store.since(channel, 1_700_000_000_020, 500),
      ch,
    );
    expect(since).toHaveLength(100);
  });
  it('keeps messages that share an id but not an author, and still drops repeats', async () => {
    const alice = createIdentity();
    const mallory = createIdentity();
    const ch = 'chan-same-id';
    const real = createChatMessage(alice, { ch, body: 'from alice' }, 1_700_000_000_000);
    // Authors choose their ids: hers is the same as Alice's. (The store doesn't check signatures.)
    const squat = { ...createChatMessage(mallory, { ch, body: 'from mallory' }), id: real.id };
    const other = { ...real, ch: 'chan-elsewhere' };
    const result = await page.evaluate(
      async ({ squat, real, other, ch }) => {
        const puts = [
          await window.store.put(squat),
          await window.store.put(real),
          await window.store.put(real),
          await window.store.put(squat),
          await window.store.put(other),
        ];
        const held = await window.store.page(ch, { limit: 10 });
        return { puts, held: held.map((m) => m.body).sort() };
      },
      { squat, real, other, ch },
    );
    expect(result.puts).toEqual([true, true, false, false, true]);
    expect(result.held).toEqual(['from alice', 'from mallory']);
  });
  it('pages back through messages that share a time and an id without losing any', async () => {
    const a = createIdentity();
    const b = createIdentity();
    const ch = 'chan-twins';
    const at = 1_700_000_000_000;
    const make = (who: typeof a, ts: number, id: string, body: string): ChatMessage => ({
      ...createChatMessage(who, { ch, body }, ts),
      id,
    });
    // Twins at one time and id, and 3 newer messages: a page of 4 ends between the twins.
    const list = [
      make(a, at, 'mmmmmmmmmmmmmmmmmmmmmmmmmm', 'twin a'),
      make(b, at, 'mmmmmmmmmmmmmmmmmmmmmmmmmm', 'twin b'),
      ...[0, 1, 2].map((i) => make(a, at + 1 + i, `nnnnnnnnnnnnnnnnnnnnnnnnn${i}`, `n${i}`)),
    ];
    const result = await page.evaluate(
      async ({ list, ch }) => {
        for (const m of list) await window.store.put(m);
        const newest = await window.store.page(ch, { limit: 4 });
        const older = await window.store.page(ch, {
          before: newest[0]!.ts,
          beforeId: newest[0]!.id,
          limit: 4,
        });
        // Repeats of either twin are still repeats.
        const again = [await window.store.put(list[0]!), await window.store.put(list[1]!)];
        return { newest: newest.map((m) => m.body).sort(), older: older.length, again };
      },
      { list, ch },
    );
    expect(result.newest).toEqual(['n0', 'n1', 'n2', 'twin a', 'twin b']);
    expect(result.older).toBe(0);
    expect(result.again).toEqual([false, false]);
  });
  it('keeps twins together when another id starts with theirs', async () => {
    const a = createIdentity();
    const b = createIdentity();
    const ch = 'chan-neighbours';
    const at = 1_700_000_000_000;
    const make = (who: typeof a, id: string, body: string): ChatMessage => ({
      ...createChatMessage(who, { ch, body }, at),
      id,
    });
    const twin = 'mmmmmmmmmmmmmmmmmmmmmmmmmm';
    const list = [make(a, twin, 'twin a'), make(b, twin, 'twin b'), make(a, `${twin}0`, 'next')];
    const result = await page.evaluate(
      async ({ list, ch }) => {
        for (const m of list) await window.store.put(m);
        return (await window.store.page(ch, { limit: 2 })).map((m) => m.body).sort();
      },
      { list, ch },
    );
    // A page of 2 would end between the twins, so it takes both.
    expect(result).toEqual(['next', 'twin a', 'twin b']);
  });
});
