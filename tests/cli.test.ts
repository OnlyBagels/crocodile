import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrocodileClient } from '@crocodile/client-core';
import { run, type Io } from '../apps/cli/src/cli';
import { createCliPlatform } from '../apps/cli/src/platform';
import { startCoordinator, waitFor } from './helpers';

/**
 * The command line tool end to end: real coordinator, real WebRTC (werift)
 * for the session and for the file itself, two accounts in separate homes.
 */

const dirs: string[] = [];
const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(name: string) {
  const d = mkdtempSync(join(tmpdir(), `croc-cli-${name}-`));
  dirs.push(d);
  return d;
}

/** Someone at a terminal; `at` runs the command again in the same home and folder. */
function person(name: string, server: string, at?: { home: string; cwd: string }) {
  const home = at?.home ?? tempDir(`${name}-home`);
  const cwd = at?.cwd ?? tempDir(`${name}-cwd`);
  const out: string[] = [];
  const err: string[] = [];
  let stop!: () => void;
  const interrupted = new Promise<void>((r) => (stop = r));
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { CROCODILE_HOME: home, CROCODILE_DIRECTORIES: '' },
    cwd,
    interrupted,
  };
  const cmd = (...args: string[]) => run([...args, '--server', server], io);
  return { name, home, cwd, out, err, io, cmd, stop };
}

/** A signed-in app on another computer, the side that types the link code in. */
async function signedInApp(name: string, server: string) {
  const ref: { client?: CrocodileClient } = {};
  const { platform, kv } = createCliPlatform({
    dir: tempDir(`${name}-app`),
    version: 'test',
    stun: () => ref.client?.stunUrls ?? [],
  });
  const client = new CrocodileClient(platform, { directories: [], preferredServers: [server] });
  ref.client = client;
  // Saves are deferred: write before the folder is removed, as the CLI does on close.
  stops.push(async () => {
    await client.shutdown();
    kv.flush();
  });
  await client.init();
  await client.createAccount(name);
  await waitFor(() => client.state.link === 'connected' && client.state.me, 15_000, 'app online');
  return client;
}

/**
 * Runs `crocodile link` on `newcomer` while `app` types the code in and
 * confirms, and answers the terminal's question with `answer`.
 */
async function linkFromApp(
  newcomer: ReturnType<typeof person>,
  app: CrocodileClient,
  answer: (shownOnApp: string, shownHere: string) => string,
) {
  let shownOnApp!: (code: string) => void;
  const appCode = new Promise<string>((r) => (shownOnApp = r));
  newcomer.io.ask = async () => answer(await appCode, newcomer.err.join('\n'));
  const linking = newcomer.cmd('link');
  const code = await waitFor(
    () => newcomer.err.join('\n').match(/\b[A-Z2-7]{8}\b/)?.[0],
    15_000,
    'link code',
  );
  shownOnApp(await app.claimDeviceLink(code));
  await app.confirmDeviceLink();
  return linking;
}

