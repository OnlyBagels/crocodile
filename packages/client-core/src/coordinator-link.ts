import type { Identity } from '@crocodile/crypto';
import type {
  OperatorInfo,
  Platform,
  RpcMethod,
  RpcMethods,
  RpcParamsOf,
  ServerEvents,
  ServerInfo,
  SignedRecord,
} from '@crocodile/protocol';
import { CoordinatorConnection, RpcCallError } from './coordinator-connection';
import { Emitter } from './emitter';
import type { KeyValueStore } from './platform';
import { fetchServerList, probeLatency, probeServers, type RankedServer } from './server-selection';

export type LinkStatus = 'idle' | 'discovering' | 'connecting' | 'connected' | 'offline';

export type LinkEvents = ServerEvents & {
  status: LinkStatus;
  /** Fired on every (re)connection; subscribers re-establish their state. */
  connected: { server: ServerInfo; rttMs: number; stun: string[]; operator?: OperatorInfo };
  disconnected: { reason: string };
  /** Every listed server, best first; unreachable ones last with rttMs Infinity. */
  servers: RankedServer[];
  /** A fresh round-trip time to the connected server. */
  latency: { rttMs: number };
  /**
   * A server says this identity's account was deleted, with the signed marker
   * when it sent one. Unverified: the client checks the marker, and the link
   * carries on as after any failed connection unless stopped.
   */
  account_deleted: { record?: SignedRecord };
};

export interface CoordinatorLinkOptions {
  identity: Identity;
  deviceId: string;
  platform: Platform;
  version: string;
  kv: KeyValueStore;
  /** Directory services to discover coordination servers from. */
  directories: string[];
  /** Server URLs tried first (self-hosted, LAN, or pinned by the user). */
  preferredServers?: string[];
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

const FORWARDED_EVENTS: (keyof ServerEvents)[] = [
  'record',
  'presence',
  'session',
  'session_closed',
  'signal',
  'voice',
  'session_invite',
  'replaced',
  'link_claimed',
  'link_reveal',
  'link_payload',
  'relay_expired',
  'mail',
];

/**
 * A resilient link to "the" coordination layer: picks the lowest-latency
 * server (keeping the runner-up as standby), fails over when the connection
 * drops, and re-ranks in the background. Callers just make requests.
 */
export class CoordinatorLink extends Emitter<LinkEvents> {
  status: LinkStatus = 'idle';
  /** Reachable servers, best first: the candidates to connect to. */
  ranked: RankedServer[] = [];
  /** Every listed server, reachable or not, as last measured. */
  listed: RankedServer[] = [];
  private conn?: CoordinatorConnection;
  private current?: RankedServer;
  private stopped = false;
  /** Bumped by start() and stop(): a connect loop from an earlier run gives up. */
  private run = 0;
  private waiters: { resolve: (c: CoordinatorConnection) => void; reject: (e: Error) => void }[] =
    [];
  private retryTimer?: ReturnType<typeof setTimeout>;
  private rerankTimer?: ReturnType<typeof setInterval>;
  private attempt = 0;
  replacedElsewhere = false;

  constructor(private readonly opts: CoordinatorLinkOptions) {
    super();
  }

  get connection() {
    return this.conn;
  }

  get server(): RankedServer | undefined {
    return this.current;
  }

  start() {
    this.stopped = false;
    this.run++;
    clearTimeout(this.retryTimer);
    clearInterval(this.rerankTimer);
    void this.connectLoop();
    this.rerankTimer = setInterval(() => void this.refreshServers().catch(() => {}), 10 * 60_000);
  }

  stop() {
    this.stopped = true;
    this.run++;
    clearTimeout(this.retryTimer);
    clearInterval(this.rerankTimer);
    this.conn?.close();
    this.conn = undefined;
    this.setStatus('idle');
    for (const w of this.waiters.splice(0)) w.reject(new Error('stopped'));
  }

  /** Waits (bounded) for a connection, then performs the call. */
  async request<M extends RpcMethod>(
    method: M,
    params: RpcParamsOf<M>,
    timeoutMs = 15_000,
  ): Promise<RpcMethods[M]> {
    const conn = await this.ready(timeoutMs);
    return conn.request(method, params, timeoutMs);
  }

