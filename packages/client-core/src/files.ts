import {
  blockHashAt,
  checkHashList,
  encryptFile,
  fileCipher,
  newFileId,
  newFileKey,
  randomId,
  sha256Async,
} from '@crocodile/crypto';
import {
  FILE_FRAME,
  FILE_FRAME_HEADER,
  FILE_FRAME_SIZE,
  FileLinkReply,
  FileLinkRequest,
  bytesEqual,
  fileBlockCipherSize,
  fileBlockCount,
  fileBlockPlainSize,
  fromB64u,
  toB64u,
  type FileManifest,
  type SealedPayload,
} from '@crocodile/protocol';
import type { FileLink, FileLinkChannel, FileLinkFactory } from './file-link';
import type { GroupSession, GroupSessionEvents } from './group-session';
import type { FileBlockStore, KeyValueStore } from './platform';

/**
 * File transfers (ARCHITECTURE.md §8a).
 *
 * A file is posted as a chat message carrying its manifest. To fetch it, a
 * device asks the session who has it (`file_want`); members holding the whole
 * file answer (`file_have`), and the device opens a direct WebRTC connection
 * to one of them, set up with sealed messages through the session and
 * offered STUN only, never a relay. Over it, the device asks for the list of
 * block hashes (checked against the manifest's root, which its author
 * signed), then for the blocks it lacks, checking each against its hash. A
 * dropped connection resumes from the blocks already stored, with whoever has
 * the file next. Blocks are stored as they travel, encrypted.
 */

export type FileStatus =
  /** Known, nothing fetched. */
  | 'none'
  /** Being encrypted for sending. */
  | 'preparing'
  /** Asking who has it. */
  | 'searching'
  /** Connecting to a member who has it. */
  | 'connecting'
  | 'downloading'
  /** All of it is on this device. */
  | 'done'
  /** Nobody who has it is online; it continues when someone is. */
  | 'unavailable'
  /** People who have it are online, but no direct connection to them works. */
  | 'no_direct'
  | 'failed';

export interface FileView {
  status: FileStatus;
  /** Bytes on this device. */
  done: number;
  size: number;
  /** We posted it. */
  mine: boolean;
  error?: string;
}

interface FileRecord {
  manifest: FileManifest;
  sessionId: string;
  ch: string;
  messageId: string;
  author: string;
  /** Blocks on this device: a bitmap, base64url. */
  have: string;
  complete: boolean;
  /** The block hash list once known (base64url). */
  hashes?: string;
  mine?: boolean;
}

export interface FilesContext {
  kv: KeyValueStore;
  blocks: FileBlockStore;
  links: FileLinkFactory;
  /** This device's peer id. */
  peer(): string;
  iceServers(): { urls: string }[];
  session(sessionId: string): GroupSession | undefined;
  /** Open (join) a session so its members can be asked. */
  openSession(sessionId: string): Promise<void>;
  isAllowedPeer(sessionId: string, peer: string): boolean;
  /** Serve files this device downloaded, not only its own. */
  shareDownloads(): boolean;
  changed(fileId: string, view: FileView | null): void;
  /** Someone fetched the whole file from this device. */
  served?(fileId: string, to: string): void;
  log(msg: string, extra?: Record<string, unknown>): void;
}