describe('crocodile (command line)', () => {
  it('sends a file from one computer to another, straight between them', async () => {
    const coord = await startCoordinator({ stunPort: 0 });
    stops.push(() => coord.stop());
    const alice = person('alice', coord.url);
    const bob = person('bob', coord.url);

    expect(await alice.cmd('init', 'alice')).toBe(0);
    expect(await bob.cmd('init', 'bob')).toBe(0);
    const aliceTag = alice.out.at(-1)!;
    const bobTag = bob.out.at(-1)!;
    expect(aliceTag).toMatch(/^alice#\d{4}$/);
    expect(alice.err.join('\n')).toMatch(/Recovery key/);
    // The keys live in a file only this user can read.
    if (process.platform !== 'win32') {
      expect(statSync(join(alice.home, 'state.json')).mode & 0o777).toBe(0o600);
      expect(statSync(alice.home).mode & 0o077).toBe(0);
    }

    expect(await bob.cmd('whoami')).toBe(0);
    expect(bob.out.at(-1)).toMatch(new RegExp(`^${bobTag} [a-z2-7]{26}$`));

    const data = Buffer.alloc(2 * 1024 * 1024 + 4321);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 0xff;
    writeFileSync(join(alice.cwd, 'report.bin'), data);

    const receiving = bob.cmd('get', '--from', aliceTag);
    const sending = alice.cmd('send', 'report.bin', '--to', bobTag, '-m', 'the numbers');
    const [got, sent] = await Promise.all([receiving, sending]);
    expect({ got, sent, aliceErr: alice.err, bobErr: bob.err }).toMatchObject({ got: 0, sent: 0 });
    const saved = bob.out.at(-1)!;
    expect(saved).toBe(join(bob.cwd, 'report.bin'));
    expect(readFileSync(saved).equals(data)).toBe(true);
    expect(alice.err.join('\n')).toMatch(new RegExp(`${bobTag} has report.bin`));
  }, 120_000);

  it('says who wants to send something when get was not told whose files to take', async () => {
    const coord = await startCoordinator({ stunPort: 0 });
    stops.push(() => coord.stop());
    const alice = person('alice', coord.url);
    const bob = person('bob', coord.url);
    expect(await alice.cmd('init', 'alice')).toBe(0);
    expect(await bob.cmd('init', 'bob')).toBe(0);
    const aliceTag = alice.out.at(-1)!;
    const bobTag = bob.out.at(-1)!;
    writeFileSync(join(alice.cwd, 'note.txt'), 'hello');

    const waiting = bob.cmd('get');
    const sending = alice.cmd('send', 'note.txt', '--to', bobTag);
    await waitFor(
      () => bob.err.some((l) => l.includes(`${aliceTag} wants to send you something`)),
      30_000,
      'a hint',
    );
    expect(bob.err.join('\n')).toContain(`get --from ${aliceTag}`);
    expect(bob.err.join('\n')).not.toMatch(/Receiving/);
    bob.stop();
    alice.stop();
    await Promise.all([waiting, sending]);
  }, 60_000);

  it('carries on a download stopped half way when run again', async () => {
    const coord = await startCoordinator({ stunPort: 0 });
    stops.push(() => coord.stop());
    const alice = person('alice', coord.url);
    const bob = person('bob', coord.url);
    expect(await alice.cmd('init', 'alice')).toBe(0);
    expect(await bob.cmd('init', 'bob')).toBe(0);
    const aliceTag = alice.out.at(-1)!;
    const bobTag = bob.out.at(-1)!;
    const data = Buffer.alloc(24 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 13 + 5) & 0xff;
    writeFileSync(join(alice.cwd, 'big.bin'), data);

    const first = bob.cmd('get', '--from', aliceTag);
    const sending = alice.cmd('send', 'big.bin', '--to', bobTag);
    await waitFor(() => bob.err.some((l) => l.startsWith('Receiving')), 30_000, 'receiving');
    bob.stop();
    expect(await first).toBe(130);

    // The message won't arrive again; the download it started carries on.
    const again = person('bob', coord.url, bob);
    const giveUp = setTimeout(() => again.stop(), 60_000);
    const got = await again.cmd('get', '--from', aliceTag);
    clearTimeout(giveUp);
    expect({ got, err: again.err }).toMatchObject({ got: 0 });
    expect(readFileSync(again.out.at(-1)!).equals(data)).toBe(true);
    expect(await sending).toBe(0);
  }, 180_000);

  it('links this computer once the security code is confirmed on both sides', async () => {
    const coord = await startCoordinator();
    stops.push(() => coord.stop());
    const app = await signedInApp('erin', coord.url);
    const laptop = person('erin-laptop', coord.url);
    const linked = await linkFromApp(laptop, app, (onApp, here) =>
      here.includes(onApp) ? 'yes' : 'no',
    );
    expect({ linked, err: laptop.err }).toMatchObject({ linked: 0 });
    const { username, tag } = app.state.me!;
    expect(laptop.out.at(-1)).toBe(`${username}#${tag}`);
    expect(await laptop.cmd('whoami')).toBe(0);
    expect(laptop.out.at(-1)).toContain(app.userId);
  }, 90_000);

  it('links nothing when the codes are not confirmed here, or there is no terminal to ask', async () => {
    const coord = await startCoordinator();
    stops.push(() => coord.stop());
    const app = await signedInApp('fred', coord.url);
    const laptop = person('fred-laptop', coord.url);
    expect(await linkFromApp(laptop, app, () => 'no')).toBe(1);
    expect(laptop.err.at(-1)).toMatch(/not confirmed/);
    expect(await laptop.cmd('whoami')).not.toBe(0);

    const server = person('fred-server', coord.url);
    const linking = server.cmd('link');
    const code = await waitFor(
      () => server.err.join('\n').match(/\b[A-Z2-7]{8}\b/)?.[0],
      15_000,
      'link code',
    );
    await app.claimDeviceLink(code);
    await app.confirmDeviceLink();
    expect(await linking).toBe(1);
    expect(server.err.at(-1)).toMatch(/needs a terminal/);
    expect(await server.cmd('whoami')).not.toBe(0);
  }, 90_000);

  it('leaves a damaged keys file alone instead of starting over', async () => {
    const coord = await startCoordinator();
    stops.push(() => coord.stop());
    const dana = person('dana', coord.url);
    expect(await dana.cmd('init', 'dana')).toBe(0);
    const path = join(dana.home, 'state.json');
    const damaged = readFileSync(path, 'utf8').slice(0, 100);
    writeFileSync(path, damaged);
    expect(await dana.cmd('init', 'dana')).toBe(1);
    expect(dana.err.at(-1)).toMatch(/damaged/);
    expect(readFileSync(path, 'utf8')).toBe(damaged);
  }, 60_000);

  it('explains what to do first, and rejects unclear input', async () => {
    const coord = await startCoordinator();
    stops.push(() => coord.stop());
    const carol = person('carol', coord.url);
    expect(await carol.cmd('send', 'x', '--to', 'bob#1234')).toBe(2);
    expect(carol.err.at(-1)).toMatch(/crocodile link/);
    expect(await carol.cmd('frobnicate')).toBe(2);
    expect(await run(['--version'], carol.io)).toBe(0);
    expect(await carol.cmd('init', 'carol')).toBe(0);
    expect(await carol.cmd('init', 'carol')).toBe(2);
    expect(await carol.cmd('send', 'missing.txt', '--to', 'bob#1234')).toBe(2);
    writeFileSync(join(carol.cwd, 'a.txt'), 'hi');
    expect(await carol.cmd('send', 'a.txt', '--to', 'bob')).toBe(2);
    expect(await carol.cmd('send', 'a.txt', '--to', 'nobody#0000')).toBe(1);
    expect(carol.err.at(-1)).toMatch(/Nobody called nobody#0000/);
  }, 60_000);
});
