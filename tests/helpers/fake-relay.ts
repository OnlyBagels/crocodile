import type { ClientToRelay, PeerState, RelayToClient, SignalData } from '@crocodile/protocol';
import {
  Emitter,
  type HostRelayAdapter,
  type RelayHandle,
  type RelayLinkEvents,
  type RelayTransport,
  type TransportFactory,
} from '@crocodile/client-core';

/**
 * In-memory stand-in for WebRTC + HostRelay with the same routing semantics,
 * so client logic (election following, E2EE, history sync) can be tested in
 * Node. The real relay is covered by its own WebRTC tests.
 */
export class FakeRelayNetwork {
  private relays = new Map<string, FakeRelay>();
  private onFailed = new Map<string, (reason: string) => void>();
  /** Relays started so far. */
  started = 0;

  adapter(): HostRelayAdapter {
    return {
      start: async (opts) => {
        this.started++;
        const relay = new FakeRelay(opts.hostPeer, opts.members);
        const key = `${opts.sessionId}|${opts.epoch}|${opts.hostPeer}`;
        this.relays.set(key, relay);
        if (opts.onFailed) this.onFailed.set(key, opts.onFailed);
        return {
          handleSignal: () => {},
          close: async () => {
            if (this.relays.get(key) === relay) this.relays.delete(key);
            relay.close();
          },
        } satisfies RelayHandle;
      },
    };
  }

  transportFactory(): TransportFactory {
    return (opts) =>
      new FakeTransport(
        this,
        `${opts.sessionId}|${opts.epoch}|${opts.host}`,
        opts.self,
        opts.iceServers.some((s) => [s.urls].flat().some((u) => u.startsWith('turn:'))),
      );
  }

  /** Users whose network allows no direct connections (only a TURN relay gets through). */
  readonly blocked = new Set<string>();
  /**
   * Users behind a symmetric NAT: they can connect out to others, but others
   * can't reach them, so nobody else can connect to a relay they host.
   */
  readonly unreachable = new Set<string>();

  /** Whether `member` can't reach `host`'s relay directly. */
  blocksDirect(member: string, host: string) {
    const user = (p: string) => p.split('.')[0]!;
    if (this.blocked.has(user(member)) || this.blocked.has(user(host))) return true;
    return user(member) !== user(host) && this.unreachable.has(user(host));
  }

  find(key: string) {
    return this.relays.get(key);
  }

  /** The host's relay process dies; the app itself (and its link) carry on. */
  crashRelayProcessOf(userId: string) {
    // The relays running now: those started again from onFailed live on.
    for (const [key, relay] of [...this.relays]) {
      if (key.split('|')[2]!.startsWith(`${userId}.`)) {
        this.relays.delete(key);
        relay.close();
        this.onFailed.get(key)?.('relay process exited');
      }
    }
  }

  /** Simulate the host vanishing without a goodbye (crash, network loss). */
  killRelaysOf(userId: string) {
    for (const [key, relay] of [...this.relays]) {
      if (key.split('|')[2]!.startsWith(`${userId}.`)) {
        this.relays.delete(key);
        relay.close();
      }
    }
  }
}

class FakeRelay {
  peers = new Map<string, { t: FakeTransport; state: PeerState }>();
  constructor(
    readonly host: string,
    private readonly members: () => string[],
  ) {}

  attach(t: FakeTransport): boolean {
    if (!this.members().includes(t.userId)) return false;
    const others = [...this.peers.values()];
    this.peers.set(t.userId, { t, state: { id: t.userId, muted: false, deafened: false } });
    t.deliver({
      t: 'hello',
      you: t.userId,
      host: this.host,
      peers: others.map((o) => o.state),
      slots: 0,
    });
    for (const o of others) o.t.deliver({ t: 'peer_join', peer: this.peers.get(t.userId)!.state });
    return true;
  }

  detach(userId: string) {
    if (!this.peers.delete(userId)) return;
    for (const o of this.peers.values()) o.t.deliver({ t: 'peer_leave', peer: userId });
  }

  route(from: string, msg: ClientToRelay) {
    if (msg.t === 'state') {
      const me = this.peers.get(from);
      if (!me) return;
      const { t: _, ...state } = msg;
      me.state = { id: from, ...state };
      for (const o of this.peers.values()) o.t.deliver({ t: 'peer_state', peer: me.state });
    } else if (msg.t === 'ping') {
      this.peers.get(from)?.t.deliver({ t: 'pong', ts: msg.ts });
    } else if (msg.t === 'bcast') {
      for (const [id, o] of this.peers)
        if (id !== from) o.t.deliver({ t: 'msg', from, direct: false, d: msg.d });
    } else if (msg.t === 'direct' && msg.to) {
      this.peers.get(msg.to)?.t.deliver({ t: 'msg', from, direct: true, d: msg.d });
    }
  }

  close() {
    for (const o of this.peers.values()) o.t.drop('host went away');
    this.peers.clear();
  }
}

/** werift's SCTP max-message-size. */
const MAX_MESSAGE_SIZE = 65536;

class FakeTransport extends Emitter<RelayLinkEvents> implements RelayTransport {
  private relay?: FakeRelay;
  private closed = false;

  constructor(
    private readonly net: FakeRelayNetwork,
    private readonly key: string,
    readonly userId: string,
    private readonly viaTurn = false,
  ) {
    super();
  }

  /** Like ICE: a direct path when one exists, even with the server relay on offer. */
  async route() {
    if (!this.isOpen) return null;
    const direct = !this.net.blocksDirect(this.userId, this.relay!.host);
    return direct ? ('lan' as const) : ('relay' as const);
  }

  get isOpen() {
    return !!this.relay && !this.closed;
  }

  async connect() {
    this.emit('progress', { step: 'offer' });
    // Like a real offer, give the host a moment to learn it was elected.
    for (let i = 0; i < 100 && !this.closed; i++) {
      const relay = this.net.find(this.key);
      if (relay) this.emit('progress', { step: 'answer' });
      if (relay && !this.viaTurn && this.net.blocksDirect(this.userId, relay.host)) {
        // Like ICE with no working candidate pair.
        setTimeout(() => this.drop('connection failed'), 30);
        return;
      }
      if (relay) {
        this.relay = relay;
        setTimeout(() => {
          if (this.closed) return;
          this.emit('progress', { step: 'path' });
          if (!relay.attach(this)) return this.drop('not admitted');
          this.emit('open', undefined);
        }, 5);
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!this.closed) this.drop('host relay not found');
  }

  async handleSignal(_data: SignalData) {}

  deliver(msg: RelayToClient) {
    setTimeout(() => !this.closed && this.emit('message', msg), 1);
  }

  send(msg: { t: string }) {
    if (!this.isOpen) return false;
    // Like werift's data channel, which the host relay uses.
    const size = JSON.stringify(msg).length;
    if (size > MAX_MESSAGE_SIZE)
      throw new Error(`max-message-size exceeded: ${size} > ${MAX_MESSAGE_SIZE}`);
    const relay = this.relay!;
    setTimeout(() => relay.route(this.userId, msg as ClientToRelay), 1);
    return true;
  }

  drop(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.relay?.detach(this.userId);
    this.emit('failed', { reason });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.relay?.detach(this.userId);
    this.emit('closed', undefined);
  }
}
