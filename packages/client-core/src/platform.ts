import type { ChatMessage, HostCaps, Platform, SignalData } from '@crocodile/protocol';
import type { Identity } from '@crocodile/crypto';
import type { NetworkProbe } from './caps';

/** Small async key-value store (settings, identity, caches). */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Local message history. Text never lives anywhere but on peers. */
export interface MessageStore {
  /** Returns false if that author's message with that id was already stored in the channel. */
  put(message: ChatMessage): Promise<boolean>;
  /**
   * Newest-last page of messages before a position: older than `before`, or
   * at `before` with an id below `beforeId`. Messages are ordered by
   * (ts, id), so messages sharing a time aren't skipped between pages.
   */
  page(
    channel: string,
    opts: { before?: number; beforeId?: string; limit: number },
  ): Promise<ChatMessage[]>;
  /**
   * Messages at or after `after`, oldest first. The boundary time is
   * included (the asker may lack some messages at it); ids weed out repeats.
   */
  since(channel: string, after: number, limit: number): Promise<ChatMessage[]>;
  latestTs(channel: string): Promise<number>;
  /** Deletes every stored message (account deletion). */
  clear(): Promise<void>;
}

/**
 * Encrypted file blocks (files.ts): kept as they travel, so they need no
 * other protection at rest. Block `index` of a file is `length` bytes.
 */
export interface FileBlockStore {
  write(fileId: string, index: number, block: Uint8Array): Promise<void>;
  /** Null when the block isn't there. */
  read(fileId: string, index: number, length: number): Promise<Uint8Array | null>;
  delete(fileId: string): Promise<void>;
  /** Bytes of files stored on this device. */
  usage?(): Promise<number>;
}

/** A running relay for a session this device hosts. */
export interface RelayHandle {
  handleSignal(from: string, data: SignalData): void;
  close(): Promise<void>;
}

export interface RelayStartOptions {
  sessionId: string;
  epoch: number;
  identity: Identity;
  /** This device's peer id; answers are signed as it. */
  hostPeer: string;
  slots: number;
  iceServers: { urls: string }[];
  /** Peer ids allowed to connect; checked on every offer. */
  members: () => string[];
  sendSignal: (to: string, data: SignalData) => void;
  /** The relay stopped by itself (its process died, say): the session starts another. */
  onFailed?: (reason: string) => void;
}

/**
 * Runs the host relay. Desktop implements this with a utility process;
 * web and mobile clients have none and therefore never host.
 */
export interface HostRelayAdapter {
  start(opts: RelayStartOptions): Promise<RelayHandle>;
}

/** Everything the client needs from the device it runs on. */
export interface PlatformAdapter {
  platform: Platform;
  appVersion: string;
  kv: KeyValueStore;
  messages: MessageStore;
  /** Absent means this device can't send or receive files. */
  files?: FileBlockStore;
  relay?: HostRelayAdapter;
  /** Browser WebRTC; absent means text/voice sessions are unavailable (e.g. unit tests). */
  rtc?: {
    RTCPeerConnection: typeof RTCPeerConnection;
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  };
  /** Device capability hints for host election. */
  capabilities?: () => Promise<Partial<HostCaps>>;
  /**
   * What the network allows for direct connections, from the coordination
   * server's STUN ports; `fresh` skips any cached result.
   */
  probeNetwork?: (fresh?: boolean) => Promise<NetworkProbe>;
  fetch?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

export class MemoryKeyValueStore implements KeyValueStore {
  private map = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.map.get(key)) as T | undefined;
  }
  async set<T>(key: string, value: T) {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

export class MemoryFileBlockStore implements FileBlockStore {
  private blocks = new Map<string, Uint8Array>();
  async write(fileId: string, index: number, block: Uint8Array) {
    this.blocks.set(`${fileId}/${index}`, block.slice());
  }
  async read(fileId: string, index: number, length: number) {
    const b = this.blocks.get(`${fileId}/${index}`);
    return b && b.length === length ? b.slice() : null;
  }
  async delete(fileId: string) {
    for (const k of [...this.blocks.keys()]) if (k.startsWith(`${fileId}/`)) this.blocks.delete(k);
  }
  async usage() {
    let n = 0;
    for (const b of this.blocks.values()) n += b.length;
    return n;
  }
}

const compareText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

export class MemoryMessageStore implements MessageStore {
  private byChannel = new Map<string, ChatMessage[]>();
  private ids = new Set<string>();

  async put(message: ChatMessage) {
    // Authors choose their ids, so one author's can't hide another's message.
    const key = `${message.ch}\n${message.author}\n${message.id}`;
    if (this.ids.has(key)) return false;
    this.ids.add(key);
    const list = this.byChannel.get(message.ch) ?? [];
    list.push(message);
    list.sort(
      (a, b) =>
        a.ts - b.ts ||
        (a.id === b.id ? 0 : a.id < b.id ? -1 : 1) ||
        compareText(a.author, b.author),
    );
    this.byChannel.set(message.ch, list);
    return true;
  }

  async page(channel: string, opts: { before?: number; beforeId?: string; limit: number }) {
    const { before, beforeId } = opts;
    const list = (this.byChannel.get(channel) ?? []).filter(
      (m) =>
        before === undefined ||
        m.ts < before ||
        (m.ts === before && beforeId !== undefined && m.id < beforeId),
    );
    // Don't split messages that share a time and an id (see the desktop store).
    let start = Math.max(0, list.length - opts.limit);
    while (
      start > 0 &&
      list[start - 1]!.ts === list[start]!.ts &&
      list[start - 1]!.id === list[start]!.id
    )
      start--;
    return list.slice(start);
  }

  async since(channel: string, after: number, limit: number) {
    return (this.byChannel.get(channel) ?? []).filter((m) => m.ts >= after).slice(0, limit);
  }

  async latestTs(channel: string) {
    return this.byChannel.get(channel)?.at(-1)?.ts ?? 0;
  }

  async clear() {
    this.byChannel.clear();
    this.ids.clear();
  }
}