  ready(timeoutMs = 15_000): Promise<CoordinatorConnection> {
    if (this.conn?.isOpen) return Promise.resolve(this.conn);
    if (this.stopped) return Promise.reject(new RpcCallError('unavailable', 'link stopped'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new RpcCallError('unavailable', 'no coordination server reachable'));
        }
      }, timeoutMs);
    });
  }

  /** Force a reconnect (e.g. after the user changed server preferences). */
  reconnect() {
    this.conn?.close();
  }

  private setStatus(status: LinkStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  private async candidates(): Promise<RankedServer[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const preferred: RankedServer[] = [];
    for (const url of this.opts.preferredServers ?? []) {
      const rttMs = await probeLatency(url, f, 1);
      if (Number.isFinite(rttMs)) {
        preferred.push({ info: { id: '', key: '', name: url, url, version: '' }, rttMs, load: 0 });
      }
    }
    if (this.opts.directories.length === 0) return preferred;
    this.setStatus('discovering');
    await this.measureServers();
    return [
      ...preferred,
      ...this.ranked.filter((r) => !preferred.some((p) => p.info.url === r.info.url)),
    ];
  }

  /** Re-reads the directories and measures every server again. */
  async refreshServers() {
    if (this.opts.directories.length === 0) return;
    await this.measureServers();
    const current = this.current;
    const mine = this.listed.find((s) => s.info.id === current?.info.id);
    // Connected means reachable: if this one probe failed, keep the last value
    // in both places rather than showing it unreachable in the list.
    if (current && mine) this.setLatency(Number.isFinite(mine.rttMs) ? mine.rttMs : current.rttMs);
  }

  /** Measures the connected server once more (one /health round trip). */
  async measureLatency() {
    const current = this.current;
    if (!current || this.status !== 'connected') return;
    const rttMs = await probeLatency(current.info.url, this.opts.fetchImpl ?? fetch, 1);
    if (Number.isFinite(rttMs) && this.current === current) this.setLatency(rttMs);
  }

  private async measureServers() {
    const f = this.opts.fetchImpl ?? fetch;
    const { servers, loads } = await fetchServerList(this.opts.directories, this.opts.kv, f);
    this.listed = await probeServers(servers, loads, f);
    this.ranked = this.listed.filter((s) => Number.isFinite(s.rttMs));
    this.emit('servers', this.listed);
  }

  /** One number per server: the connected one's latency everywhere it shows. */
  private setLatency(rttMs: number) {
    // A probe that finishes after stop() belongs to a link that's been replaced.
    if (this.stopped || !this.current) return;
    this.current = { ...this.current, rttMs };
    const id = this.current.info.id;
    const update = (list: RankedServer[]) =>
      list.map((s) => (s.info.id === id ? { ...s, rttMs } : s));
    this.ranked = update(this.ranked);
    this.listed = update(this.listed);
    this.emit('latency', { rttMs });
    this.emit('servers', this.listed);
  }

  private async connectLoop() {
    if (this.stopped) return;
    const run = this.run;
    // Stopped, or started again (which runs its own loop), while we waited.
    const stale = () => this.stopped || this.run !== run;
    // Fast path: fail over straight to the standby we already measured.
    let list = this.ranked.filter((r) => r.info.url !== this.current?.info.url);
    if (this.current && this.attempt === 0) list = [this.current, ...list];
    if (list.length === 0 || this.attempt > 0) list = await this.candidates().catch(() => []);
    if (stale()) return;
    this.setStatus('connecting');
    for (const candidate of list) {
      if (stale()) return;
      try {
        const conn = await CoordinatorConnection.connect({
          url: candidate.info.url,
          identity: this.opts.identity,
          deviceId: this.opts.deviceId,
          platform: this.opts.platform,
          version: this.opts.version,
          expectedServerKey: candidate.info.key || undefined,
          WebSocketImpl: this.opts.WebSocketImpl,
        });
        if (stale()) {
          // A connection nobody will use or close otherwise.
          conn.close();
          return;
        }
        this.attach(conn, { ...candidate, info: conn.server });
        return;
      } catch (err) {
        if (err instanceof RpcCallError && err.code === 'account_deleted') {
          this.emit('account_deleted', { record: err.record });
          if (stale()) return;
        }
        /* next candidate */
      }
    }
    if (stale()) return;
    this.setStatus('offline');
    this.attempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    this.retryTimer = setTimeout(() => void this.connectLoop(), delay);
  }

  private attach(conn: CoordinatorConnection, server: RankedServer) {
    this.conn = conn;
    this.current = server;
    this.attempt = 0;
    this.replacedElsewhere = false;
    for (const ev of FORWARDED_EVENTS) conn.on(ev, (d) => this.emit(ev, d as never));
    conn.on('replaced', () => {
      this.replacedElsewhere = true;
    });
    conn.on('close', ({ code, reason }) => {
      if (this.conn !== conn) return;
      this.conn = undefined;
      this.emit('disconnected', { reason });
      if (this.stopped) return;
      if (code === 4010) {
        // The marker came as a 'record' event just before the close.
        this.emit('account_deleted', {});
        if (this.stopped) return;
      }
      if (this.replacedElsewhere) {
        // Signed in on another device/window: do not fight over the identity.
        this.setStatus('offline');
        return;
      }
      this.setStatus('connecting');
      this.retryTimer = setTimeout(() => void this.connectLoop(), 250);
    });
    this.setStatus('connected');
    for (const w of this.waiters.splice(0)) w.resolve(conn);
    this.emit('connected', {
      server: conn.server,
      rttMs: server.rttMs,
      stun: conn.stun,
      operator: conn.operator,
    });
    // A preferred server is measured once; make the list show the same number.
    this.setLatency(server.rttMs);
  }
}
