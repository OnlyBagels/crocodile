import {
  answerChannel,
  SecureChannel,
  signInChannelContext,
  sign,
  verifyPayload,
  type Identity,
} from '@crocodile/crypto';
import {
  OperatorInfo,
  SIG_DOMAIN,
  helloFullPayload,
  type ClientAuthBody,
  type Platform,
  type RpcError,
  type RpcMethod,
  type RpcMethods,
  type RpcParamsOf,
  type ServerEvents,
  type ServerFrame,
  type ServerHello,
  type ServerInfo,
  type SignedRecord,
} from '@crocodile/protocol';
import { Emitter } from './emitter';

export class RpcCallError extends Error {
  constructor(
    readonly code: RpcError['code'],
    message: string,
    /** For account_deleted: the server's proof, unverified until checked. */
    readonly record?: SignedRecord,
  ) {
    super(message);
  }
}

export type ConnectionEvents = ServerEvents & {
  close: { code: number; reason: string };
};

export interface ConnectOptions {
  url: string;
  identity: Identity;
  /** This installation's device id. */
  deviceId: string;
  platform: Platform;
  version: string;
  /** If known (from the directory), the server must prove it holds this key. */
  expectedServerKey?: string;
  timeoutMs?: number;
  /** WebSocket implementation; defaults to the global one. */
  WebSocketImpl?: typeof WebSocket;
}

function wsUrl(httpUrl: string) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/$/, '') + '/v1/client';
  return u.toString();
}

/**
 * One authenticated WebSocket to a coordination server. Reconnection and
 * fail-over between servers live a level up, in CoordinatorLink.
 */
export class CoordinatorConnection extends Emitter<ConnectionEvents> {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly channel: SecureChannel,
    readonly server: ServerInfo,
    readonly stun: string[],
    readonly userId: string,
    /** `<userId>.<deviceId>` */
    readonly peer: string,
    /** Who runs the server, as it says; dropped unless well-formed. */
    readonly operator?: OperatorInfo,
  ) {
    super();
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = (ev) => this.onClose(ev.code, ev.reason);
  }

  static connect(opts: ConnectOptions): Promise<CoordinatorConnection> {
    const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
    return new Promise((resolve, reject) => {
      const ws = new WS(wsUrl(opts.url));
      let hello: ServerHello | undefined;
      let channel: SecureChannel | undefined;
      const fail = (err: Error) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Error(`timed out connecting to ${opts.url}`)),
        opts.timeoutMs ?? 10_000,
      );
      ws.onerror = () => fail(new Error(`cannot reach ${opts.url}`));
      ws.onclose = (ev) => fail(new Error(`connection closed: ${ev.reason || ev.code}`));
      ws.onmessage = (ev) => {
        let frame: ServerFrame | { t: 'x'; n: number; c: string };
        try {
          frame = JSON.parse(String(ev.data));
        } catch {
          return fail(new Error('invalid frame from server'));
        }
        if (frame.t === 'x') {
          const inner = channel?.open(frame) as ServerFrame | undefined;
          if (!inner) return fail(new Error('could not decrypt server frame'));
          frame = inner;
        }
        if (frame.t === 'hello' && !hello) {
          hello = frame;
          const ok = verifyPayload(
            frame.server.key,
            SIG_DOMAIN.serverHello,
            {
              challenge: frame.challenge,
              server: frame.server.id,
              time: frame.time,
              channel: frame.channel,
            },
            frame.sig,
          );
          if (!ok) return fail(new Error('server failed to prove its identity'));
          // The rest of the hello (STUN servers, operator) counts only when
          // the server signed it too. Unsigned (a server too old to sign it)
          // or changed on the way, none of it is used.
          const signedFull =
            typeof frame.sigFull === 'string' &&
            verifyPayload(
              frame.server.key,
              SIG_DOMAIN.serverHelloFull,
              helloFullPayload(frame),
              frame.sigFull,
            );
          hello = signedFull ? frame : { ...frame, stun: [], operator: undefined };
          if (opts.expectedServerKey && opts.expectedServerKey !== frame.server.key) {
            return fail(new Error('server key does not match the directory listing'));
          }
          let answer: { epk: string; kem: string };
          let authChannel: SecureChannel;
          try {
            const res = answerChannel(frame.channel);
            answer = res.answer;
            // Who we are goes sealed, under keys of their own (the server learns our peer id
            // only from it, and the channel for the rest of the connection includes it).
            authChannel = new SecureChannel(
              res.secret,
              signInChannelContext(frame.challenge, frame.server.id),
              true,
            );
            const peer = `${opts.identity.userId}.${opts.deviceId}`;
            channel = new SecureChannel(
              res.secret,
              `${frame.challenge}|${frame.server.id}|${peer}`,
              true,
            );
          } catch {
            return fail(new Error('server offered an invalid channel'));
          }
          const body: ClientAuthBody = {
            key: opts.identity.publicKey,
            device: opts.deviceId,
            sig: sign(opts.identity, SIG_DOMAIN.auth, {
              challenge: frame.challenge,
              server: frame.server.id,
              device: opts.deviceId,
              channel: answer,
            }),
            client: { platform: opts.platform, version: opts.version },
          };
          const { n, c } = authChannel.seal(body);
          ws.send(JSON.stringify({ t: 'auth', channel: answer, sealed: { n, c } }));
        } else if (frame.t === 'auth_ok' && hello && channel) {
          clearTimeout(timer);
          ws.onerror = null;
          resolve(
            new CoordinatorConnection(
              ws,
              channel,
              hello.server,
              hello.stun,
              frame.userId,
              frame.peer,
              OperatorInfo.safeParse(hello.operator).data,
            ),
          );
        } else if (frame.t === 'error') {
          fail(new RpcCallError(frame.err.code, frame.err.message, frame.err.record));
        }
      };
    });
  }

  get isOpen() {
    return !this.closed;
  }

  request<M extends RpcMethod>(
    method: M,
    params: RpcParamsOf<M>,
    timeoutMs = 15_000,
  ): Promise<RpcMethods[M]> {
    if (this.closed) return Promise.reject(new RpcCallError('unavailable', 'not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcCallError('unavailable', `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify(this.channel.seal({ t: 'req', id, m: method, p: params })));
    });
  }

  close() {
    if (this.closed) return;
    this.ws.close(1000, 'bye');
    this.onClose(1000, 'closed by client');
  }

  private onMessage(data: unknown) {
    let frame: ServerFrame;
    try {
      const outer = JSON.parse(String(data)) as { t: string; n: number; c: string };
      if (outer.t !== 'x') return;
      const inner = this.channel.open(outer) as ServerFrame | undefined;
      if (!inner) return this.close();
      frame = inner;
    } catch {
      return;
    }
    if (frame.t === 'res') {
      const p = this.pending.get(frame.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(frame.id);
      if (frame.err) p.reject(new RpcCallError(frame.err.code, frame.err.message));
      else p.resolve(frame.ok);
    } else if (frame.t === 'ev') {
      this.emit(frame.ev, frame.d as never);
    }
  }

  private onClose(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcCallError('unavailable', 'connection closed'));
    }
    this.pending.clear();
    this.emit('close', { code, reason });
  }
}
