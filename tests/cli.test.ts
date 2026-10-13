import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type Io } from '../apps/cli/src/cli';
import { startCoordinator } from './helpers';

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

function person(name: string, server: string) {
  const home = tempDir(`${name}-home`);
  const cwd = tempDir(`${name}-cwd`);
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
