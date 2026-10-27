import { openDB, type IDBPDatabase } from 'idb';
import {
  browserCapabilities,
  createNetworkProber,
  type FileBlockStore,
  type HostRelayAdapter,
  type KeyValueStore,
  type MessageStore,
  type PlatformAdapter,
  type RelayHandle,
} from '@crocodile/client-core';
import { randomId } from '@crocodile/crypto';
import { fromB64u, toB64u, type ChatMessage, type SignalData } from '@crocodile/protocol';
import type { DesktopApi } from '../preload/preload';

declare global {
  interface Window {
    crocodile?: DesktopApi;
  }
}

export const desktop = window.crocodile;

interface StoredMessage {
  /** Row key: the message id, or for a later message under the same id `id:author:ch`. */
  id: string;
  /** The message's own id, and its author (rows from before these existed have neither). */
  mid?: string;
  author?: string;
  ch: string;
  ts: number;
  /** AES-256-GCM(iv ‖ ciphertext) of the message JSON. */
  blob: ArrayBuffer;
}

interface Schema {
  kv: { key: string; value: unknown };
  messages: { key: string; value: StoredMessage; indexes: { byChannelTs: [string, number] } };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | undefined;
function db() {
  dbPromise ??= openDB<Schema>('crocodile', 2, {
    upgrade(d, oldVersion) {
      // v1 stored plaintext; there is no v1 data worth migrating, start clean.
      if (oldVersion < 2) {
        for (const name of [...d.objectStoreNames]) d.deleteObjectStore(name);
      }
      d.createObjectStore('kv');
      const messages = d.createObjectStore('messages', { keyPath: 'id' });
      messages.createIndex('byChannelTs', ['ch', 'ts']);
    },
  });
  return dbPromise;
}

/** Secrets go to the OS keychain through the main process; the rest to IndexedDB. */
const SECURE_KEYS = new Set(['identity-seed', 'prekeys', 'local-data-key']);

async function secureGet(key: string): Promise<string | undefined> {
  if (desktop) return desktop.secure.get(key);
  return (await (await db()).get('kv', `secure:${key}`)) as string | undefined;
}

async function secureSet(key: string, value: string) {
  if (desktop) return desktop.secure.set(key, value);
  await (await db()).put('kv', value, `secure:${key}`);
}

/**
 * Local data at rest (message history, caches) is encrypted with a random
 * key that lives in the OS keychain, so copying the app's data folder off a
 * machine does not reveal conversations.
 */
let dataKey: Promise<CryptoKey> | undefined;
function localKey(): Promise<CryptoKey> {
  dataKey ??= (async () => {
    // Throws if the key is stored but the keychain is locked: never make a
    // new one then, or everything sealed with the old one is lost.
    let raw = await secureGet('local-data-key');
    if (!raw) {
      raw = toB64u(crypto.getRandomValues(new Uint8Array(32)));
      await secureSet('local-data-key', raw);
    }
    return crypto.subtle.importKey('raw', new Uint8Array(fromB64u(raw)), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  })().catch((err) => {
    dataKey = undefined;
    throw err;
  });
  return dataKey;
}

async function seal(value: unknown): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await localKey(),
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out.buffer;
}

async function unseal<T>(blob: ArrayBuffer): Promise<T | undefined> {
  try {
    const bytes = new Uint8Array(blob);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
      await localKey(),
      bytes.subarray(12),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return undefined;
  }
}

export const kv: KeyValueStore = {
  async get<T>(key: string) {
    if (SECURE_KEYS.has(key)) {
      const v = await secureGet(key);
      return (v === undefined ? undefined : JSON.parse(v)) as T | undefined;
    }
    const blob = (await (await db()).get('kv', key)) as ArrayBuffer | undefined;
    return blob instanceof ArrayBuffer ? unseal<T>(blob) : undefined;
  },
  async set<T>(key: string, value: T) {
    if (SECURE_KEYS.has(key)) return secureSet(key, JSON.stringify(value));
    await (await db()).put('kv', await seal(value), key);
  },
  async delete(key: string) {
    if (SECURE_KEYS.has(key)) {
      if (desktop) return desktop.secure.delete(key);
      return (await db()).delete('kv', `secure:${key}`);
    }
    await (await db()).delete('kv', key);
  },
};

const decode = async (rows: StoredMessage[]) =>
  (await Promise.all(rows.map((r) => unseal<ChatMessage>(r.blob)))).filter(
    (m): m is ChatMessage => !!m,
  );

export const messages: MessageStore = {
  async put(message) {
    const d = await db();
    // Authors choose their own ids: the first message under an id takes the
    // row named by it, and one from another author or channel gets a row of
    // its own rather than being taken for a repeat. Rows written before this
    // have no author on them; those are opened to see whose they are.
    const isRepeat = async (row: StoredMessage | undefined) => {
      if (!row) return false;
      if (row.author !== undefined) return row.ch === message.ch && row.author === message.author;
      const held = await unseal<ChatMessage>(row.blob);
      return !!held && held.ch === message.ch && held.author === message.author;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      let key = message.id;
      const plain = await d.get('messages', key);
      if (plain) {
        if (await isRepeat(plain)) return false;
        // Starts with the id and a NUL, so it sorts next to the rows of the same id
        // (paging relies on that), and is longer than any id (40 at most), so no
        // author can pick an id that is already taken by this key.
        key = `${message.id}\0${message.author}\0${message.ch}`.padEnd(41, '\0');
        if (await d.get('messages', key)) return false;
      }
      const blob = await seal(message);
      try {
        // `add` fails if another write took the key while this one sealed.
        await d.add('messages', {
          id: key,
          mid: message.id,
          author: message.author,
          ch: message.ch,
          ts: message.ts,
          blob,
        });
        return true;
      } catch (e) {
        if ((e as { name?: string }).name !== 'ConstraintError') throw e;
      }
    }
    return false;
  },
  async page(channel, { before, beforeId, limit }) {
    const d = await db();
    // Index entries are ordered by (ch, ts), then by id: the same order as
    // the timeline, so a position is a time and an id.
    const range = IDBKeyRange.bound(
      [channel, 0],
      [channel, before === undefined ? Number.MAX_SAFE_INTEGER : before],
      false,
      before !== undefined && beforeId === undefined,
    );
    const rows: StoredMessage[] = [];
    let cursor = await d
      .transaction('messages')
      .store.index('byChannelTs')
      .openCursor(range, 'prev');
    const messageId = (row: StoredMessage) => row.mid ?? row.id;
    while (cursor) {
      const row = cursor.value;
      // Never split messages that share a time and an id: a position is only
      // a time and an id, so the rest would not be reached by scrolling back.
      const last = rows.at(-1);
      if (
        rows.length >= limit &&
        !(last && last.ts === row.ts && messageId(last) === messageId(row))
      )
        break;
      if (!(beforeId !== undefined && row.ts === before && messageId(row) >= beforeId))
        rows.push(row);
      cursor = await cursor.continue();
    }
    return decode(rows.reverse());
  },
  async since(channel, after, limit) {
    const d = await db();
    const range = IDBKeyRange.bound(
      [channel, after],
      [channel, Number.MAX_SAFE_INTEGER],
      false,
      false,
    );
    return decode(await d.getAllFromIndex('messages', 'byChannelTs', range, limit));
  },
  async clear() {
    await (await db()).clear('messages');
  },
  async latestTs(channel) {
    const d = await db();
    const range = IDBKeyRange.bound([channel, 0], [channel, Number.MAX_SAFE_INTEGER]);
    const cursor = await d
      .transaction('messages')
      .store.index('byChannelTs')
      .openCursor(range, 'prev');
    return cursor?.value.ts ?? 0;
  },
};

/** Runs host relays in the Electron utility process. */
function relayAdapter(api: DesktopApi): HostRelayAdapter {
  const outbound = new Map<string, (to: string, data: SignalData) => void>();
  const failed = new Map<string, (reason: string) => void>();
  api.relay.onEvent((msg) => {
    if (msg.type === 'signal') outbound.get(msg.handle)?.(msg.to, msg.data);
    else if (msg.type === 'error') {
      console.warn('relay error', msg.message);
      // '*': the relay process exited, taking every relay with it.
      const lost = msg.handle === '*' ? [...failed.keys()] : [msg.handle];
      for (const h of lost) {
        const fn = failed.get(h);
        failed.delete(h);
        outbound.delete(h);
        fn?.(msg.message);
      }
    }
  });
  return {
    async start(opts) {
      const handle = randomId(6);
      outbound.set(handle, opts.sendSignal);
      if (opts.onFailed) failed.set(handle, opts.onFailed);
      await api.relay.send({
        type: 'start',
        handle,
        seed: toB64u(opts.identity.seed),
        hostPeer: opts.hostPeer,
        sessionId: opts.sessionId,
        epoch: opts.epoch,
        slots: opts.slots,
        iceServers: opts.iceServers,
      });
      const pushMembers = () =>
        void api.relay.send({ type: 'members', handle, members: opts.members() });
      pushMembers();
      const timer = setInterval(pushMembers, 2000);
      return {
        handleSignal(from, data) {
          if (data.type === 'offer') pushMembers();
          void api.relay.send({ type: 'signal', handle, from, data });
        },
        async close() {
          clearInterval(timer);
          outbound.delete(handle);
          failed.delete(handle);
          await api.relay.send({ type: 'close', handle });
        },
      } satisfies RelayHandle;
    },
  };
}

/** Encrypted file blocks, on disk through the main process. */
function fileStore(api: DesktopApi): FileBlockStore {
  return {
    write: (id, index, block) => api.files.write(id, index, block),
    read: async (id, index, length) => {
      const b = await api.files.read(id, index, length);
      return b ? new Uint8Array(b) : null;
    },
    delete: (id) => api.files.delete(id),
    usage: () => api.files.usage(),
  };
}

export function createPlatform(opts: {
  version: string;
  cpuCores?: number;
  stun: () => string[];
}): PlatformAdapter {
  // Only the coordination server's own STUN ports (it serves two, see
  // stunAltPort): no third-party server learns the user's address.
  const probeNetwork = createNetworkProber(RTCPeerConnection, opts.stun);
  return {
    platform: desktop ? 'desktop' : 'web',
    appVersion: opts.version,
    kv,
    messages,
    ...(desktop ? { relay: relayAdapter(desktop), files: fileStore(desktop) } : {}),
    rtc: { RTCPeerConnection, getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c) },
    probeNetwork,
    async capabilities() {
      const caps = await browserCapabilities();
      const { nat, udp } = await probeNetwork();
      // With UDP blocked nobody can reach this device directly: the worst host.
      return { ...caps, cpuCores: opts.cpuCores ?? caps.cpuCores, nat: udp ? nat : 'symmetric' };
    },
  };
}
