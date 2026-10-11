import { afterEach, describe, expect, it } from 'vitest';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { createHash, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import {
  TurnServer,
  canonicalIp,
  encodeStun,
  isForbiddenPeerAddress,
  parseStun,
  parseXorAddress,
  xorAddress,
} from '../src/turn';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function waitFor<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function connect(a: RTCPeerConnection, b: RTCPeerConnection) {
  a.onIceCandidate.subscribe((c) => c && b.addIceCandidate(c).catch(() => {}));
  b.onIceCandidate.subscribe((c) => c && a.addIceCandidate(c).catch(() => {}));
  const dc = a.createDataChannel('x');
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  return dc;
}

describe('TURN relay', () => {
  it('relays a WebRTC data channel for a relay-only peer and enforces grants and quotas', async () => {
    const turn = await new TurnServer({
      port: 0,
      host: '127.0.0.1',
      relayIp: '127.0.0.1',
      secret: randomBytes(32),
      limits: { maxUsers: 1 },
      allowPrivatePeers: true,
    }).start();
    cleanup.push(() => turn.stop());
    const creds = turn.credentials('aaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now() + 60_000);

    const relayed = new RTCPeerConnection({
      iceServers: [
        {
          urls: `turn:127.0.0.1:${turn.port}`,
          username: creds.username,
          credential: creds.credential,
        },
      ],
      iceTransportPolicy: 'relay',
    });
    const direct = new RTCPeerConnection({
      iceServers: [{ urls: `stun:127.0.0.1:${turn.port}` }],
      iceAdditionalHostAddresses: ['127.0.0.1'],
    });
    cleanup.push(
      () => relayed.close(),
      () => direct.close(),
    );
    const received: string[] = [];
    direct.onDataChannel.subscribe((ch: RTCDataChannel) =>
      ch.onMessage.subscribe((m) => received.push(m.toString())),
    );
    const dc = await connect(relayed, direct);
    await waitFor(() => dc.readyState === 'open');
    dc.send('through the relay');
    await waitFor(() => received.includes('through the relay'));
    expect(turn.allocationCount()).toBe(1);
    expect(turn.activeUsers()).toEqual(new Set(['aaaaaaaaaaaaaaaaaaaaaaaaaa']));

    // A second user is refused while the one-user quota is taken.
    const other = turn.credentials('bbbbbbbbbbbbbbbbbbbbbbbbbb', Date.now() + 60_000);
    const refused = new RTCPeerConnection({
      iceServers: [
        {
          urls: `turn:127.0.0.1:${turn.port}`,
          username: other.username,
          credential: other.credential,
        },
      ],
      iceTransportPolicy: 'relay',
    });
    cleanup.push(() => refused.close());
    refused.createDataChannel('y');
    const gathered: string[] = [];
    refused.onIceCandidate.subscribe((c) => c && gathered.push(c.candidate));
    await refused.setLocalDescription(await refused.createOffer());
    await new Promise((r) => setTimeout(r, 500));
    expect(gathered.filter((c) => c.includes('relay'))).toHaveLength(0);

    // Expired credentials are rejected outright.
    const expired = turn.credentials('cccccccccccccccccccccccccc', Date.now() - 1000);
    const late = new RTCPeerConnection({
      iceServers: [
        {
          urls: `turn:127.0.0.1:${turn.port}`,
          username: expired.username,
          credential: expired.credential,
        },
      ],
      iceTransportPolicy: 'relay',
    });
    cleanup.push(() => late.close());
    late.createDataChannel('z');
    const lateCands: string[] = [];
    late.onIceCandidate.subscribe((c) => c && lateCands.push(c.candidate));
    await late.setLocalDescription(await late.createOffer());
    await new Promise((r) => setTimeout(r, 500));
    expect(lateCands.filter((c) => c.includes('relay'))).toHaveLength(0);

    turn.dropUser('aaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(turn.allocationCount()).toBe(0);
  });

  it('never relays to the host itself or its private network', async () => {
    const own = new Set(['203.0.114.9', '2a01:4f8::5'].map((a) => canonicalIp(a)!));
    for (const bad of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '100.64.0.1',
      '169.254.169.254',
      '224.0.0.251',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.0.10',
      '::127.0.0.1',
      // Uncompressed spellings, as parsed from an IPv6 XOR-PEER-ADDRESS.
      '0:0:0:0:0:ffff:7f00:1',
      '0:0:0:0:0:0:7f00:1',
      '0:0:0:0:0:ffff:c0a8:101',
      '0:0:0:0:0:0:0:1',
      'fe80::1',
      'fd00::1',
      'ff02::1',
      '203.0.114.9',
      '::ffff:203.0.114.9',
      '2a01:4f8:0:0:0:0:0:5',
      '2A01:4F8::5',
      'not-an-ip',
    ]) {
      expect(isForbiddenPeerAddress(bad, own), bad).toBe(true);
    }
    for (const ok of [
      '8.8.8.8',
      '203.0.114.10',
      '2606:4700::1111',
      '2606:4700:0:0:0:0:0:1111',
      '::ffff:1.1.1.1',
    ]) {
      expect(isForbiddenPeerAddress(ok, own), ok).toBe(false);
    }

    // End to end: a relay-only client cannot open a path to a loopback peer.
    const turn = await new TurnServer({
      port: 0,
      host: '127.0.0.1',
      relayIp: '127.0.0.1',
      secret: randomBytes(32),
    }).start();
    cleanup.push(() => turn.stop());
    const creds = turn.credentials('dddddddddddddddddddddddddd', Date.now() + 60_000);
    const relayed = new RTCPeerConnection({
      iceServers: [
        {
          urls: `turn:127.0.0.1:${turn.port}`,
          username: creds.username,
          credential: creds.credential,
        },
      ],
      iceTransportPolicy: 'relay',
    });
    const target = new RTCPeerConnection({ iceAdditionalHostAddresses: ['127.0.0.1'] });
    cleanup.push(
      () => relayed.close(),
      () => target.close(),
    );
    const dc = await connect(relayed, target);
    await new Promise((r) => setTimeout(r, 3000));
    expect(dc.readyState).not.toBe('open');
  });

  it('refuses IPv6-encoded private peers in CreatePermission', async () => {
    const turn = await new TurnServer({
      port: 0,
      host: '127.0.0.1',
      relayIp: '127.0.0.1',
      secret: randomBytes(32),
    }).start();
    cleanup.push(() => turn.stop());
    const sock = createSocket('udp4');
    cleanup.push(() => sock.close());
    const replies: Buffer[] = [];
    sock.on('message', (b) => replies.push(b));
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
    // Sends one STUN request and returns the error code of the reply (0 = success).
    const ask = async (
      method: number,
      attrs: (txId: Buffer) => { type: number; value: Buffer }[],
      key?: Buffer,
    ) => {
      const txId = randomBytes(12);
      sock.send(encodeStun(method, 0, txId, attrs(txId), key), turn.port, '127.0.0.1');
      const m = await waitFor(() =>
        replies.map(parseStun).find((r): r is NonNullable<typeof r> => !!r?.txId.equals(txId)),
      );
      const err = m.attrs.find((a) => a.type === 0x0009)?.value;
      return { m, code: err ? err[2]! * 100 + err[3]! : 0 };
    };
    const creds = turn.credentials('eeeeeeeeeeeeeeeeeeeeeeeeee', Date.now() + 60_000);
    const key = createHash('md5')
      .update(`${creds.username}:crocodile:${creds.credential}`)
      .digest();
    const transport = { type: 0x0019, value: Buffer.from([17, 0, 0, 0]) };
    const first = await ask(0x003, () => [transport]);
    expect(first.code).toBe(401);
    const auth = [
      { type: 0x0006, value: Buffer.from(creds.username) },
      { type: 0x0014, value: Buffer.from('crocodile') },
      first.m.attrs.find((a) => a.type === 0x0015)!,
    ];
    expect((await ask(0x003, () => [transport, ...auth], key)).code).toBe(0);
    const permit = async (peer: string) =>
      (
        await ask(
          0x008,
          (txId) => [{ type: 0x0012, value: xorAddress(peer, 9, txId) }, ...auth],
          key,
        )
      ).code;
    // Loopback and private IPv4 written as IPv6 (family 2) are refused…
    for (const peer of ['::ffff:127.0.0.1', '::127.0.0.1', '::ffff:192.168.1.1', '::1']) {
      expect(await permit(peer), peer).toBe(403);
    }
    // …while a public IPv6 peer is fine.
    expect(await permit('2606:4700::1111')).toBe(0);
  });

  /** A TURN client on a UDP socket: authenticated requests, and what comes back. */
  async function turnClient(turn: TurnServer, opts: { user?: string; expiresAt?: number } = {}) {
    const sock = createSocket('udp4');
    cleanup.push(() => sock.close());
    const replies: Buffer[] = [];
    sock.on('message', (b) => replies.push(b));
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
    const creds = turn.credentials(
      opts.user ?? 'eeeeeeeeeeeeeeeeeeeeeeeeee',
      opts.expiresAt ?? Date.now() + 60_000,
    );
    const key = createHash('md5')
      .update(`${creds.username}:crocodile:${creds.credential}`)
      .digest();
    const send = (
      method: number,
      txId: Buffer,
      attrs: { type: number; value: Buffer }[],
      k?: Buffer,
    ) => sock.send(encodeStun(method, 0, txId, attrs, k), turn.port, '127.0.0.1');
    const answer = (txId: Buffer) =>
      waitFor(() =>
        replies.map(parseStun).find((r): r is NonNullable<typeof r> => !!r?.txId.equals(txId)),
      );
    const transport = { type: 0x0019, value: Buffer.from([17, 0, 0, 0]) };
    const tx0 = randomBytes(12);
    send(0x003, tx0, [transport]);
    const nonce = (await answer(tx0)).attrs.find((a) => a.type === 0x0015)!;
    const auth = [
      { type: 0x0006, value: Buffer.from(creds.username) },
      { type: 0x0014, value: Buffer.from('crocodile') },
      nonce,
    ];
    return { sock, replies, key, auth, transport, send, answer };
  }

  it('a permission matches its peer however the address was written', async () => {
    const turn = await new TurnServer({
      port: 0,
      host: '127.0.0.1',
      relayIp: '127.0.0.1',
      secret: randomBytes(32),
      allowPrivatePeers: true,
    }).start();
    cleanup.push(() => turn.stop());
    const c = await turnClient(turn);
    const tx = randomBytes(12);
    c.send(0x003, tx, [c.transport, ...c.auth], c.key);
    const allocated = await c.answer(tx);
    const relayed = parseXorAddress(allocated.attrs.find((a) => a.type === 0x0016)!.value, tx)!;

    const peer = createSocket('udp4');
    cleanup.push(() => peer.close());
    await new Promise<void>((r) => peer.bind(0, '127.0.0.1', r));
    // The peer named as an IPv4-mapped IPv6 address; its packets come from 127.0.0.1.
    const txp = randomBytes(12);
    c.send(
      0x008,
      txp,
      [
        { type: 0x0012, value: xorAddress('::ffff:127.0.0.1', peer.address().port, txp) },
        ...c.auth,
      ],
      c.key,
    );
    expect((await c.answer(txp)).attrs.find((a) => a.type === 0x0009)).toBeUndefined();
    peer.send(Buffer.from('hello'), relayed.port, '127.0.0.1');
    const data = await waitFor(
      () =>
        c.replies
          .map(parseStun)
          .find((r) => r?.method === 0x007)
          ?.attrs.find((a) => a.type === 0x0013)?.value,
    );
    expect(data.toString()).toBe('hello');
  });

  it('a retransmitted Allocate makes one allocation, not two', async () => {
    const turn = await new TurnServer({
      port: 0,
      host: '127.0.0.1',
      relayIp: '127.0.0.1',
      secret: randomBytes(32),
    }).start();
    cleanup.push(() => turn.stop());
    const internals = turn as unknown as {
      bindRelaySocket(type: string): Promise<unknown>;
      allocations: Map<string, unknown>;
    };
    let binds = 0;
    const bind = internals.bindRelaySocket.bind(turn);
    internals.bindRelaySocket = async (type) => {
      binds++;
      await new Promise((r) => setTimeout(r, 50));
      return bind(type);
    };
    const c = await turnClient(turn);
    const tx = randomBytes(12);
    // The client didn't hear back in time and sends the same request again.
    c.send(0x003, tx, [c.transport, ...c.auth], c.key);
    c.send(0x003, tx, [c.transport, ...c.auth], c.key);
    expect((await c.answer(tx)).attrs.find((a) => a.type === 0x0009)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(binds).toBe(1);
    expect(internals.allocations.size).toBe(1);
  });

  /** Allocates for a client; resolves with the error code, or 0 on success. */
  async function allocate(c: Awaited<ReturnType<typeof turnClient>>) {
    const tx = randomBytes(12);
    c.send(0x003, tx, [c.transport, ...c.auth], c.key);
    const err = (await c.answer(tx)).attrs.find((a) => a.type === 0x0009)?.value;
    return err ? err[2]! * 100 + err[3]! : 0;
  }

  it("a user's newest allocation replaces their oldest at the cap, instead of being refused", async () => {
    const turn = await new TurnServer({
      port: 0,
      host: '127.0.0.1',
      relayIp: '127.0.0.1',
      secret: randomBytes(32),
      limits: { maxAllocationsPerUser: 2 },
    }).start();
    cleanup.push(() => turn.stop());
    const tuples = (turn as unknown as { allocations: Map<string, unknown> }).allocations;
    const clients: Awaited<ReturnType<typeof turnClient>>[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await turnClient(turn);
      // Connections that ended without a goodbye leave allocations behind.
      expect(await allocate(c)).toBe(0);
      clients.push(c);
    }
    const port = (c: (typeof clients)[number]) => `127.0.0.1|${c.sock.address().port}`;
    expect([...tuples.keys()]).toEqual([port(clients[1]!), port(clients[2]!)]);
    // Another user's allocations are not touched.
    const other = await turnClient(turn, { user: 'ffffffffffffffffffffffffff' });
    expect(await allocate(other)).toBe(0);
    expect(turn.allocationCount()).toBe(3);
  });

  it('keeps an allocation whose grant was extended past its credentials', async () => {
    let grantEnd = Date.now() + 60_000;
    const turn = await new TurnServer({
      port: 0,
      host: '127.0.0.1',
      relayIp: '127.0.0.1',
      secret: randomBytes(32),
      grantEnd: () => grantEnd,
    }).start();
    cleanup.push(() => turn.stop());
    // Credentials written for a grant that has since been renewed.
    const c = await turnClient(turn, { expiresAt: Date.now() + 1500 });
    expect(await allocate(c)).toBe(0);
    await new Promise((r) => setTimeout(r, 2600));
    // Past the credentials' expiry and a sweep later, still there and refreshable.
    expect(turn.allocationCount()).toBe(1);
    const tx = randomBytes(12);
    const lifetime = { type: 0x000d, value: Buffer.from([0, 0, 2, 0x58]) };
    c.send(0x004, tx, [lifetime, ...c.auth], c.key);
    const refreshed = await c.answer(tx);
    expect(refreshed.attrs.find((a) => a.type === 0x0009)).toBeUndefined();
    // Once the grant really ends, the allocation goes.
    grantEnd = Date.now() - 1;
    await waitFor(() => turn.allocationCount() === 0, 5000);
  });
});