/** A source of plaintext for sending: a picked file, a path on disk. */
export interface FileSource {
  name: string;
  size: number;
  type: string;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Blocks asked for in one request. */
const BLOCKS_PER_REQUEST = 8;
/** How long to wait for someone to say they have a file. */
const SEARCH_MS = 6000;
/** While searching, ask again this often. */
const ASK_EVERY_MS = 1500;
/** For the holder's answer to an offer. */
const ANSWER_MS = 15_000;
/** A link with no data for this long is given up. */
const IDLE_MS = 30_000;
/** Queued bytes above which a sender waits. */
const HIGH_WATER = 1024 * 1024;
const MAX_UPLOADS = 4;
const MAX_DOWNLOADS = 3;
/** How often progress is written to storage while downloading. */
const SAVE_EVERY_MS = 2000;
/** Uploads to one member at a time. */
const MAX_UPLOADS_PER_PEER = 2;

export class FileTransfers {
  private records = new Map<string, FileRecord>();
  private views = new Map<string, FileView>();
  /** Files being fetched now, and how. */
  private active = new Map<string, Download>();
  /** Files we want but nobody could give us yet, by session. */
  private waiting = new Map<string, string>();
  /** Peers last seen in each session, to notice who joins. */
  private peersSeen = new Map<string, Set<string>>();
  /** Open uploads, and who each one is to. */
  private uploads = new Map<FileLink, string>();
  private answers = new Map<string, (p: Extract<SealedPayload, { type: 'file_link' }>) => void>();
  private loaded = false;

  constructor(private readonly ctx: FilesContext) {}

  async load() {
    const ids = (await this.ctx.kv.get<string[]>('files-index')) ?? [];
    for (const id of ids) {
      const r = await this.ctx.kv.get<FileRecord>(`file:${id}`);
      if (r) {
        this.records.set(id, r);
        this.publish(id);
      }
    }
    this.loaded = true;
  }

  view(id: string): FileView | undefined {
    return this.views.get(id);
  }

  manifest(id: string): FileManifest | undefined {
    return this.records.get(id)?.manifest;
  }

