import { userIdFromKey, validateRecord } from '@crocodile/crypto';
import {
  FedRequestParams,
  RECORD_KIND_ORDER,
  SignedRecordEnvelope,
  type FedRequest,
  type ProfileBody,
  type SignedRecord,
} from '@crocodile/protocol';
import type { Coordinator } from './coordinator';
import { fnv1a } from './election';
import {
  dependenciesOf,
  homeShardOf,
  shardOfKey,
  shardOfPrefix,
  shardOfTerm,
  shardsOf,
  type View,
} from './placement';
import type { PutResult } from './records';
import { RpcFailure, cutToFrame, withinBytes } from './util';

export interface DistributionConfig {
  /** Records we no longer own go once the live set has been stable this long. */
  gcStableMs: number;
  /** How often we look for such records. */
  gcCheckMs: number;
  /** How long an owner keeps a watch, and how often watchers renew. */
  watchTtlMs: number;
  watchRenewMs: number;
  /** How long records fetched for a check are kept. */
  cacheMs: number;
  /** How often we compare what we hold with one other owner, and fix the difference. */
  repairMs: number;
  /** After the live set changes, owners also ask the other owners for this long. */
  freshOwnerMs: number;
  /** How often deletion markers not yet confirmed by a space's owners are sent again. */
  deletionRetryMs: number;
}

export const defaultDistributionConfig: DistributionConfig = {
  gcStableMs: 10 * 60_000,
  gcCheckMs: 60_000,
  watchTtlMs: 5 * 60_000,
  watchRenewMs: 2 * 60_000,
  cacheMs: 5 * 60_000,
  repairMs: 5 * 60_000,
  freshOwnerMs: 2 * 60_000,
  deletionRetryMs: 60_000,
};

const CACHE_MAX = 20_000;
/** Watches one server may hold here, so a misbehaving one can't fill our memory. */
const WATCHES_PER_SERVER = 50_000;
/** Copies that arrived before what they depend on: fetched and tried again a few times. */
const RETRY_MS = 1500;
const RETRY_TRIES = 5;

/**
 * Where records are read from and written to (docs/MESH.md). Each record lives
 * on the owners of its shards; this server answers for shards it owns and
 * asks their owners for the rest, keeps watches for its clients on shards it
 * doesn't own, and moves records when the set of live servers changes.
 */
const greatest = (keys: string[]) =>
  keys.length ? keys.reduce((a, b) => (b > a ? b : a)) : undefined;

export class Distribution {
  /** Records fetched from other servers for checks and membership tests. */
  private cache = new Map<string, { record: SignedRecord; at: number }>();
  /** Owner side: shard -> watching server -> key prefix -> expiry. */
  private watchers = new Map<string, Map<string, Map<string, number>>>();
  private renewTimer?: ReturnType<typeof setInterval>;
  private gcTimer?: ReturnType<typeof setInterval>;
  private watchSoon?: ReturnType<typeof setTimeout>;
  private rebalancing: Promise<void> = Promise.resolve();
  private retries: { record: SignedRecord; from: string; tries: number }[] = [];
  private retryTimer?: ReturnType<typeof setTimeout>;
  private repairTimer?: ReturnType<typeof setInterval>;
  private deletionTimer?: ReturnType<typeof setInterval>;
  private repairing = false;
  /** Store positions over time, for collectGarbage: { when, latest seq then }. */
  private gcMarks: { at: number; seq: number }[] = [];

  constructor(
    private readonly hub: Coordinator,
    readonly config: DistributionConfig,
  ) {}

  private get self() {
    return this.hub.info.id;
  }

  private get view(): View {
    return this.hub.membership.view;
  }

  start() {
    this.hub.membership.on({
      settled: (before, after) => {
        this.rebalancing = this.rebalancing
          .then(() => this.rebalance(before, after))
          .catch((err) => this.hub.log.warn('moving records failed', { err: String(err) }));
        this.refreshWatchesSoon();
      },
    });
    this.renewTimer = setInterval(() => this.refreshWatches(), this.config.watchRenewMs);
    this.renewTimer.unref?.();
    this.gcTimer = setInterval(() => this.collectGarbage(), this.config.gcCheckMs);
    this.gcTimer.unref?.();
    this.repairTimer = setInterval(() => void this.repair(), this.config.repairMs);
    this.repairTimer.unref?.();
    this.deletionTimer = setInterval(() => void this.sendDeletions(), this.config.deletionRetryMs);
    this.deletionTimer.unref?.();
  }

