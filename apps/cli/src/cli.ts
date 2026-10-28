import { open, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CrocodileClient,
  cleanFileName,
  type FileSource,
  type FileView,
} from '@crocodile/client-core';
import type { FileManifest } from '@crocodile/protocol';
import { createCliPlatform, type CliFileStore, type JsonFileStore } from './platform';

/** What the commands need from the outside world; tests pass their own. */
export interface Io {
  /** Results (saved paths, ids): what a script reads. */
  out(line: string): void;
  /** Everything for people: progress, questions, problems. */
  err(line: string): void;
  /** Rewrites the current status line (progress), on a terminal. */
  status?(line: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Resolves when the user asks to stop (Ctrl+C). */
  interrupted?: Promise<void>;
  /** Reads one answer from the user; absent when there is no terminal to ask on. */
  ask?(question: string): Promise<string>;
}

export const VERSION = process.env.CROC_CLI_VERSION ?? '0.0.0-dev';
const DEFAULT_DIRECTORIES = 'https://crocodilechat.com';

const HELP = `crocodile: send and receive files with Crocodile, peer-to-peer and end-to-end encrypted.

Set up (once per computer):
  crocodile link                 add this computer to your Crocodile account
  crocodile init <name>          or make a separate account for it (a server, a bot)

Use:
  crocodile send <file>... --to <name#1234>   send files; stays running until they have them
  crocodile get [--from <name#1234>]          receive the next file sent to you
  crocodile whoami                            the account this computer uses

Options:
  --to <name#1234>     who to send to (name and tag, as shown in the app)
  -m, --message <text> a note to go with the files
  --from <name#1234>   only accept files from this person
  -d, --dir <folder>   where received files go (default: here)
  --keep               keep receiving after the first file
  --profile <name>     a separate account on this computer
  --server <url>       use this coordination server first
  --directory <url>    find servers through this directory (default: ${DEFAULT_DIRECTORIES})
  -v, --verbose        show what's happening underneath
  -h, --help           this help
  --version            the version

Files go straight to the other person's device, never through a server.
Run \`crocodile help <command>\` for more.`;

const COMMAND_HELP: Record<string, string> = {
  link: `crocodile link

Adds this computer to your Crocodile account. It shows a code: in the
Crocodile app on a computer where you're signed in, open the account menu,
choose "Link another device" and type it. Then check both show the same
security code, and confirm in the app and here. It needs a terminal: it asks
you to type "yes" once the codes match.`,
  init: `crocodile init <name>

Makes a new account just for this computer, for example for a server or a
script. People send files to it as <name>#<tag>; it can send to anyone.
Prints a recovery key: keep it if you want to restore the account elsewhere.`,
  send: `crocodile send <file>... --to <name#1234> [-m <message>]

Sends files in your direct conversation with someone. They appear in their
app like any file; a command line receiver gets them with \`crocodile get\`.
The files go from this computer to theirs, so this keeps running until
they have downloaded every one (Ctrl+C stops it; files not yet downloaded
can't be fetched after that).`,
  get: `crocodile get [--from <name#1234>] [-d <folder>] [--keep]

Waits for a file sent to you in a direct conversation (including ones sent
while this computer was off, if the sender is still online), downloads it
straight from the sender and saves it. Prints the saved path. With --keep
it goes on receiving until you stop it.

With --from it also takes up a conversation that person starts while it
runs, even if they aren't a friend yet (the app would show a request to
accept). Without --from, only friends and existing conversations are heard.`,
  whoami: `crocodile whoami

Shows the account this computer uses (name#tag and user id).`,
};

class UsageError extends Error {}

/** Runs one command; resolves to the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        to: { type: 'string' },
        from: { type: 'string' },
        message: { type: 'string', short: 'm' },
        dir: { type: 'string', short: 'd' },
        keep: { type: 'boolean' },
        profile: { type: 'string' },
        server: { type: 'string' },
        directory: { type: 'string' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: opts, positionals } = args;
  const [command, ...rest] = positionals;
  if (opts.version) {
    io.out(VERSION);
    return 0;
  }
  if (!command || opts.help || command === 'help') {
    const topic = command === 'help' ? rest[0] : command;
    io.err(topic && COMMAND_HELP[topic] ? COMMAND_HELP[topic]! : HELP);
    return command || opts.help ? 0 : 2;
  }
  if (!COMMAND_HELP[command]) {
    io.err(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }

  let ctx: Ctx;
  try {
    ctx = await start(io, opts);
  } catch (err) {
    io.err(`Error: ${(err as Error).message}`);
    return 1;
  }
  try {
    switch (command) {
      case 'init':
        return await init(ctx, rest.join(' '));
      case 'link':
        return await link(ctx);
      case 'whoami':
        return await whoami(ctx);
      case 'send':
        return await send(ctx, rest, opts.to, opts.message);
      case 'get':
        return await get(ctx, { from: opts.from, dir: opts.dir, keep: !!opts.keep });
    }
    return 2;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(err.message);
      return 2;
    }
    io.err(`Error: ${(err as Error).message}`);
    return 1;
  } finally {
    await ctx.close();
  }
}

interface Ctx {
  io: Io;
  client: CrocodileClient;
  kv: JsonFileStore;
  files: CliFileStore;
  close(): Promise<void>;
}

function homeDir(env: Io['env']) {
  if (env.CROCODILE_HOME) return env.CROCODILE_HOME;
  const base =
    process.platform === 'win32'
      ? (env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(base, 'crocodile-cli');
}

async function start(
  io: Io,
  opts: { profile?: string; server?: string; directory?: string; verbose?: boolean },
): Promise<Ctx> {
  const profile = opts.profile?.replace(/[^\w.-]/g, '_');
  const dir = join(homeDir(io.env), ...(profile ? ['profiles', profile] : []));
  // The platform asks the client for STUN servers, and is made before it.
  const ref: { client?: CrocodileClient } = {};
  const { platform, kv, files } = createCliPlatform({
    dir,
    version: VERSION,
    stun: () => ref.client?.stunUrls ?? [],
  });
  const directories = (opts.directory ?? io.env.CROCODILE_DIRECTORIES ?? DEFAULT_DIRECTORIES)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const client = new CrocodileClient(platform, {
    directories,
    preferredServers: opts.server ? [opts.server] : [],
    ...(opts.verbose ? { log: (m, e) => io.err(`· ${m}${e ? ` ${JSON.stringify(e)}` : ''}`) } : {}),
  });
  ref.client = client;
  client.on('error', ({ message }) => opts.verbose && io.err(`! ${message}`));
  await client.init();
  return {
    io,
    client,
    kv,
    files,
    async close() {
      await client.shutdown().catch(() => {});
      kv.flush();
    },
  };
}

async function until<T>(
  ctx: Ctx,
  check: () => T | undefined | null | false,
  ms: number,
): Promise<T | null> {
  const end = Date.now() + ms;
  let stop = false;
  void ctx.io.interrupted?.then(() => (stop = true));
  for (;;) {
    const v = check();
    if (v) return v;
    if (stop || Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function connected(ctx: Ctx) {
  const ok = await until(ctx, () => ctx.client.state.link === 'connected', 30_000);
  if (!ok)
    throw new Error(
      "Can't reach a coordination server. Check the connection, or name one with --server <url>.",
    );
}

function needAccount(ctx: Ctx) {
  if (ctx.client.state.phase !== 'ready')
    throw new UsageError(
      'This computer has no Crocodile account yet. Run `crocodile link` to use yours, or `crocodile init <name>` for a separate one.',
    );
}

const me = (ctx: Ctx) => {
  const p = ctx.client.state.me;
  return p ? `${p.username}#${p.tag}` : ctx.client.userId;
};

async function init(ctx: Ctx, name: string) {
  if (ctx.client.state.phase === 'ready')
    throw new UsageError(
      `This computer already uses ${me(ctx)}. For another account, add --profile <name>.`,
    );
  if (!name.trim()) throw new UsageError('Give the account a name: crocodile init <name>');
  await ctx.client.createAccount(name.trim());
  await connected(ctx);
  await until(ctx, () => ctx.client.state.me, 15_000);
  ctx.io.err(`Account created: ${me(ctx)}`);
  ctx.io.err(
    `\nRecovery key (the only way to restore this account elsewhere; keep it safe):\n\n  ${ctx.client.recoveryKey()}\n`,
  );
  ctx.io.out(me(ctx));
  return 0;
}

async function link(ctx: Ctx) {
  if (ctx.client.state.phase === 'ready')
    throw new UsageError(`This computer already uses ${me(ctx)}.`);
  const io = ctx.io;
  // Checked before a code goes out: nobody should enter one only to be refused.
  const ask = io.ask;
  if (!ask) throw new UsageError('Linking needs a terminal, to confirm the security code here.');
  void ctx.client.startDeviceLink();
  let shown = '';
  let refused = '';
  const done = await until(
    ctx,
    () => {
      const l = ctx.client.state.linking;
      if (!l || l.role !== 'new') return null;
      if (l.step === 'waiting' && l.code && shown !== 'code') {
        shown = 'code';
        io.err(
          `In Crocodile on a computer where you're signed in, open the account menu, choose\n"Link another device" and type this code:\n\n  ${l.code}\n`,
        );
      }
      if (l.step === 'claimed' && l.securityCode && shown !== 'claimed') {
        shown = 'claimed';
        io.err(
          `Check that the app shows exactly this security code, and confirm there too:\n\n  ${l.securityCode}\n`,
        );
        // This computer takes the account only once someone here has compared
        // the codes: a server could send a claim and an account of its own.
        void ask('Does it match? Type "yes" to link this computer: ').then((answer) => {
          if (answer.trim().toLowerCase() === 'yes') void ctx.client.confirmDeviceLink();
          else refused = 'The security codes were not confirmed, so nothing was linked.';
        });
      }
      if (refused) return { ok: false, error: refused };
      if (l.step === 'error') return { ok: false, error: l.error ?? 'Linking failed' };
      if (l.step === 'done') return { ok: true, error: '' };
      return null;
    },
    15 * 60_000,
  );
  if (!done) {
    ctx.client.cancelDeviceLink();
    throw new Error('Stopped before the device was linked.');
  }
  if (!done.ok) {
    ctx.client.cancelDeviceLink();
    throw new Error(done.error);
  }
  await connected(ctx);
  await until(ctx, () => ctx.client.state.me, 15_000);
  io.err(`Linked: this computer is now one of ${me(ctx)}'s devices.`);
  io.out(me(ctx));
  return 0;
}

async function whoami(ctx: Ctx) {
  needAccount(ctx);
  await until(ctx, () => ctx.client.state.me, 10_000);
  ctx.io.out(`${me(ctx)} ${ctx.client.userId}`);
  return 0;
}

/** A user id from "name#1234" (or a user id as is). */
async function findUser(ctx: Ctx, who: string): Promise<string> {
  const id = who.trim();
  if (/^[a-z2-7]{26}$/.test(id)) return id;
  const m = /^(.+)#(\d{4})$/.exec(id);
  if (!m) throw new UsageError(`"${who}" isn't a name with its tag, like alice#1234.`);
  const found = await ctx.client.searchUsers(id);
  const exact = found.find((p) => p.username === m[1] && p.tag === m[2]);
  if (!exact) throw new Error(`Nobody called ${id} was found.`);
  return exact.userId;
}

function fileSource(path: string, size: number): FileSource {
  return {
    name: cleanFileName(basename(path)),
    size,
    type: MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream',
    async read(offset, length) {
      const f = await open(path, 'r');
      try {
        const buf = new Uint8Array(length);
        const { bytesRead } = await f.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      } finally {
        await f.close();
      }
    },
  };
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

async function send(ctx: Ctx, paths: string[], to: string | undefined, message?: string) {
  needAccount(ctx);
  if (paths.length === 0)
    throw new UsageError('Name the files to send: crocodile send <file>... --to <name#1234>');
  if (!to) throw new UsageError('Say who to send to: --to <name#1234>');
  const io = ctx.io;
  const files: { path: string; size: number }[] = [];
  for (const p of paths) {
    const path = resolve(io.cwd, p);
    const s = await stat(path).catch(() => null);
    if (!s?.isFile()) throw new UsageError(`${p} isn't a file.`);
    files.push({ path, size: s.size });
  }
  await connected(ctx);
  const userId = await findUser(ctx, to);
  const channel = await ctx.client.openDm(userId);
  const ids = new Map<string, string>();
  const delivered = new Set<string>();
  ctx.client.on('fileServed', ({ fileId, to: who }) => {
    const name = ids.get(fileId);
    if (who !== userId || !name || delivered.has(fileId)) return;
    delivered.add(fileId);
    io.err(`${to} has ${name}.`);
  });
  for (const [i, f] of files.entries()) {
    const source = fileSource(f.path, f.size);
    io.status?.(`Preparing ${source.name}…`);
    const id = await ctx.client.sendFile(channel, source, {
      ...(i === 0 && message ? { caption: message } : {}),
      store: false,
      prepared: (manifest) => ctx.files.addSource(manifest, f.path),
      onProgress: (done) =>
        io.status?.(`Preparing ${source.name}: ${Math.round((done / Math.max(1, f.size)) * 100)}%`),
    });
    ids.set(id, source.name);
    io.status?.('');
    io.err(`Sent ${source.name} (${formatBytes(f.size)}) to ${to}.`);
    io.out(id);
  }
  io.err(
    `Waiting for ${to} to download ${files.length === 1 ? 'it' : 'them'}. Keep this running: the files go from this computer (Ctrl+C to stop).`,
  );
  const all = await until(ctx, () => delivered.size === ids.size, Number.POSITIVE_INFINITY);
  if (!all) {
    io.err(`Stopped. ${ids.size - delivered.size} of ${ids.size} not downloaded yet.`);
    return 130;
  }
  io.err('Done.');
  return 0;
}

const SAVED_KEY = 'cli-saved-files';

/** A path in `dir` for `name` that doesn't exist yet: "a.txt", "a (1).txt"… */
function freePath(dir: string, name: string) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const p = join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
}

async function get(ctx: Ctx, opts: { from?: string; dir?: string; keep: boolean }) {
  needAccount(ctx);
  const io = ctx.io;
  const dir = resolve(io.cwd, opts.dir ?? '.');
  if (!(await stat(dir).catch(() => null))?.isDirectory())
    throw new UsageError(`${opts.dir} isn't a folder.`);
  await connected(ctx);
  const from = opts.from ? await findUser(ctx, opts.from) : null;
  const saved = new Set((await ctx.kv.get<string[]>(SAVED_KEY)) ?? []);
  const client = ctx.client;
  const queue: { author: string; file: FileManifest }[] = [];
  const add = (author: string, file: FileManifest) => {
    if (author === client.userId || (from && author !== from)) return;
    if (saved.has(file.id) || queue.some((q) => q.file.id === file.id)) return;
    queue.push({ author, file });
  };
  client.on('message', ({ message: m }) => {
    if (m.file && !m.deleted && m.ch.startsWith('dm:')) add(m.author, m.file);
  });
  // Files that arrived before (a download stopped half way, or sent while
  // this wasn't running): their messages won't come again.
  for (const f of client.files?.list() ?? []) {
    const file = client.files!.manifest(f.id);
    if (file && !f.complete && !f.mine && f.sessionId.startsWith('dm:')) add(f.author, file);
  }
  // Naming the sender is asking to hear from them: a conversation they start is taken up while
  // this runs (the app would wait for an answer). Without a name, only people already known.
  const told = new Set<string>();
  const takeRequests = () => {
    if (from && client.state.dmRequests.includes(from))
      void client
        .acceptDmRequest(from)
        .catch((e) => io.err(`Could not take up the conversation: ${e.message}`));
    for (const u of client.state.dmRequests) {
      const p = client.state.profiles[u];
      if (u === from || told.has(u) || !p) continue;
      told.add(u);
      io.err(
        `${p.username}#${p.tag} wants to send you something. Run: get --from ${p.username}#${p.tag}`,
      );
    }
  };
  takeRequests();
  io.err(`Waiting for files${opts.from ? ` from ${opts.from}` : ''} (Ctrl+C to stop)…`);
  let received = 0;
  for (;;) {
    const next = await until(
      ctx,
      () => {
        takeRequests();
        return queue[0];
      },
      Number.POSITIVE_INFINITY,
    );
    if (!next) break;
    const m = queue.shift()!;
    const file = m.file;
    const name = cleanFileName(file.name);
    const sender = client.state.profiles[m.author];
    const who = sender ? `${sender.username}#${sender.tag}` : m.author;
    io.err(`Receiving ${name} (${formatBytes(file.size)}) from ${who}…`);
    await client.downloadFile(file.id);
    let said = '';
    const end = await until(
      ctx,
      () => {
        const v: FileView | undefined = client.state.files[file.id];
        if (!v) return null;
        if (v.status === 'downloading')
          io.status?.(
            `${name}: ${Math.round((v.done / Math.max(1, v.size)) * 100)}% (${formatBytes(v.done)} of ${formatBytes(v.size)})`,
          );
        const note =
          v.status === 'unavailable'
            ? `${who} isn't online with it right now; it downloads when they are.`
            : v.status === 'no_direct'
              ? `Can't connect directly to ${who} (files never go through servers); still trying.`
              : '';
        if (note && note !== said) {
          said = note;
          io.status?.('');
          io.err(note);
        }
        return v.status === 'done' ? v : null;
      },
      Number.POSITIVE_INFINITY,
    );
    if (!end) break;
    io.status?.('');
    const path = freePath(dir, name);
    const out = await open(path, 'wx', 0o644);
    try {
      await client.readFile(file.id, async (plain) => void (await out.write(plain)));
    } finally {
      await out.close();
    }
    // Remember not to fetch it again; the copy in the profile isn't needed any more.
    saved.add(file.id);
    await ctx.kv.set(SAVED_KEY, [...saved].slice(-5000));
    await client.files?.forget(file.id, { keepRecord: true });
    io.err(`Saved ${path}`);
    io.out(path);
    received++;
    if (!opts.keep) return 0;
  }
  return received > 0 ? 0 : 130;
}

/** Types for the files people send most; others go as application/octet-stream. */
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  mp3: 'audio/mpeg',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
