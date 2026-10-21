import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { open, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { RTCPeerConnection } from 'werift';
import {
  MemoryMessageStore,
  createNetworkProber,
  type FileBlockStore,
  type HostRelayAdapter,
  type KeyValueStore,
  type PlatformAdapter,
  type RelayHandle,
} from '@crocodile/client-core';
import { HostRelay } from '@crocodile/relay';
import { fileCipher, type FileCipher } from '@crocodile/crypto';
import {
  FILE_BLOCK_SIZE,
  FILE_TAG_SIZE,
  fileBlockPlainSize,
  type FileManifest,
} from '@crocodile/protocol';

/**
 * Everything the client needs on a computer without a UI: settings and keys
 * in a file only this user can read, file blocks on disk, WebRTC from werift
 * (pure TypeScript, so one file runs everywhere) and an in-process host relay.
 */

/**
 * Settings, keys and caches: one JSON file, readable only by this user
 * (there is no keychain to lean on, as the desktop app does). Writes are
 * batched and atomic.
 */
export class JsonFileStore implements KeyValueStore {
  private data: Record<string, unknown>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly path: string) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      // Only a file that isn't there yet means a new profile: anything else
      // would be overwritten, keys and all, by the next save.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = {};
        return;
      }
      throw new Error(`Can't read ${path}: ${(err as Error).message}`, { cause: err });
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error(
        `${path} is damaged. It holds this computer's keys, so it was left as it is: restore it from a backup, or move it away to start again.`,
      );
    this.data = data as Record<string, unknown>;
  }

  async get<T>(key: string) {
    const v = this.data[key];
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  async set<T>(key: string, value: T) {
    this.data[key] = structuredClone(value);
    this.schedule();
  }

  async delete(key: string) {
    delete this.data[key];
    this.schedule();
  }

  private schedule() {
    this.timer ??= setTimeout(() => this.flush(), 200);
  }

  /** Writes now (also called before exiting). */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(this.data));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

const SLOT = FILE_BLOCK_SIZE + FILE_TAG_SIZE;
const ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * Encrypted blocks of files being received, on disk; and files being sent,
 * read from where they are and encrypted again block by block when someone
 * asks (the same bytes every time, so the hashes the message carries match;
 * the engine checks each block before it leaves).
 */
export class CliFileStore implements FileBlockStore {
  private sources = new Map<string, { path: string; size: number; cipher: Promise<FileCipher> }>();

  constructor(private readonly dir: string) {}

  /** Serve a file being sent from its original path. */
  addSource(file: FileManifest, path: string) {
    this.sources.set(file.id, {
      path,
      size: file.size,
      cipher: fileCipher(file.id, file.key, file.size),
    });
  }

  private path(id: string) {
    if (!ID.test(id)) throw new Error('bad file id');
    return join(this.dir, id);
  }

  async write(id: string, index: number, block: Uint8Array) {
    mkdirSync(this.dir, { recursive: true });
    let f: FileHandle;
    try {
      f = await open(this.path(id), 'r+');
    } catch {
      f = await open(this.path(id), 'w+', 0o600);
    }
    try {
      await f.write(block, 0, block.length, index * SLOT);
    } finally {
      await f.close();
    }
  }

  async read(id: string, index: number, length: number) {
    const src = this.sources.get(id);
    if (src) {
      const plainLength = fileBlockPlainSize(src.size, index);
      if (plainLength + FILE_TAG_SIZE !== length) return null;
      const f = await open(src.path, 'r').catch(() => null);
      if (!f) return null;
      try {
        const plain = new Uint8Array(plainLength);
        const { bytesRead } = await f.read(plain, 0, plainLength, index * FILE_BLOCK_SIZE);
        if (bytesRead !== plainLength) return null;
        return (await src.cipher).encryptBlock(index, plain);
      } finally {
        await f.close();
      }
    }
    const f = await open(this.path(id), 'r').catch(() => null);
    if (!f) return null;
    try {
      const out = new Uint8Array(length);
      const { bytesRead } = await f.read(out, 0, length, index * SLOT);
      return bytesRead === length ? out : null;
    } finally {
      await f.close();
    }
  }

  async delete(id: string) {
    this.sources.delete(id);
    await rm(this.path(id), { force: true });
  }

  async usage() {
    let total = 0;
    for (const name of await readdir(this.dir).catch(() => [])) {
      const s = await stat(join(this.dir, name)).catch(() => null);
      if (s) total += s.size;
    }
    return total;
  }
}

/** Host relays run in this process (a desktop runs them in a helper process). */
function relayAdapter(): HostRelayAdapter {
  return {
    async start(opts): Promise<RelayHandle> {
      const relay = new HostRelay({
        sessionId: opts.sessionId,
        epoch: opts.epoch,
        identity: opts.identity,
        hostPeer: opts.hostPeer,
        slots: opts.slots,
        iceServers: opts.iceServers,
        includeLoopback: true,
        admit: (peer) => opts.members().includes(peer),
        sendSignal: opts.sendSignal,
      });
      return {
        handleSignal: (from, data) => void relay.handleSignal(from, data),
        close: () => relay.close(),
      };
    },
  };
}

export function createCliPlatform(opts: { dir: string; version: string; stun: () => string[] }): {
  platform: PlatformAdapter;
  kv: JsonFileStore;
  files: CliFileStore;
} {
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const kv = new JsonFileStore(join(opts.dir, 'state.json'));
  const files = new CliFileStore(join(opts.dir, 'files'));
  const PC = RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection;
  const probeNetwork = createNetworkProber(PC, opts.stun);
  const platform: PlatformAdapter = {
    platform: 'bot',
    appVersion: opts.version,
    kv,
    messages: new MemoryMessageStore(),
    files,
    relay: relayAdapter(),
    rtc: { RTCPeerConnection: PC },
    probeNetwork,
    async capabilities() {
      const probe = await probeNetwork().catch(() => null);
      return {
        cpuCores: cpus().length,
        nat: probe ? (probe.udp ? probe.nat : 'symmetric') : 'unknown',
      };
    },
  };
  return { platform, kv, files };
}
