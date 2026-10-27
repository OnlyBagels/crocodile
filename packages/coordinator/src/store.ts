import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SignedRecord } from '@crocodile/protocol';

/** A sealed box held for an offline device (opt-in mailbox). */
export interface StoredMail {
  id: string;
  /** Recipient peer id. */
  to: string;
  /** Recipient user id (for per-recipient quotas). */
  toUser: string;
  /** Sender user id. */
  from: string;
  /** SealedBox JSON; opaque to the server. */
  box: string;
  createdAt: number;
  expiresAt: number;
}

export interface StoredRecord {
  seq: number;
  record: SignedRecord;
}

/**
 * Durable state of a coordination server: replicated signed records plus a
 * little local bookkeeping. Every write gets a local, strictly increasing seq
 * that mesh peers use as their replication cursor.
 */
export interface Store {
  readonly kind: 'sqlite' | 'memory';
  get(key: string): SignedRecord | undefined;
  /** Inserts or replaces; caller has already validated the record. */
  put(record: SignedRecord): number;
  /** Records under a prefix in key order, those after the key `after` if one is given. */
  listPrefix(prefix: string, limit: number, after?: string): SignedRecord[];
  since(seq: number, limit: number): StoredRecord[];
  latestSeq(): number;
  /** Records indexed under a term (see indexTerms). */
  findByTerm(term: string, limit: number): SignedRecord[];
  countByTerm(term: string): number;
  /** Removes a record outright (account deletion); replication cursors are unaffected. */
  delete(key: string): void;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  mailPut(item: StoredMail): void;
  /** Unexpired items for a recipient device, oldest first. */
  mailFor(peer: string, now: number, limit: number): StoredMail[];
  /** Deletes the given items addressed to `peer`; returns how many. */
  mailDelete(peer: string, ids: string[]): number;
  mailExpire(now: number): number;
  mailCount(filter: { toUser?: string; from?: string }): number;
  /** Deletes all mail to or from a user (account deletion); returns how many. */
  mailDeleteUser(userId: string): number;
  close(): void;
}

/** Bump when indexTerms changes; stores rebuild their index on open. */
export const INDEX_VERSION = 3;

