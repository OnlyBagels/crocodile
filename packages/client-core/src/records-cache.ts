import { validateRecord } from '@crocodile/crypto';
import { RECORD_KIND_ORDER, type SignedRecord } from '@crocodile/protocol';
import { Emitter } from './emitter';
import type { KeyValueStore } from './platform';

const KV_KEY = 'records-cache';

/**
 * Client-side copy of the signed records we care about. Every record is
 * re-verified here: the client does not trust coordination servers.
 * Persisted so the app can show spaces and friends while offline.
 */
export class RecordCache extends Emitter<{ changed: SignedRecord; wanted: string[] }> {
  private map = new Map<string, SignedRecord>();
  /** Records waiting for one they depend on, and the keys each waits for. */
  private waiting = new Map<SignedRecord, string[]>();
  /** The same records by their own key (one version each). */
  private waitingByKey = new Map<string, SignedRecord>();
  /** The same records by the key they wait for. */
  private waitingFor = new Map<string, Set<SignedRecord>>();
  private static readonly MAX_WAITING = 2000;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly kv: KeyValueStore) {
    super();
  }

  async load() {
    const saved = await this.kv.get<SignedRecord[]>(KV_KEY);
    if (saved) this.ingestAll(saved, false);
  }

  get(key: string) {
    return this.map.get(key);
  }

  list(prefix: string): SignedRecord[] {
    const out: SignedRecord[] = [];
    for (const [k, r] of this.map) if (k.startsWith(prefix)) out.push(r);
    return out;
  }

  /** Forgets everything, including a pending save (signing out). */
  reset() {
    clearTimeout(this.saveTimer);
    this.map.clear();
    this.waiting.clear();
    this.waitingByKey.clear();
    this.waitingFor.clear();
  }

  /**
   * Drops a record we stored optimistically before the server refused it,
   * unless a newer version has arrived since.
   */
  forget(key: string, version: number) {
    if (this.map.get(key)?.version !== version) return;
    this.map.delete(key);
    this.scheduleSave();
  }

  ingestAll(records: SignedRecord[], persist = true) {
    const sorted = [...records].sort(
      (a, b) => RECORD_KIND_ORDER[a.kind] - RECORD_KIND_ORDER[b.kind],
    );
    for (const r of sorted) this.ingest(r, persist);
  }

  /** Returns true if the record was new and valid. */
  ingest(record: SignedRecord, persist = true): boolean {
    const existing = this.map.get(record.key);
    if (existing && existing.version >= record.version) return false;
    const res = validateRecord(record, {
      get: (k) => this.map.get(k),
      now: Date.now(),
      fresh: false,
    });
    if (!res.ok) {
      if (res.retryable) {
        const wanted = dependenciesOf(record).filter((k) => !this.map.has(k));
        if (wanted.length) {
          this.wait(record, wanted);
          this.emit('wanted', wanted);
        }
      }
      return false;
    }
    this.map.set(record.key, record);
    if (record.kind === 'profile' && (record.body as { deleted?: boolean }).deleted)
      this.dropAccount(record.key.slice('profile:'.length));
    if (persist) this.scheduleSave();
    this.emit('changed', record);
    // Only what waited for this record is tried again, never the whole queue.
    const ready = this.waitingFor.get(record.key);
    if (ready) {
      const retry = [...ready].sort(
        (a, b) => RECORD_KIND_ORDER[a.kind] - RECORD_KIND_ORDER[b.kind],
      );
      for (const r of retry) this.unwait(r);
      for (const r of retry) this.ingest(r, persist);
    }
    return true;
  }

  /** How many records wait for one they depend on (tests). */
  get waitingCount() {
    return this.waiting.size;
  }

  private wait(record: SignedRecord, keys: string[]) {
    const other = this.waitingByKey.get(record.key);
    if (other && other.version >= record.version) return;
    if (other) this.unwait(other);
    this.waiting.set(record, keys);
    this.waitingByKey.set(record.key, record);
    for (const k of keys) {
      let set = this.waitingFor.get(k);
      if (!set) this.waitingFor.set(k, (set = new Set()));
      set.add(record);
    }
    // Oldest first out.
    while (this.waiting.size > RecordCache.MAX_WAITING)
      this.unwait(this.waiting.keys().next().value as SignedRecord);
  }

  private unwait(record: SignedRecord) {
    const keys = this.waiting.get(record);
    if (!keys) return;
    this.waiting.delete(record);
    if (this.waitingByKey.get(record.key) === record) this.waitingByKey.delete(record.key);
    for (const k of keys) {
      const set = this.waitingFor.get(k);
      set?.delete(record);
      if (set?.size === 0) this.waitingFor.delete(k);
    }
  }

  /** A deleted account: drop its other records, as servers do. */
  private dropAccount(userId: string) {
    for (const key of [...this.map.keys()]) {
      if (
        key.startsWith(`device:${userId}:`) ||
        key === `friends:${userId}` ||
        (key.startsWith('member:') && key.endsWith(`:${userId}`))
      )
        this.map.delete(key);
    }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.kv.set(KV_KEY, [...this.map.values()]);
    }, 1000);
  }

  /** Writes a save that is waiting now (the app is closing). */
  async flush() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.kv.set(KV_KEY, [...this.map.values()]);
  }
}

/** Records a record's validation depends on. */
function dependenciesOf(record: SignedRecord): string[] {
  const body = record.body as { spaceId?: string; inviteCode?: string };
  if (record.kind === 'invite') return [`space:${body.spaceId}`];
  if (record.kind === 'member') {
    return [`space:${body.spaceId}`, ...(body.inviteCode ? [`invite:${body.inviteCode}`] : [])];
  }
  return [];
}