  stop() {
    clearInterval(this.renewTimer);
    clearInterval(this.gcTimer);
    clearTimeout(this.watchSoon);
    clearTimeout(this.retryTimer);
    clearInterval(this.repairTimer);
    clearInterval(this.deletionTimer);
  }

  ownsShard(shard: string) {
    return this.view.ownersOf(shard).includes(this.self);
  }

  private others(shard: string) {
    return this.view.ownersOf(shard).filter((id) => id !== this.self);
  }

  // -------------------------------------------------------------------------
  // Local lookups (store plus recently fetched records)
  // -------------------------------------------------------------------------

  /** A record from our store, or one fetched for a check in the last few minutes. */
  lookup(key: string): SignedRecord | undefined {
    const stored = this.hub.records.store.get(key);
    if (stored) return stored;
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < this.config.cacheMs) return c.record;
    if (c) this.cache.delete(key);
    return undefined;
  }

  /**
   * Records another server sent us, sorted by how far they can be trusted:
   * `valid` passed every check that needs nothing else (signature, and the
   * author may write that key), so they can be passed on to clients, which
   * check them again. `trusted` also passed the checks that need other
   * records (an invite signed by its space's owner, a membership with a valid
   * invite), against what we hold and the batch itself: only those are
   * cached and used for our own decisions.
   */
  private sift(input: unknown[]): { valid: SignedRecord[]; trusted: SignedRecord[] } {
    const now = Date.now();
    const order = ['profile', 'friends', 'device', 'space', 'note', 'invite', 'member'];
    const records = input
      .filter((r): r is SignedRecord => SignedRecordEnvelope.safeParse(r).success)
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const accepted = new Map<string, SignedRecord>();
    const valid: SignedRecord[] = [];
    const trusted: SignedRecord[] = [];
    for (const r of records) {
      const own = (k: string) => (k === r.key ? undefined : (accepted.get(k) ?? this.lookup(k)));
      const full = validateRecord(r, { get: own, now, fresh: false });
      if (full.ok) {
        valid.push(r);
        trusted.push(r);
        if ((accepted.get(r.key)?.version ?? 0) < r.version) accepted.set(r.key, r);
        continue;
      }
      // Only a missing dependency kept it from full trust: still well signed.
      const alone = validateRecord(r, { get: () => undefined, now, fresh: false });
      if (alone.ok || alone.retryable) valid.push(r);
    }
    return { valid, trusted };
  }

  /** Keep checked records from other servers for a few minutes (see sift). */
  private remember(input: unknown[]) {
    const now = Date.now();
    for (const r of this.sift(input).trusted) {
      const have = this.cache.get(r.key);
      if (have && have.record.version > r.version) continue;
      this.cache.set(r.key, { record: r, at: now });
    }
    if (this.cache.size > CACHE_MAX) {
      const drop = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [k] of drop.slice(0, drop.length - CACHE_MAX / 2)) this.cache.delete(k);
    }
  }

  /** Fetch records we don't have from their owners, for the checks that need them. */
  private async fetchMissing(keys: string[]) {
    const missing = keys.filter((k) => !this.lookup(k));
    if (missing.length) await this.get(missing);
  }

  /**
   * Fetch what a group of records needs to pass validation, all at once: a
   * batch of hundreds waits for one round of lookups, not one per record.
   */
  private async ensureDependencies(records: SignedRecord[]) {
    const inBatch = new Set(records.map((r) => r.key));
    const need = (k: string) => !inBatch.has(k) && !this.lookup(k);
    const keys = new Set<string>();
    const invites = new Map<string, Set<string>>();
    for (const record of records) {
      let authorId: string;
      try {
        authorId = userIdFromKey(record.author);
      } catch {
        continue;
      }
      for (const k of dependenciesOf(record, authorId)) if (need(k)) keys.add(k);
      // An invite reaches the owners of its space before those of its code.
      const body = record.body as { spaceId?: string; inviteCode?: string };
      if (record.kind === 'member' && body.inviteCode && body.spaceId) {
        const key = `invite:${body.inviteCode}`;
        if (!need(key)) continue;
        const set = invites.get(body.spaceId) ?? new Set();
        invites.set(body.spaceId, set.add(key));
      }
    }
    if (keys.size) await this.get([...keys]).catch(() => {});
    // Invites the code's own owners didn't have: ask the space's.
    await Promise.all(
      [...invites].map(async ([spaceId, wanted]) => {
        const left = [...wanted].filter((k) => !this.lookup(k));
        const owners = this.others(`space:${spaceId}`);
        if (!left.length || !owners.length) return;
        await this.hub.mesh
          .requestAny<{ records: SignedRecord[] }>(owners, 'rec_get', { keys: left })
          .then(({ records }) => this.remember((records ?? []).filter((r) => wanted.has(r.key))))
          .catch(() => {});
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * A client's new record: checked and stored by an owner of its home shard
   * (us, if we are one), which copies it to the other owners.
   */
  async putFromClient(input: unknown): Promise<PutResult> {
    const env = SignedRecordEnvelope.safeParse(input);
    let home: string | undefined;
    if (env.success) {
      try {
        home = homeShardOf(input as SignedRecord);
      } catch {
        // A malformed body: let the local check say why.
      }
    }
    if (!home || this.ownsShard(home)) return this.putLocal(input, { fresh: true, origin: null });
    try {
      const res = await this.hub.mesh.requestAny<PutResult>(this.others(home), 'rec_put', {
        record: input,
      });
      if (res.accepted) this.remember([input as SignedRecord]);
      return res;
    } catch {
      throw new RpcFailure('unavailable', 'the servers holding this record are unreachable');
    }
  }

  async putLocal(
    input: unknown,
    opts: { fresh: boolean; origin: string | null },
  ): Promise<PutResult> {
    if (SignedRecordEnvelope.safeParse(input).success)
      await this.ensureDependencies([input as SignedRecord]);
    const res = this.hub.records.put(input, opts);
    if (res.accepted && opts.fresh) await this.storeOnOtherShards(input as SignedRecord);
    return res;
  }

  /**
   * A new record whose other shards we don't own: before the write is
   * confirmed, make sure an owner of each holds it, so a read right after
   * (a space's member list, say, just after joining) finds it. Replication
   * reaches the rest of the owners as usual.
   */
  private async storeOnOtherShards(record: SignedRecord) {
    await Promise.all(
      shardsOf(record)
        .filter((shard) => !this.ownsShard(shard))
        .map((shard) =>
          this.hub.mesh
            .requestAny(this.others(shard), 'rec_store', { records: [record] })
            .catch(() => {}),
        ),
    );
  }

  /** Records another server copied to us, as an owner. */
  async onReplicated(items: { seq: number; record: SignedRecord }[], from: string) {
    const records = items
      .map((i) => i.record)
      .filter((r) => {
        if (!SignedRecordEnvelope.safeParse(r).success) return false;
        const have = this.hub.records.store.get(r.key);
        return !have || have.version < r.version;
      });
    if (!records.length) return;
    await this.ensureDependencies(records);
    // What others in the batch depend on goes first (a space before its members).
    records.sort((a, b) => RECORD_KIND_ORDER[a.kind] - RECORD_KIND_ORDER[b.kind]);
    for (const record of records) {
      const res = this.hub.records.put(record, { fresh: false, origin: from });
      if (!res.accepted && /^unknown /.test(res.reason ?? ''))
        this.retryLater({ record, from, tries: 0 });
    }
  }

  private retryLater(item: { record: SignedRecord; from: string; tries: number }) {
    if (item.tries >= RETRY_TRIES || this.retries.length > 10_000) return;
    this.retries.push(item);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const due = this.retries.splice(0);
      void (async () => {
        const todo = due.filter((r) => {
          const have = this.hub.records.store.get(r.record.key);
          return !have || have.version < r.record.version;
        });
        await this.ensureDependencies(todo.map((r) => r.record));
        todo.sort((a, b) => RECORD_KIND_ORDER[a.record.kind] - RECORD_KIND_ORDER[b.record.kind]);
        for (const r of todo) {
          const res = this.hub.records.put(r.record, { fresh: false, origin: r.from });
          if (!res.accepted && /^unknown /.test(res.reason ?? ''))
            this.retryLater({ ...r, tries: r.tries + 1 });
        }
      })();
    }, RETRY_MS);
    this.retryTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Whether we should check with the other owners too, though we own the
   * shard: the live set changed recently, so records may still be on their
   * way to us.
   */
  private catchingUp() {
    const m = this.hub.membership;
    return !m.settled.equals(m.view) || Date.now() - m.stableSince < this.config.freshOwnerMs;
  }

  /**
   * Ask every other owner of a shard and keep the newest copy of each record:
   * one owner may not have a record yet that another has. Null if none answered.
   */
  private async fromOwners(
    shard: string,
    m: 'rec_get' | 'rec_list' | 'rec_term',
    p: unknown,
    more?: { value: boolean; upTo?: string },
  ): Promise<SignedRecord[] | null> {
    const answers = await this.hub.mesh.gather<{ records: SignedRecord[]; more?: boolean }>(
      this.others(shard),
      m,
      p,
    );
    if (answers.length === 0) return null;
    // Only well-signed records count: an owner can't hand us a forged newer copy.
    const { valid } = this.sift(answers.flatMap((a) => a.records ?? []));
    if (more) {
      // An owner that cut its answer says nothing past the last (well-signed) key it gave.
      const good = new Set(valid.map((r) => r.key));
      for (const a of answers) {
        if (!a.more) continue;
        const keys = (a.records ?? []).map((r) => r.key);
        // The last well-signed key, or failing that the last one it gave.
        const bound = greatest(keys.filter((k) => good.has(k))) ?? greatest(keys);
        if (bound === undefined) continue;
        more.value = true;
        if (more.upTo === undefined || bound < more.upTo) more.upTo = bound;
      }
    }
    const newest = new Map<string, SignedRecord>();
    for (const r of valid) if ((newest.get(r.key)?.version ?? 0) < r.version) newest.set(r.key, r);
    const found = [...newest.values()];
    this.remember(found);
    return found;
  }

  /** Newest copy per key across several lists. */
  private static merge(...lists: SignedRecord[][]): SignedRecord[] {
    const newest = new Map<string, SignedRecord>();
    for (const list of lists)
      for (const r of list) if ((newest.get(r.key)?.version ?? 0) < r.version) newest.set(r.key, r);
    return [...newest.values()];
  }

  /** Records by key, from our store for shards we own and from their owners otherwise. */
  async get(keys: string[]): Promise<SignedRecord[]> {
    const out = new Map<string, SignedRecord>();
    const ask = new Map<string, string[]>();
    const catchingUp = this.catchingUp();
    for (const key of new Set(keys)) {
      const shard = shardOfKey(key);
      const owned = !shard || this.ownsShard(shard);
      const local = owned ? this.hub.records.store.get(key) : undefined;
      if (local) out.set(key, local);
      // Not ours, or ours but missing or possibly behind: ask the other owners.
      if (shard && (!owned || !local || catchingUp)) {
        const list = ask.get(shard) ?? [];
        list.push(key);
        ask.set(shard, list);
      }
    }
    await Promise.all(
      [...ask].map(async ([shard, group]) => {
        // At most 1000 keys a request, and an answer too large for one
        // frame comes in parts: ask again for what it left out.
        const found: SignedRecord[] = [];
        for (let i = 0; i < group.length; i += 1000) {
          let left = group.slice(i, i + 1000);
          while (left.length) {
            const more = { value: false };
            const part = (await this.fromOwners(shard, 'rec_get', { keys: left }, more)) ?? [];
            found.push(...part);
            const got = new Set(part.map((r) => r.key));
            const rest = left.filter((k) => !got.has(k));
            left = more.value && rest.length < left.length ? rest : [];
          }
        }
        const asked = new Set(group);
        for (const r of found) {
          if (asked.has(r.key) && (out.get(r.key)?.version ?? 0) < r.version) out.set(r.key, r);
        }
        // A record we wrote a moment ago may not have reached the owners yet;
        // if they can't be reached, what we still hold is better than nothing.
        for (const key of group) {
          const mine = this.lookup(key);
          if (mine && (out.get(key)?.version ?? 0) < mine.version) out.set(key, mine);
        }
      }),
    );
    return [...out.values()];
  }

  /**
   * Records under a prefix in key order, at most `limit`, those after `after` if given. `more`:
   * there are others after these (past `limit`, or an owner could not give everything it has in
   * one frame, so this is cut where its answer was).
   */
  async list(
    prefix: string,
    limit: number,
    after?: string,
  ): Promise<{ records: SignedRecord[]; more: boolean }> {
    const shard = shardOfPrefix(prefix);
    const store = this.hub.records.store;
    const owned = !shard || this.ownsShard(shard);
    // One more than asked for, to know whether there is more (and 5000 is what a peer takes).
    limit = Math.min(limit, 4999);
    const local = owned ? store.listPrefix(prefix, limit + 1, after) : [];
    const page = (records: SignedRecord[], cut = false) => ({
      records: records.slice(0, limit),
      more: cut || records.length > limit,
    });
    if (!shard || (owned && !this.catchingUp())) return page(local);
    const cut: { value: boolean; upTo?: string } = { value: false };
    const remote = await this.fromOwners(
      shard,
      'rec_list',
      { prefix, limit: limit + 1, after },
      cut,
    );
    if (!remote) return page(owned ? local : store.listPrefix(prefix, limit + 1, after));
    // An owner that ignored `after` (an older server) must not bring back what was already given,
    // nor cut the page short at a key before it.
    if (after !== undefined && cut.upTo !== undefined && cut.upTo <= after) cut.upTo = undefined;
    const merged = Distribution.merge(
      local,
      remote.filter((r) => r.key.startsWith(prefix) && (after === undefined || r.key > after)),
    )
      .filter((r) => cut.upTo === undefined || r.key <= cut.upTo)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return page(merged, cut.value);
  }

  async findByTerm(term: string, limit: number): Promise<SignedRecord[]> {
    const shard = shardOfTerm(term);
    const store = this.hub.records.store;
    const owned = !shard || this.ownsShard(shard);
    const local = owned ? store.findByTerm(term, limit) : [];
    if (!shard || (owned && !this.catchingUp())) return local;
    const remote = await this.fromOwners(shard, 'rec_term', { term, limit });
    if (!remote) return owned ? local : store.findByTerm(term, limit);
    return Distribution.merge(local, remote).slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Requests from other servers
  // -------------------------------------------------------------------------

  async handleRequest(from: string, m: FedRequest['m'], p: unknown): Promise<unknown> {
    const schema = FedRequestParams[m];
    if (!schema) throw new RpcFailure('not_found', `unknown request ${m}`);
    const parsed = schema.safeParse(p);
    if (!parsed.success) throw new RpcFailure('bad_request', 'invalid parameters');
    const store = this.hub.records.store;
    switch (m) {
      case 'rec_put': {
        const { record } = parsed.data as { record: unknown };
        const r = await this.putLocal(record, { fresh: true, origin: null });
        return {
          accepted: r.accepted,
          current: r.current,
          ...(r.reason ? { reason: r.reason } : {}),
        };
      }
      case 'rec_get': {
        const { keys } = parsed.data as { keys: string[] };
        // As many as fit in one frame; the asker comes back for the rest.
        return cutToFrame(keys.map((k) => store.get(k)).filter((r) => r !== undefined));
      }
      case 'rec_list': {
        const { prefix, limit, after } = parsed.data as {
          prefix: string;
          limit?: number;
          after?: string;
        };
        return cutToFrame(store.listPrefix(prefix, limit ?? 1000, after));
      }
      case 'rec_term': {
        const { term, limit } = parsed.data as { term: string; limit?: number };
        return { records: withinBytes(store.findByTerm(term, limit ?? 1000)) };
      }
      case 'rec_store': {
        const { records } = parsed.data as { records: SignedRecord[] };
        await this.onReplicated(
          records.map((record) => ({ seq: 0, record })),
          from,
        );
        return {};
      }
      case 'presence_state':
        return this.hub.presence.fullState();
      case 'digest': {
        const { buckets } = parsed.data as { buckets: number[] };
        const mine = this.digest(from);
        return { differ: mine.map((v, i) => i).filter((i) => mine[i] !== buckets[i]) };
      }
      case 'digest_keys': {
        const { buckets } = parsed.data as { buckets: number[] };
        const wanted = new Set(buckets);
        return {
          keys: withinBytes(
            this.shared(from)
              .filter((r) => wanted.has(bucketOf(r.key)))
              .slice(0, 20_000)
              .map((r) => ({ key: r.key, version: r.version })),
          ),
        };
      }
      case 'watch': {
        const { items, ttlMs } = parsed.data as {
          items: { shard: string; prefix: string }[];
          ttlMs: number;
        };
        const until = Date.now() + ttlMs;
        let held = 0;
        for (const byServer of this.watchers.values()) held += byServer.get(from)?.size ?? 0;
        for (const { shard, prefix } of items) {
          if (held++ >= WATCHES_PER_SERVER)
            throw new RpcFailure('rate_limited', 'too many watches');
          let byServer = this.watchers.get(shard);
          if (!byServer) this.watchers.set(shard, (byServer = new Map()));
          let prefixes = byServer.get(from);
          if (!prefixes) byServer.set(from, (prefixes = new Map()));
          prefixes.set(prefix, until);
        }
        return {};
      }
    }
  }

  // -------------------------------------------------------------------------
  // Watches: changes to shards we don't own, for our clients
  // -------------------------------------------------------------------------

  /** Owner side: tell the servers watching this record's shards. */
  onAccepted(record: SignedRecord) {
    const now = Date.now();
    const told = new Set<string>([this.self]);
    for (const shard of shardsOf(record)) {
      const byServer = this.watchers.get(shard);
      if (!byServer) continue;
      for (const [server, prefixes] of byServer) {
        for (const [prefix, until] of prefixes) {
          if (until < now) prefixes.delete(prefix);
          else if (!told.has(server) && record.key.startsWith(prefix)) {
            told.add(server);
            this.hub.mesh.sendTo(server, { t: 'rec_push', record });
          }
        }
        if (prefixes.size === 0) byServer.delete(server);
      }
      if (byServer.size === 0) this.watchers.delete(shard);
    }
  }

  /** Watcher side: a record our clients may want, from its owner. */
  async onPush(input: SignedRecord) {
    // Pushed by another server: act on it only if it checks out (a forged
    // "deleted" profile would otherwise sign the user out everywhere).
    const { valid, trusted } = this.sift([input]);
    const record = valid[0];
    if (!record) return;
    this.remember(trusted);
    this.hub.pushRecordToClients(record);
    if (trusted[0] && record.kind === 'profile' && (record.body as ProfileBody).deleted)
      this.hub.signOutDeleted(
        record.key.slice('profile:'.length),
        record as SignedRecord<'profile'>,
      );
  }

  refreshWatchesSoon() {
    if (this.watchSoon) return;
    this.watchSoon = setTimeout(() => {
      this.watchSoon = undefined;
      this.refreshWatches();
    }, 100);
    this.watchSoon.unref?.();
  }

  /** Ask owners to watch the shards our clients follow and we don't own. */
  refreshWatches() {
    const wanted = new Map<string, Set<string>>();
    const add = (shard: string | undefined, prefix: string) => {
      if (!shard || this.ownsShard(shard)) return;
      let set = wanted.get(shard);
      if (!set) wanted.set(shard, (set = new Set()));
      set.add(prefix);
    };
    for (const client of this.hub.presence.localClients()) {
      // Everything about the user: their memberships, notes and own records.
      add(`user:${client.userId}`, '');
      for (const prefix of client.subscriptions) add(shardOfPrefix(prefix), prefix);
    }
    const byOwner = new Map<string, { shard: string; prefix: string }[]>();
    for (const [shard, prefixes] of wanted) {
      for (const owner of this.others(shard)) {
        const items = byOwner.get(owner) ?? [];
        for (const prefix of prefixes) items.push({ shard, prefix });
        byOwner.set(owner, items);
      }
    }
    for (const [owner, items] of byOwner) {
      for (let i = 0; i < items.length; i += 5000) {
        this.hub.mesh
          .request(owner, 'watch', {
            items: items.slice(i, i + 5000),
            ttlMs: this.config.watchTtlMs,
          })
          .catch(() => {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // Moving records when servers come and go
  // -------------------------------------------------------------------------

  /**
   * Send every record to the servers that have just become its owners. Only
   * the first live old owner sends, so each record goes once.
   */
  private async rebalance(before: View, after: View) {
    const store = this.hub.records.store;
    const live = new Set(after.ring.ids);
    const outgoing = new Map<string, SignedRecord[]>();
    let moved = 0;
    for (let cursor = 0; ;) {
      const batch = store.since(cursor, 1000);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.seq;
      for (const { record } of batch) {
        const was = before.placement(record);
        const now = after.placement(record);
        const newcomers = now.filter((id) => id !== this.self && !was.includes(id));
        if (newcomers.length === 0) continue;
        const lead = was.find((id) => live.has(id)) ?? this.self;
        if (lead !== this.self) continue;
        for (const id of newcomers) {
          const list = outgoing.get(id) ?? [];
          list.push(record);
          outgoing.set(id, list);
          moved++;
        }
      }
      // Let other work in.
      await new Promise((r) => setImmediate(r));
    }
    for (const [id, records] of outgoing) await this.hub.mesh.handOver(id, records);
    if (moved)
      this.hub.log.info('records handed to new owners', { records: moved, servers: outgoing.size });
  }

  // -------------------------------------------------------------------------
  // Repair: copies that went missing despite everything above
  // -------------------------------------------------------------------------

  /** Records we hold that both we and `peer` own (by the settled view). */
  private shared(peer: string): SignedRecord[] {
    const settled = this.hub.membership.settled;
    const out: SignedRecord[] = [];
    const store = this.hub.records.store;
    for (let cursor = 0; ;) {
      const batch = store.since(cursor, 1000);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.seq;
      for (const { record } of batch) {
        const owners = settled.placement(record);
        if (owners.includes(peer) && owners.includes(this.self)) out.push(record);
      }
    }
    return out;
  }

  /** Order-independent sums of (key, version) over the shared records, in 256 buckets. */
  private digest(peer: string): number[] {
    const sums = new Array<number>(256).fill(0);
    for (const r of this.shared(peer)) {
      const b = bucketOf(r.key);
      sums[b] = (sums[b]! + fnv1a(`${r.key}@${r.version}`)) % 2 ** 32;
    }
    return sums;
  }

  /**
   * Compare what we hold with one other live owner and exchange the
   * difference: what they lack or hold older we send, what we lack we fetch.
   */
  async repair(peer?: string) {
    const m = this.hub.membership;
    if (this.repairing || !m.settled.equals(m.view)) return;
    const others = m.liveIds().filter((id) => id !== this.self);
    const target = peer ?? others[Math.floor(Math.random() * others.length)];
    if (!target) return;
    this.repairing = true;
    try {
      const { differ } = await this.hub.mesh.request<{ differ: number[] }>(target, 'digest', {
        buckets: this.digest(target),
      });
      if (!differ.length) return;
      const { keys } = await this.hub.mesh.request<{ keys: { key: string; version: number }[] }>(
        target,
        'digest_keys',
        { buckets: differ },
      );
      const theirs = new Map(keys.map((k) => [k.key, k.version]));
      const wanted = new Set(differ);
      const mine = this.shared(target).filter((r) => wanted.has(bucketOf(r.key)));
      const send = mine.filter((r) => (theirs.get(r.key) ?? 0) < r.version);
      const store = this.hub.records.store;
      const fetch = keys
        .filter((k) => (store.get(k.key)?.version ?? 0) < k.version)
        .map((k) => k.key);
      if (send.length) await this.hub.mesh.handOver(target, send);
      // A large answer comes in parts: ask again for what didn't fit.
      let left = fetch;
      while (left.length) {
        const ask = left.slice(0, 500);
        const { records } = await this.hub.mesh.request<{ records: SignedRecord[] }>(
          target,
          'rec_get',
          { keys: ask },
        );
        const got = new Set(records.map((r) => r.key));
        const missing = ask.filter((k) => !got.has(k));
        // What they no longer have isn't coming: stop once an answer adds nothing.
        left =
          missing.length < ask.length
            ? [...missing, ...left.slice(ask.length)]
            : left.slice(ask.length);
        await this.onReplicated(
          records.map((record) => ({ seq: 0, record })),
          target,
        );
      }
      if (send.length || fetch.length)
        this.hub.log.info('repaired copies', {
          peer: target,
          sent: send.length,
          fetched: fetch.length,
        });
    } catch {
      // Unreachable or busy: another round will try someone else.
    } finally {
      this.repairing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Account deletion: the marker must reach the owners of the user's spaces
  // -------------------------------------------------------------------------

  /**
   * Remember to send a deletion marker to the owners of the spaces the user
   * was in, until each has confirmed (kept across restarts, for 30 days).
   */
  trackDeletion(marker: SignedRecord<'profile'>, spaceIds: string[]) {
    if (spaceIds.length === 0) return;
    const userId = marker.key.slice('profile:'.length);
    const store = this.hub.records.store;
    store.setMeta(
      `deletion:${userId}`,
      JSON.stringify({ marker, spaces: spaceIds, done: [], since: Date.now() }),
    );
    const index = new Set<string>(JSON.parse(store.getMeta('deletions') ?? '[]') as string[]);
    index.add(userId);
    store.setMeta('deletions', JSON.stringify([...index]));
    void this.sendDeletions();
  }

  private sendingDeletions = false;
  private deletionsAgain = false;

  async sendDeletions(): Promise<void> {
    if (this.sendingDeletions) {
      // Jobs added meanwhile are sent as soon as this round is over.
      this.deletionsAgain = true;
      return;
    }
    this.sendingDeletions = true;
    this.deletionsAgain = false;
    const store = this.hub.records.store;
    const finished = new Set<string>();
    try {
      const index = JSON.parse(store.getMeta('deletions') ?? '[]') as string[];
      for (const userId of index) {
        const raw = store.getMeta(`deletion:${userId}`);
        if (!raw) {
          finished.add(userId);
          continue;
        }
        const job = JSON.parse(raw) as {
          marker: SignedRecord;
          spaces: string[];
          done: string[];
          since: number;
        };
        if (Date.now() - job.since > 30 * 24 * 3600_000) {
          store.setMeta(`deletion:${userId}`, '');
          finished.add(userId);
          continue;
        }
        const targets = new Set<string>();
        for (const spaceId of job.spaces)
          for (const id of this.others(`space:${spaceId}`)) targets.add(id);
        for (const id of job.done) targets.delete(id);
        for (const id of targets) {
          try {
            await this.hub.mesh.request(id, 'rec_store', { records: [job.marker] });
            job.done.push(id);
          } catch {
            // Tried again on the next round.
          }
        }
        // The job may have been replaced while we were sending (the same
        // account deleted again): that newer one stays as it is.
        if (store.getMeta(`deletion:${userId}`) !== raw) continue;
        const pending = [...targets].some((id) => !job.done.includes(id));
        if (pending) store.setMeta(`deletion:${userId}`, JSON.stringify(job));
        else {
          store.setMeta(`deletion:${userId}`, '');
          finished.add(userId);
        }
      }
      // Read again: accounts added while we were sending stay listed.
      const now = JSON.parse(store.getMeta('deletions') ?? '[]') as string[];
      store.setMeta('deletions', JSON.stringify(now.filter((id) => !finished.has(id))));
    } finally {
      this.sendingDeletions = false;
    }
    if (this.deletionsAgain) return this.sendDeletions();
  }

  /**
   * Delete records we don't own, once the live set has been stable for a
   * while. A record that arrived recently stays until we could have seen the
   * change that made us its owner: a server that held a link to one that went
   * away notices at once and hands its records on, while we may only notice
   * when that server's beacons stop (liveMs later).
   */
  collectGarbage(now = Date.now()) {
    const m = this.hub.membership;
    const settled = m.settled;
    const store = this.hub.records.store;
    this.gcMarks.push({ at: now, seq: store.latestSeq() });
    const hold = m.timing.liveMs + m.timing.settleMs + this.config.gcStableMs;
    // The newest store position at least `hold` old: records up to it may go.
    while (this.gcMarks.length > 1 && this.gcMarks[1]!.at <= now - hold) this.gcMarks.shift();
    const upTo = this.gcMarks[0]!.at <= now - hold ? this.gcMarks[0]!.seq : 0;
    if (!settled.equals(m.view) || now - m.stableSince < this.config.gcStableMs) return 0;
    if (settled.ownsAll || settled.full.includes(this.self)) return 0;
    const drop: string[] = [];
    for (let cursor = 0; cursor < upTo;) {
      const batch = store.since(cursor, 1000);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.seq;
      for (const { seq, record } of batch)
        if (seq <= upTo && !settled.owns(this.self, record)) drop.push(record.key);
    }
    for (const key of drop) store.delete(key);
    if (drop.length) this.hub.log.info('dropped records owned elsewhere', { records: drop.length });
    return drop.length;
  }
}

function bucketOf(key: string) {
  return fnv1a(key) & 255;
}