/** Secondary index terms so common queries avoid full scans. */
export function indexTerms(record: SignedRecord): string[] {
  switch (record.kind) {
    case 'profile': {
      const name = (record.body as { username: string }).username.toLowerCase();
      return [`name:${name}`];
    }
    case 'friends': {
      // Only the legacy, readable form; a sealed list says nothing to index.
      const body = record.body as { friends?: string[] };
      return (body.friends ?? []).map((f) => `friend-of:${f}`);
    }
    case 'space':
      return [`owner:${(record.body as { owner: string }).owner}`];
    case 'invite':
      return [`invite-space:${(record.body as { spaceId: string }).spaceId}`];
    case 'member': {
      const body = record.body as { userId: string; left?: boolean };
      // member-user: active memberships; member-any: all of them (for account deletion).
      const any = `member-any:${body.userId}`;
      return body.left ? [any] : [`member-user:${body.userId}`, any];
    }
    case 'note': {
      // Unread notes count against the recipient's quota.
      const body = record.body as { deleted?: boolean };
      return body.deleted ? [] : [`note-to:${record.key.split(':')[1]}`];
    }
    default:
      return [];
  }
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private records = new Map<string, StoredRecord>();
  private bySeq = new Map<number, string>();
  private terms = new Map<string, Set<string>>();
  private meta = new Map<string, string>();
  private mail = new Map<string, StoredMail>();
  private seq = 0;
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** With a path, state is snapshotted to a JSON file every few seconds. */
  constructor(private readonly snapshotPath?: string) {
    if (snapshotPath && existsSync(snapshotPath)) {
      const data = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
        records: StoredRecord[];
        meta: [string, string][];
        mail?: StoredMail[];
      };
      for (const m of data.mail ?? []) this.mail.set(m.id, m);
      for (const r of data.records.sort((a, b) => a.seq - b.seq)) this.insert(r.record, r.seq);
      this.meta = new Map(data.meta);
    }
    if (snapshotPath) {
      this.timer = setInterval(() => this.flush(), 5000);
      this.timer.unref?.();
    }
  }

  private insert(record: SignedRecord, seq: number) {
    const prev = this.records.get(record.key);
    if (prev) {
      this.bySeq.delete(prev.seq);
      for (const t of indexTerms(prev.record)) this.terms.get(t)?.delete(record.key);
    }
    this.records.set(record.key, { seq, record });
    this.bySeq.set(seq, record.key);
    for (const t of indexTerms(record)) {
      let set = this.terms.get(t);
      if (!set) this.terms.set(t, (set = new Set()));
      set.add(record.key);
    }
    this.seq = Math.max(this.seq, seq);
  }

  get(key: string) {
    return this.records.get(key)?.record;
  }

  put(record: SignedRecord) {
    const seq = ++this.seq;
    this.insert(record, seq);
    this.dirty = true;
    return seq;
  }

  delete(key: string) {
    const prev = this.records.get(key);
    if (!prev) return;
    this.records.delete(key);
    this.bySeq.delete(prev.seq);
    for (const t of indexTerms(prev.record)) this.terms.get(t)?.delete(key);
    this.dirty = true;
  }

  countByTerm(term: string) {
    return this.terms.get(term)?.size ?? 0;
  }

  // Sorted on every call: this store is for tests and development.
  listPrefix(prefix: string, limit: number, after?: string) {
    const keys: string[] = [];
    for (const key of this.records.keys())
      if (key.startsWith(prefix) && (after === undefined || key > after)) keys.push(key);
    return keys
      .sort()
      .slice(0, limit)
      .map((key) => this.records.get(key)!.record);
  }

  since(seq: number, limit: number) {
    const out: StoredRecord[] = [];
    for (let s = seq + 1; s <= this.seq && out.length < limit; s++) {
      const key = this.bySeq.get(s);
      if (key) out.push(this.records.get(key)!);
    }
    return out;
  }

  latestSeq() {
    return this.seq;
  }

  findByTerm(term: string, limit: number) {
    const keys = [...(this.terms.get(term) ?? [])].slice(0, limit);
    return keys.map((k) => this.records.get(k)!.record);
  }

  getMeta(key: string) {
    return this.meta.get(key);
  }

  setMeta(key: string, value: string) {
    this.meta.set(key, value);
    this.dirty = true;
  }

  mailPut(item: StoredMail) {
    this.mail.set(item.id, item);
    this.dirty = true;
  }

  mailFor(peer: string, now: number, limit: number) {
    return [...this.mail.values()]
      .filter((m) => m.to === peer && m.expiresAt > now)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }

  mailDelete(peer: string, ids: string[]) {
    let n = 0;
    for (const id of ids) {
      if (this.mail.get(id)?.to === peer && this.mail.delete(id)) n++;
    }
    if (n) this.dirty = true;
    return n;
  }

  mailExpire(now: number) {
    let n = 0;
    for (const [id, m] of this.mail) if (m.expiresAt <= now && this.mail.delete(id)) n++;
    if (n) this.dirty = true;
    return n;
  }

  mailDeleteUser(userId: string) {
    let n = 0;
    for (const [id, m] of this.mail)
      if ((m.toUser === userId || m.from === userId) && this.mail.delete(id)) n++;
    if (n) this.dirty = true;
    return n;
  }

  mailCount(filter: { toUser?: string; from?: string }) {
    let n = 0;
    for (const m of this.mail.values()) {
      if (filter.toUser && m.toUser !== filter.toUser) continue;
      if (filter.from && m.from !== filter.from) continue;
      n++;
    }
    return n;
  }

  flush() {
    if (!this.snapshotPath || !this.dirty) return;
    this.dirty = false;
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    const tmp = `${this.snapshotPath}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        records: [...this.records.values()],
        meta: [...this.meta],
        mail: [...this.mail.values()],
      }),
    );
    renameSync(tmp, this.snapshotPath);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }
}

type Row = Record<string, unknown>;
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { lastInsertRowid: number | bigint; changes?: number | bigint };
    get(...args: unknown[]): Row | undefined;
    all(...args: unknown[]): Row[];
  };
  close(): void;
}

export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const;
  private db: SqliteDb;
  private stmts;

  constructor(path: string) {
    // getBuiltinModule works in ESM, CJS bundles and Electron utility processes alike.
    const sqlite = process.getBuiltinModule?.('node:sqlite') as
      { DatabaseSync: new (p: string) => SqliteDb } | undefined;
    if (!sqlite) throw new Error('node:sqlite is not available in this runtime');
    const { DatabaseSync } = sqlite;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS records (
        key TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terms (
        term TEXT NOT NULL,
        key TEXT NOT NULL,
        PRIMARY KEY (term, key)
      );
      CREATE INDEX IF NOT EXISTS terms_by_key ON terms(key);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mail (
        id TEXT PRIMARY KEY,
        recipient TEXT NOT NULL,
        recipient_user TEXT NOT NULL,
        sender TEXT NOT NULL,
        box TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_by_recipient ON mail(recipient, created_at);
      CREATE INDEX IF NOT EXISTS mail_by_user ON mail(recipient_user);
      CREATE INDEX IF NOT EXISTS mail_by_sender ON mail(sender);
      CREATE INDEX IF NOT EXISTS mail_by_expiry ON mail(expires_at);
    `);
    this.stmts = {
      get: this.db.prepare('SELECT json FROM records WHERE key = ?'),
      maxSeq: this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM records'),
      upsert: this.db.prepare(
        `INSERT INTO records (key, seq, kind, version, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET seq = excluded.seq, version = excluded.version, json = excluded.json`,
      ),
      delTerms: this.db.prepare('DELETE FROM terms WHERE key = ?'),
      delRecord: this.db.prepare('DELETE FROM records WHERE key = ?'),
      countTerm: this.db.prepare('SELECT COUNT(*) AS n FROM terms WHERE term = ?'),
      mailDeleteUser: this.db.prepare('DELETE FROM mail WHERE recipient_user = ? OR sender = ?'),
      addTerm: this.db.prepare('INSERT OR IGNORE INTO terms (term, key) VALUES (?, ?)'),
      prefix: this.db.prepare(
        'SELECT json FROM records WHERE key >= ? AND key < ? ORDER BY key LIMIT ?',
      ),
      prefixAfter: this.db.prepare(
        'SELECT json FROM records WHERE key > ? AND key < ? ORDER BY key LIMIT ?',
      ),
      since: this.db.prepare('SELECT seq, json FROM records WHERE seq > ? ORDER BY seq LIMIT ?'),
      byTerm: this.db.prepare(
        'SELECT r.json FROM terms t JOIN records r ON r.key = t.key WHERE t.term = ? LIMIT ?',
      ),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
      mailPut: this.db.prepare(
        'INSERT OR REPLACE INTO mail (id, recipient, recipient_user, sender, box, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      mailFor: this.db.prepare(
        'SELECT * FROM mail WHERE recipient = ? AND expires_at > ? ORDER BY created_at LIMIT ?',
      ),
      mailDelete: this.db.prepare('DELETE FROM mail WHERE id = ? AND recipient = ?'),
      mailExpire: this.db.prepare('DELETE FROM mail WHERE expires_at <= ?'),
      mailCountUser: this.db.prepare('SELECT COUNT(*) AS n FROM mail WHERE recipient_user = ?'),
      mailCountFrom: this.db.prepare('SELECT COUNT(*) AS n FROM mail WHERE sender = ?'),
      mailCountBoth: this.db.prepare(
        'SELECT COUNT(*) AS n FROM mail WHERE recipient_user = ? AND sender = ?',
      ),
      mailCountAll: this.db.prepare('SELECT COUNT(*) AS n FROM mail'),
    };
    this.seq = Number(this.stmts.maxSeq.get()!.s);
    if (this.getMeta('index-version') !== String(INDEX_VERSION)) this.reindex();
  }

  /** Rebuilds the term index after indexTerms changed (see INDEX_VERSION). */
  private reindex() {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM terms');
      for (let cursor = 0; ;) {
        const batch = this.since(cursor, 1000);
        if (!batch.length) break;
        for (const { seq, record } of batch) {
          for (const term of indexTerms(record)) this.stmts.addTerm.run(term, record.key);
          cursor = seq;
        }
      }
      this.setMeta('index-version', String(INDEX_VERSION));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private seq: number;

  get(key: string) {
    const row = this.stmts.get.get(key);
    return row ? (JSON.parse(row.json as string) as SignedRecord) : undefined;
  }

  put(record: SignedRecord) {
    const seq = ++this.seq;
    this.db.exec('BEGIN');
    try {
      this.stmts.upsert.run(record.key, seq, record.kind, record.version, JSON.stringify(record));
      this.stmts.delTerms.run(record.key);
      for (const t of indexTerms(record)) this.stmts.addTerm.run(t, record.key);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return seq;
  }

  delete(key: string) {
    this.db.exec('BEGIN');
    try {
      this.stmts.delRecord.run(key);
      this.stmts.delTerms.run(key);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  countByTerm(term: string) {
    return Number(this.stmts.countTerm.get(term)?.n ?? 0);
  }

  listPrefix(prefix: string, limit: number, after?: string) {
    // Prefixes end in ':' so bumping the last char gives an exclusive upper bound.
    const upper =
      prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows =
      after !== undefined && after >= prefix
        ? this.stmts.prefixAfter.all(after, upper, limit)
        : this.stmts.prefix.all(prefix, upper, limit);
    return rows.map((r) => JSON.parse(r.json as string) as SignedRecord);
  }

  since(seq: number, limit: number) {
    return this.stmts.since
      .all(seq, limit)
      .map((r) => ({ seq: Number(r.seq), record: JSON.parse(r.json as string) as SignedRecord }));
  }

  latestSeq() {
    return this.seq;
  }

  findByTerm(term: string, limit: number) {
    return this.stmts.byTerm
      .all(term, limit)
      .map((r) => JSON.parse(r.json as string) as SignedRecord);
  }

  getMeta(key: string) {
    return this.stmts.getMeta.get(key)?.value as string | undefined;
  }

  setMeta(key: string, value: string) {
    this.stmts.setMeta.run(key, value);
  }

  mailPut(m: StoredMail) {
    this.stmts.mailPut.run(m.id, m.to, m.toUser, m.from, m.box, m.createdAt, m.expiresAt);
  }

  mailFor(peer: string, now: number, limit: number): StoredMail[] {
    return this.stmts.mailFor.all(peer, now, limit).map((r) => ({
      id: r.id as string,
      to: r.recipient as string,
      toUser: r.recipient_user as string,
      from: r.sender as string,
      box: r.box as string,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
    }));
  }

  mailDelete(peer: string, ids: string[]) {
    let n = 0;
    for (const id of ids) n += Number(this.stmts.mailDelete.run(id, peer).changes ?? 0);
    return n;
  }

  mailExpire(now: number) {
    return Number(this.stmts.mailExpire.run(now).changes ?? 0);
  }

  mailDeleteUser(userId: string) {
    return Number(this.stmts.mailDeleteUser.run(userId, userId).changes ?? 0);
  }

  mailCount(filter: { toUser?: string; from?: string }) {
    const row =
      filter.toUser && filter.from
        ? this.stmts.mailCountBoth.get(filter.toUser, filter.from)
        : filter.toUser
          ? this.stmts.mailCountUser.get(filter.toUser)
          : filter.from
            ? this.stmts.mailCountFrom.get(filter.from)
            : this.stmts.mailCountAll.get();
    return Number(row?.n ?? 0);
  }

  close() {
    this.db.close();
  }
}

/** SQLite when the runtime ships node:sqlite, otherwise a JSON-snapshotted memory store. */
export function openStore(opts: { dataDir?: string; kind?: 'sqlite' | 'memory' }): Store {
  if (opts.kind !== 'memory') {
    try {
      return new SqliteStore(opts.dataDir ? `${opts.dataDir}/coordinator.sqlite` : ':memory:');
    } catch (err) {
      if (opts.kind === 'sqlite') throw err;
    }
  }
  return new MemoryStore(opts.dataDir ? `${opts.dataDir}/coordinator.json` : undefined);
}