  /** Every file this device knows of and the session it belongs to. */
  list() {
    return [...this.records.values()].map((r) => ({
      id: r.manifest.id,
      sessionId: r.sessionId,
      mine: !!r.mine,
      complete: r.complete,
    }));
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Encrypts a file into storage and returns its manifest (without
   * preview fields) for the message that posts it.
   */
  async prepare(
    source: FileSource,
    onProgress?: (done: number) => void,
    /**
     * False: don't keep an encrypted copy; the block store makes blocks from
     * the original when asked (a command line tool sending a big file).
     */
    store = true,
  ): Promise<{ manifest: FileManifest; hashes: Uint8Array }> {
    const id = newFileId();
    const key = newFileKey();
    const { hashes, root } = await encryptFile(
      { id, key, size: source.size, read: (o, l) => source.read(o, l) },
      async (i, block) => {
        if (store) await this.ctx.blocks.write(id, i, block);
      },
      onProgress,
    );
    return {
      manifest: {
        id,
        name: source.name,
        size: source.size,
        type: source.type,
        key,
        root,
      },
      hashes,
    };
  }

  /** The prepared file was posted: keep it and serve it. */
  async posted(
    sessionId: string,
    message: { id: string; ch: string; author: string; file: FileManifest },
    hashes: Uint8Array,
  ) {
    const n = fileBlockCount(message.file.size);
    const have = new Uint8Array(Math.ceil(n / 8)).fill(0xff);
    await this.save({
      manifest: message.file,
      sessionId,
      ch: message.ch,
      messageId: message.id,
      author: message.author,
      have: toB64u(have),
      complete: true,
      hashes: toB64u(hashes),
      mine: true,
    });
  }

  /** A message with a file arrived (live or from history). */
  async noted(
    sessionId: string,
    message: { id: string; ch: string; author: string; file: FileManifest },
    mine: boolean,
  ) {
    if (this.records.has(message.file.id)) return;
    const n = fileBlockCount(message.file.size);
    await this.save({
      manifest: message.file,
      sessionId,
      ch: message.ch,
      messageId: message.id,
      author: message.author,
      have: toB64u(new Uint8Array(Math.ceil(n / 8))),
      complete: false,
      ...(mine ? { mine: true } : {}),
    });
  }

  /** Its author deleted the message a file was posted in. */
  async forgetMessage(messageId: string, author: string) {
    for (const r of [...this.records.values()])
      if (r.messageId === messageId && r.author === author) await this.forget(r.manifest.id);
  }

  /** The message was deleted, or the user cleared the file: drop it. */
  async forget(id: string, opts: { keepRecord?: boolean } = {}) {
    this.active.get(id)?.cancel();
    this.waiting.delete(id);
    const r = this.records.get(id);
    await this.ctx.blocks.delete(id);
    if (!r) return;
    if (opts.keepRecord) {
      const n = fileBlockCount(r.manifest.size);
      await this.save({
        ...r,
        have: toB64u(new Uint8Array(Math.ceil(n / 8))),
        complete: false,
        mine: false,
      });
      return;
    }
    this.records.delete(id);
    this.views.delete(id);
    await this.ctx.kv.delete(`file:${id}`);
    await this.ctx.kv.set('files-index', [...this.records.keys()]);
    this.ctx.changed(id, null);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Decrypts a complete file block by block. */
  async read(id: string, sink: (plain: Uint8Array) => Promise<void> | void) {
    const r = this.records.get(id);
    if (!r?.complete) throw new Error('The file is not on this device yet');
    const { size } = r.manifest;
    const cipher = await fileCipher(r.manifest.id, r.manifest.key, size);
    for (let i = 0; i < fileBlockCount(size); i++) {
      const block = await this.ctx.blocks.read(id, i, fileBlockCipherSize(size, i));
      const plain = block && (await cipher.decryptBlock(i, block));
      if (!plain) {
        await this.forget(id, { keepRecord: true });
        throw new Error('The stored copy of this file is damaged; download it again');
      }
      await sink(plain);
    }
  }

  // -------------------------------------------------------------------------
  // Downloading
  // -------------------------------------------------------------------------

  /** Fetch a file. Resolves once started; follow progress through views. */
  async download(id: string) {
    const r = this.records.get(id);
    if (!r) throw new Error('Unknown file');
    if (r.complete || this.active.has(id)) return;
    if (this.active.size >= MAX_DOWNLOADS) {
      this.waiting.set(id, r.sessionId);
      this.setView(id, { status: 'searching' });
      return;
    }
    const d = new Download(this, r);
    this.active.set(id, d);
    this.waiting.delete(id);
    void d.run().finally(() => {
      if (this.active.get(id) === d) this.active.delete(id);
      this.startQueued();
    });
  }

  private startQueued() {
    for (const [id] of this.waiting) {
      if (this.active.size >= MAX_DOWNLOADS) return;
      const v = this.views.get(id);
      if (v?.status === 'searching') void this.download(id);
    }
  }

  /** People joined a session: ask again for what we still want there. */
  sessionChanged(sessionId: string) {
    const session = this.ctx.session(sessionId);
    if (!session?.connected) return;
    const peers = new Set(session.peers.keys());
    const before = this.peersSeen.get(sessionId) ?? new Set<string>();
    this.peersSeen.set(sessionId, peers);
    if (![...peers].some((p) => !before.has(p))) return;
    const wanted = [...this.waiting].filter(([, sid]) => sid === sessionId).map(([id]) => id);
    for (const id of wanted) session.sendGroup({ type: 'file_want', file: id });
  }

  /** Our own sealed or group file messages, from a session. */
  onMessage(sessionId: string, from: string, payload: GroupSessionEvents['file']['payload']) {
    if (from === this.ctx.peer()) return;
    switch (payload.type) {
      case 'file_want':
        return this.onWant(sessionId, from, payload.file);
      case 'file_have': {
        const r = this.records.get(payload.file);
        if (!r || r.sessionId !== sessionId || r.complete) return;
        const d = this.active.get(payload.file);
        if (d) d.holderFound(from);
        else if (this.waiting.has(payload.file)) {
          void this.download(payload.file).then(() =>
            this.active.get(payload.file)?.holderFound(from),
          );
        }
        return;
      }
      case 'file_link':
        if (payload.kind === 'offer') return void this.onOffer(sessionId, from, payload);
        this.answers.get(`${from}|${payload.link}`)?.(payload);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Serving
  // -------------------------------------------------------------------------

  private mayServe(sessionId: string, from: string, id: string) {
    const r = this.records.get(id);
    return (
      !!r &&
      r.complete &&
      !!r.hashes &&
      r.sessionId === sessionId &&
      (r.mine || this.ctx.shareDownloads()) &&
      this.ctx.isAllowedPeer(sessionId, from)
    );
  }

  private wantSeen = new Map<string, number>();

  private onWant(sessionId: string, from: string, id: string) {
    if (!this.mayServe(sessionId, from, id)) return;
    // One answer per asker and file every few seconds.
    const key = `${from}|${id}`;
    const now = Date.now();
    if (now - (this.wantSeen.get(key) ?? 0) < 3000) return;
    this.wantSeen.set(key, now);
    if (this.wantSeen.size > 1000) this.wantSeen.clear();
    void this.ctx.session(sessionId)?.sendSealedTo(from, { type: 'file_have', file: id });
  }

  private async onOffer(
    sessionId: string,
    from: string,
    offer: Extract<SealedPayload, { type: 'file_link' }>,
  ) {
    const session = this.ctx.session(sessionId);
    if (!session) return;
    const reject = () =>
      session.sendSealedTo(from, {
        type: 'file_link',
        file: offer.file,
        link: offer.link,
        kind: 'reject',
      });
    if (
      !offer.sdp ||
      !this.mayServe(sessionId, from, offer.file) ||
      this.uploads.size >= MAX_UPLOADS ||
      [...this.uploads.values()].filter((p) => p === from).length >= MAX_UPLOADS_PER_PEER
    ) {
      await reject();
      return;
    }
    const link = this.ctx.links({
      self: this.ctx.peer(),
      remote: from,
      iceServers: this.ctx.iceServers(),
    });
    this.uploads.set(link, from);
    try {
      const sdp = await link.acceptOffer(offer.sdp);
      await session.sendSealedTo(from, {
        type: 'file_link',
        file: offer.file,
        link: offer.link,
        kind: 'answer',
        sdp,
      });
      const channel = await link.ready;
      await this.serve(this.records.get(offer.file)!, channel, from);
    } catch (err) {
      this.ctx.log('file upload ended', { file: offer.file, to: from, err: String(err) });
    } finally {
      link.close();
      this.uploads.delete(link);
    }
  }

  private async serve(r: FileRecord, channel: FileLinkChannel, to: string) {
    const reader = new FrameReader(channel);
    const { size, id } = r.manifest;
    const hashes = fromB64u(r.hashes!);
    const n = fileBlockCount(size);
    try {
      for (;;) {
        const msg = await reader.next(IDLE_MS * 2);
        if (typeof msg !== 'string') return;
        const parsed = FileLinkRequest.safeParse(safeJson(msg));
        if (!parsed.success) return;
        const req = parsed.data;
        if (req.t === 'done') {
          this.ctx.served?.(id, to);
          return;
        }
        if (req.t === 'hashes') {
          await sendFramed(channel, FILE_FRAME.hashes, 0, hashes);
          continue;
        }
        if (req.from > req.to || req.to >= n || req.to - req.from >= 64) {
          channel.send(JSON.stringify({ t: 'error', reason: 'bad range' } satisfies FileLinkReply));
          return;
        }
        for (let i = req.from; i <= req.to; i++) {
          const block = await this.ctx.blocks.read(id, i, fileBlockCipherSize(size, i));
          // Never send what doesn't match what the author signed.
          if (!block || !bytesEqual(await sha256Async(block), blockHashAt(hashes, i))) {
            channel.send(
              JSON.stringify({ t: 'error', reason: 'not available' } satisfies FileLinkReply),
            );
            await this.forget(id, { keepRecord: true });
            return;
          }
          await sendFramed(channel, FILE_FRAME.block, i, block);
        }
      }
    } finally {
      reader.stop();
      channel.close();
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** @internal for Download */
  record(id: string) {
    return this.records.get(id);
  }

  /** @internal */
  async save(r: FileRecord) {
    const isNew = !this.records.has(r.manifest.id);
    this.records.set(r.manifest.id, r);
    await this.ctx.kv.set(`file:${r.manifest.id}`, r);
    if (isNew) await this.ctx.kv.set('files-index', [...this.records.keys()]);
    this.publish(r.manifest.id);
  }

  private publish(id: string) {
    const r = this.records.get(id)!;
    const prev = this.views.get(id);
    const done = r.complete ? r.manifest.size : haveBytes(r);
    const status: FileStatus = r.complete
      ? 'done'
      : prev && prev.status !== 'done'
        ? prev.status
        : 'none';
    this.setView(id, { status, done, size: r.manifest.size, mine: !!r.mine });
  }

  /** @internal */
  setView(id: string, patch: Partial<FileView>) {
    const r = this.records.get(id);
    if (!r) return;
    const prev = this.views.get(id) ?? {
      status: 'none' as const,
      done: haveBytes(r),
      size: r.manifest.size,
      mine: !!r.mine,
    };
    const next: FileView = { ...prev, ...patch };
    if (patch.status && patch.status !== 'failed') delete next.error;
    this.views.set(id, next);
    this.ctx.changed(id, next);
  }

  /** @internal */
  wait(id: string, sessionId: string) {
    this.waiting.set(id, sessionId);
  }

  /** @internal */
  expectAnswer(from: string, link: string) {
    return new Promise<Extract<SealedPayload, { type: 'file_link' }>>((res, rej) => {
      const key = `${from}|${link}`;
      const t = setTimeout(() => {
        this.answers.delete(key);
        rej(new Error('no answer'));
      }, ANSWER_MS);
      this.answers.set(key, (p) => {
        clearTimeout(t);
        this.answers.delete(key);
        res(p);
      });
    });
  }

  get context() {
    return this.ctx;
  }

  get isLoaded() {
    return this.loaded;
  }

  close() {
    for (const d of this.active.values()) d.cancel();
    for (const l of this.uploads.keys()) l.close();
  }
}

/** One file being fetched. */
class Download {
  private holders: string[] = [];
  /** Tries per holder that got nothing; one that keeps delivering is tried again. */
  private misses = new Map<string, number>();
  private wake?: () => void;
  private cancelled = false;
  private link?: FileLink;
  private noDirect = 0;

  constructor(
    private readonly files: FileTransfers,
    private r: FileRecord,
  ) {}

  holderFound(peer: string) {
    if ((this.misses.get(peer) ?? 0) >= 2 || this.holders.includes(peer)) return;
    this.holders.push(peer);
    this.wake?.();
  }

  cancel() {
    this.cancelled = true;
    this.link?.close();
    this.wake?.();
  }

  private get ctx() {
    return this.files.context;
  }

  async run() {
    const id = this.r.manifest.id;
    const sessionId = this.r.sessionId;
    this.files.setView(id, { status: 'searching' });
    await this.ctx.openSession(sessionId).catch(() => {});
    for (let round = 0; !this.cancelled; round++) {
      if (this.holders.length === 0) {
        this.files.setView(id, { status: 'searching' });
        // Ask, and again while nobody answers: the session may still be
        // connecting (or moving to a new host) when the search starts.
        const ask = () => {
          const session = this.ctx.session(sessionId);
          if (session?.connected) session.sendGroup({ type: 'file_want', file: id });
        };
        ask();
        const again = setInterval(ask, ASK_EVERY_MS);
        await new Promise<void>((res) => {
          const t = setTimeout(res, SEARCH_MS);
          this.wake = () => {
            clearTimeout(t);
            res();
          };
        });
        clearInterval(again);
        this.wake = undefined;
      }
      if (this.cancelled) return;
      const holder = this.holders.shift();
      if (!holder) {
        // Nobody answered: continue when someone who has it turns up.
        this.files.wait(id, sessionId);
        this.files.setView(id, { status: this.noDirect > 0 ? 'no_direct' : 'unavailable' });
        return;
      }
      const before = haveBytes(this.files.record(id) ?? this.r);
      const result = await this.tryHolder(holder).catch((err: unknown) => {
        this.ctx.log('file download failed', { file: id, from: holder, err: String(err) });
        return 'error' as const;
      });
      if (result === 'done' || this.cancelled) return;
      if (result === 'no_direct') this.noDirect++;
      this.r = this.files.record(id) ?? this.r;
      // A holder that got us further gets another go; one that didn't, fewer.
      if (haveBytes(this.r) > before) this.misses.delete(holder);
      else this.misses.set(holder, (this.misses.get(holder) ?? 0) + 1);
    }
  }

  private async tryHolder(holder: string): Promise<'done' | 'no_direct' | 'error'> {
    const id = this.r.manifest.id;
    const session = this.ctx.session(this.r.sessionId);
    if (!session) return 'error';
    this.files.setView(id, { status: 'connecting' });
    const link = this.ctx.links({
      self: this.ctx.peer(),
      remote: holder,
      iceServers: this.ctx.iceServers(),
    });
    this.link = link;
    try {
      const linkId = randomId(10);
      const offer = await link.createOffer();
      const answered = this.files.expectAnswer(holder, linkId);
      answered.catch(() => {});
      if (
        !(await session.sendSealedTo(holder, {
          type: 'file_link',
          file: id,
          link: linkId,
          kind: 'offer',
          sdp: offer,
        }))
      )
        return 'error';
      const answer = await answered;
      if (answer.kind !== 'answer' || !answer.sdp) return 'error';
      await link.acceptAnswer(answer.sdp);
      let channel: FileLinkChannel;
      try {
        channel = await link.ready;
      } catch {
        return 'no_direct';
      }
      this.files.setView(id, { status: 'downloading' });
      return await this.receive(channel);
    } finally {
      link.close();
      this.link = undefined;
    }
  }

  private async receive(channel: FileLinkChannel): Promise<'done' | 'error'> {
    const reader = new FrameReader(channel);
    const m = this.r.manifest;
    const n = fileBlockCount(m.size);
    // Progress lives here while blocks arrive and is saved now and then:
    // re-encoding it for every block would cost too much on huge files.
    const have = fromB64u(this.r.have);
    let done = haveBytes(this.r);
    let savedAt = Date.now();
    const save = async () => {
      savedAt = Date.now();
      this.r = { ...this.r, have: toB64u(have) };
      await this.files.save(this.r);
    };
    try {
      let hashes = this.r.hashes ? fromB64u(this.r.hashes) : null;
      if (!hashes) {
        channel.send(JSON.stringify({ t: 'hashes' } satisfies FileLinkRequest));
        const list = await readFramed(reader, FILE_FRAME.hashes, 0, n * 32);
        if (!list || !(await checkHashList(list, m.size, m.root))) return 'error';
        hashes = list;
        this.r = { ...this.r, hashes: toB64u(list) };
        await this.files.save(this.r);
      }
      const missing: number[] = [];
      for (let i = 0; i < n; i++) if (!bit(have, i)) missing.push(i);
      for (const [from, to] of ranges(missing, BLOCKS_PER_REQUEST)) {
        channel.send(JSON.stringify({ t: 'get', from, to } satisfies FileLinkRequest));
        for (let i = from; i <= to; i++) {
          const block = await readFramed(
            reader,
            FILE_FRAME.block,
            i,
            fileBlockCipherSize(m.size, i),
          );
          if (!block || this.cancelled) return 'error';
          if (!bytesEqual(await sha256Async(block), blockHashAt(hashes, i))) {
            this.ctx.log('file block failed its hash', { file: m.id, block: i });
            return 'error';
          }
          await this.ctx.blocks.write(m.id, i, block);
          setBit(have, i);
          done += fileBlockPlainSize(m.size, i);
          this.files.setView(m.id, { done });
          if (Date.now() - savedAt > SAVE_EVERY_MS) await save();
        }
      }
      this.r = { ...this.r, have: toB64u(have), complete: true };
      await this.files.save(this.r);
      this.files.setView(m.id, { status: 'done', done: m.size });
      // Let the holder know (a sender that stays only until then can go),
      // and give the message time to leave before the link closes.
      channel.send(JSON.stringify({ t: 'done' } satisfies FileLinkRequest));
      for (let t = 0; t < 20 && channel.bufferedAmount > 0; t++)
        await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
      return 'done';
    } finally {
      reader.stop();
      if (!this.r.complete) await save();
    }
  }
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** Incoming messages on a link, one at a time. */
class FrameReader {
  private queue: (string | Uint8Array)[] = [];
  private waiter?: (m: string | Uint8Array | null) => void;
  private closed = false;
  private offs: (() => void)[];

  constructor(channel: FileLinkChannel) {
    this.offs = [
      channel.on('message', (m) => {
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = undefined;
          w(m);
        } else this.queue.push(m);
      }),
      channel.on('close', () => {
        this.closed = true;
        this.waiter?.(null);
      }),
    ];
  }

  /** The next message, or null on close or after `timeoutMs` without one. */
  next(timeoutMs = IDLE_MS): Promise<string | Uint8Array | null> {
    const m = this.queue.shift();
    if (m !== undefined) return Promise.resolve(m);
    if (this.closed) return Promise.resolve(null);
    return new Promise((res) => {
      const t = setTimeout(() => {
        this.waiter = undefined;
        res(null);
      }, timeoutMs);
      this.waiter = (v) => {
        clearTimeout(t);
        res(v);
      };
    });
  }

  stop() {
    for (const off of this.offs) off();
  }
}

async function sendFramed(channel: FileLinkChannel, kind: number, index: number, data: Uint8Array) {
  for (let off = 0; off < data.length || (off === 0 && data.length === 0); off += FILE_FRAME_SIZE) {
    while (channel.bufferedAmount > HIGH_WATER) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, 50);
        channel.once('drained', () => {
          clearTimeout(t);
          res();
        });
      });
    }
    const part = data.subarray(off, off + FILE_FRAME_SIZE);
    const frame = new Uint8Array(FILE_FRAME_HEADER + part.length);
    const dv = new DataView(frame.buffer);
    dv.setUint8(0, kind);
    dv.setUint32(1, index);
    dv.setUint32(5, off);
    frame.set(part, FILE_FRAME_HEADER);
    if (!channel.send(frame)) throw new Error('link closed');
    if (data.length === 0) break;
  }
}

/** Reads `length` bytes of one item sent with sendFramed; null on anything unexpected. */
async function readFramed(reader: FrameReader, kind: number, index: number, length: number) {
  const out = new Uint8Array(length);
  let got = 0;
  do {
    const m = await reader.next();
    if (!m || typeof m === 'string' || m.length < FILE_FRAME_HEADER) return null;
    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
    const part = m.subarray(FILE_FRAME_HEADER);
    if (dv.getUint8(0) !== kind || dv.getUint32(1) !== index || dv.getUint32(5) !== got)
      return null;
    if (got + part.length > length) return null;
    out.set(part, got);
    got += part.length;
    if (part.length === 0) break;
  } while (got < length);
  return got === length ? out : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bit(bits: Uint8Array, i: number) {
  return ((bits[i >> 3] ?? 0) >> (i & 7)) & 1;
}

function setBit(bits: Uint8Array, i: number) {
  bits[i >> 3] = (bits[i >> 3] ?? 0) | (1 << (i & 7));
}

function haveBytes(r: FileRecord) {
  if (r.complete) return r.manifest.size;
  const bits = fromB64u(r.have);
  let n = 0;
  for (let i = 0; i < fileBlockCount(r.manifest.size); i++)
    if (bit(bits, i)) n += fileBlockPlainSize(r.manifest.size, i);
  return n;
}

/** Consecutive runs of indexes, each at most `max` long. */
function ranges(indexes: number[], max: number): [number, number][] {
  const out: [number, number][] = [];
  for (const i of indexes) {
    const last = out.at(-1);
    if (last && last[1] === i - 1 && last[1] - last[0] + 1 < max) last[1] = i;
    else out.push([i, i]);
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
