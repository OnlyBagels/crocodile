import { describe, expect, it } from 'vitest';
import {
  createNetworkProber,
  networkChecklist,
  networkVerdict,
  probeNetwork,
  routeFromStats,
} from '@crocodile/client-core';

type Gathered = {
  candidates: string[];
  errors?: { address?: string; port?: number; url?: string }[];
  /** Server URL each candidate came from, in order (null: not said). */
  urls?: (string | null)[];
  withDetails?: boolean;
};

/** A stand-in RTCPeerConnection: what gathering finds, given the STUN servers it was handed. */
function fakePeerConnection(gather: (servers: string[]) => Gathered) {
  return class {
    onicecandidate:
      ((ev: { candidate: { candidate: string } | null; url?: string | null }) => void) | null =
      null;
    onicecandidateerror: ((ev: { address?: string; port?: number; url?: string }) => void) | null =
      null;
    private servers: string[];
    constructor(config: { iceServers: { urls: string }[] }) {
      this.servers = config.iceServers.map((s) => s.urls);
    }
    createDataChannel() {}
    async createOffer() {
      return {};
    }
    async setLocalDescription() {
      const found = gather(this.servers);
      found.candidates.forEach((c, i) =>
        this.onicecandidate?.({ candidate: { candidate: c }, url: found.urls?.[i] ?? null }),
      );
      for (const e of found.errors ?? []) this.onicecandidateerror?.(e);
      this.onicecandidate?.({ candidate: null });
    }
    close() {}
  } as unknown as typeof RTCPeerConnection;
}

const host = (ip: string, port = 50000) => `candidate:1 1 udp 2122260223 ${ip} ${port} typ host`;
const srflx = (ip: string, port: number) =>
  `candidate:2 1 udp 1686052607 ${ip} ${port} typ srflx raddr 0.0.0.0 rport 0`;
const STUN = ['stun:coord.example:7443', 'stun:coord.example:7444'];

async function check(found: Gathered) {
  const { details, ...probe } = await probeNetwork(
    fakePeerConnection(() => found),
    STUN,
  );
  return { probe, verdict: networkVerdict(probe), ...(found.withDetails ? { details } : {}) };
}

describe('network check', () => {
  it('asks both STUN ports from one connection, so their answers are comparable', async () => {
    const asked: string[][] = [];
    await probeNetwork(
      fakePeerConnection((servers) => {
        asked.push(servers);
        return { candidates: [] };
      }),
      STUN,
    );
    expect(asked).toEqual([STUN]);
  });

  it('tells a good network from a limited or blocked one', async () => {
    // Both ports see the same mapping of our one socket, reported once: a cone NAT.
    expect(await check({ candidates: [host('10.0.0.2'), srflx('203.0.113.9', 40001)] })).toEqual({
      probe: { nat: 'cone', udp: true },
      verdict: 'good',
    });
    // Two sockets (two interfaces), one mapping each: still a cone NAT.
    expect(
      (
        await check({
          candidates: [
            host('10.0.0.2', 50000),
            host('192.168.5.3', 50002),
            srflx('203.0.113.9', 40001),
            srflx('198.51.100.4', 41000),
          ],
        })
      ).verdict,
    ).toBe('good');
    // One socket, a different mapping per port: symmetric NAT, direct connections often fail.
    expect(
      await check({
        candidates: [host('10.0.0.2'), srflx('203.0.113.9', 40001), srflx('203.0.113.9', 40777)],
      }),
    ).toEqual({ probe: { nat: 'symmetric', udp: true }, verdict: 'limited' });
    // No answer on the only socket: UDP is blocked, nothing direct can work.
    expect(
      await check({
        candidates: [host('10.0.0.2')],
        errors: [{ address: '10.0.0.2', port: 50000 }],
      }),
    ).toEqual({ probe: { nat: 'unknown', udp: false }, verdict: 'blocked' });
    // The answers matched our own address (dropped as duplicates): nothing in between.
    expect(await check({ candidates: [host('10.0.0.2')] })).toEqual({
      probe: { nat: 'open', udp: true },
      verdict: 'good',
    });
    expect(
      (await check({ candidates: [host('10.0.0.2'), srflx('10.0.0.2', 50000)] })).verdict,
    ).toBe('good');
  });

  it('judges each socket by its own answers, not by totals', async () => {
    const via = (ip: string, port: number, from: string, fromPort: number) =>
      `candidate:2 1 udp 1686052607 ${ip} ${port} typ srflx raddr ${from} rport ${fromPort}`;
    const twoSockets = [host('10.0.0.2', 50000), host('192.168.5.3', 50002)];
    const secondFails = [
      { address: '192.168.5.3', port: 50002 },
      { address: '192.168.5.3', port: 50002 },
    ];
    // One interface gets nowhere; the other gets a different mapping per
    // server: a symmetric NAT, though there are as many mappings as sockets.
    expect(
      (
        await check({
          candidates: [...twoSockets, srflx('203.0.113.9', 40001), srflx('203.0.113.9', 40777)],
          errors: secondFails,
        })
      ).probe.nat,
    ).toBe('symmetric');
    // The same, where the browser says which socket each mapping is of.
    expect(
      (
        await check({
          candidates: [
            ...twoSockets,
            via('203.0.113.9', 40001, '10.0.0.2', 50000),
            via('203.0.113.9', 40777, '10.0.0.2', 50000),
          ],
          errors: secondFails,
        })
      ).probe.nat,
    ).toBe('symmetric');
    // Only one server answered: one mapping proves nothing either way.
    expect(
      (
        await check({
          candidates: [host('10.0.0.2'), srflx('203.0.113.9', 40001)],
          errors: [{ address: '10.0.0.2', port: 50000 }],
        })
      ).probe.nat,
    ).toBe('unknown');
    // Both answered the socket with one mapping: a cone NAT.
    expect(
      (await check({ candidates: [...twoSockets, via('203.0.113.9', 40001, '10.0.0.2', 50000)] }))
        .verdict,
    ).toBe('good');
  });

  it("doesn't call a network blocked because one of its interfaces can't reach the server", async () => {
    // Public IPv4 (its answer dropped as a duplicate) next to IPv6 that can't
    // reach the IPv4-only server.
    expect(
      await check({
        candidates: [host('198.51.100.4', 50000), host('2001:db8::5', 50002)],
        errors: [{ address: '2001:db8::5', port: 50002 }],
      }),
    ).toEqual({ probe: { nat: 'unknown', udp: true }, verdict: 'unknown' });
    // An error that doesn't say which socket: can't tell.
    expect((await check({ candidates: [host('10.0.0.2')], errors: [{}] })).verdict).toBe('unknown');
  });

  it('tests again when the app moves to another server, and reuses a recent result otherwise', async () => {
    let gathered = 0;
    const PC = fakePeerConnection((servers) => {
      gathered++;
      return servers[0]!.startsWith('stun:a.')
        ? { candidates: [host('10.0.0.2'), srflx('203.0.113.9', 1)] }
        : { candidates: [host('10.0.0.2'), srflx('203.0.113.9', 1), srflx('203.0.113.9', 2)] };
    });
    let server = 'a';
    const probe = createNetworkProber(PC, () => [
      `stun:${server}.example:7443`,
      `stun:${server}.example:7444`,
    ]);
    expect(networkVerdict(await probe())).toBe('good');
    expect(networkVerdict(await probe())).toBe('good');
    expect(gathered).toBe(1);
    server = 'b';
    expect(networkVerdict(await probe())).toBe('limited');
    expect(gathered).toBe(2);
    await probe(true);
    expect(gathered).toBe(3);
  });

  it('records what each check found', async () => {
    // Behind a symmetric NAT, both ports answered (one says so on its candidate).
    const sym = await check({
      candidates: [host('10.0.0.2'), srflx('203.0.113.9', 40001), srflx('203.0.113.9', 40777)],
      urls: [null, STUN[0]!, STUN[1]!],
      withDetails: true,
    });
    expect(sym.details).toEqual({
      servers: [
        { url: STUN[0], answered: true },
        { url: STUN[1], answered: true },
      ],
      publicIps: ['203.0.113.9'],
      ipv6: false,
      complete: true,
    });
    // The second port is firewalled: only it fails, on our only socket.
    const half = await check({
      candidates: [host('10.0.0.2'), host('2001:db8::5', 50001), srflx('203.0.113.9', 40001)],
      errors: [
        { address: '10.0.0.2', port: 50000, url: STUN[1] },
        { address: '2001:db8::5', port: 50001, url: STUN[1] },
      ],
      withDetails: true,
    });
    expect(half.details!.servers).toEqual([
      { url: STUN[0], answered: true },
      { url: STUN[1], answered: false },
    ]);
    expect(half.details!.ipv6).toBe(true);
  });

  it('explains the result as a checklist', async () => {
    const statuses = (r: ReturnType<typeof networkChecklist>) =>
      Object.fromEntries(r.items.map((i) => [i.id, i.status]));
    const { details: sd, ...symmetric } = await probeNetwork(
      fakePeerConnection(() => ({
        candidates: [host('10.0.0.2'), srflx('203.0.113.9', 40001), srflx('203.0.113.9', 40777)],
      })),
      STUN,
    );
    const limited = networkChecklist({ ...symmetric, details: sd });
    expect(statuses(limited)).toEqual({
      udp: 'ok',
      ports: 'ok',
      address: 'ok',
      mapping: 'warn',
      ipv6: 'info',
    });
    expect(limited.items.find((i) => i.id === 'address')!.detail).toContain('203.0.113.9');
    // Limited is not "can't connect": it says who it still works with.
    expect(limited.reason).toMatch(/still work with most people/);

    const blocked = networkChecklist({ nat: 'unknown', udp: false });
    expect(statuses(blocked)).toMatchObject({ udp: 'fail', mapping: 'unknown' });
    expect(blocked.reason).toMatch(/^Blocked/);
    // A result without details (an older cached one) still gives the basics.
    expect(networkChecklist({ nat: 'cone', udp: true }).items.map((i) => i.id)).toEqual([
      'udp',
      'address',
      'mapping',
    ]);
  });

  it('reads how a connection travels from WebRTC stats', () => {
    const stats = (local: string, remote: string, remoteAddress = '203.0.113.9') =>
      new Map<string, Record<string, unknown>>([
        ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
        ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' }],
        ['L', { id: 'L', type: 'local-candidate', candidateType: local, address: '192.168.1.5' }],
        ['R', { id: 'R', type: 'remote-candidate', candidateType: remote, address: remoteAddress }],
      ]) as unknown as RTCStatsReport;
    expect(routeFromStats(stats('host', 'host', '192.168.1.7'))).toBe('lan');
    expect(routeFromStats(stats('host', 'host', '127.0.0.1'))).toBe('local');
    expect(routeFromStats(stats('host', 'host', '127.0.0.2'))).toBe('local');
    // Found during connectivity checks: still the same network.
    expect(routeFromStats(stats('host', 'prflx', '10.0.0.8'))).toBe('lan');
    expect(routeFromStats(stats('host', 'host', 'b1c2d3e4.local'))).toBe('lan');
    expect(routeFromStats(stats('host', 'host', 'fd00::5'))).toBe('lan');
    expect(routeFromStats(stats('srflx', 'srflx'))).toBe('internet');
    // Same address at both ends.
    expect(routeFromStats(stats('host', 'prflx', '192.168.1.5'))).toBe('local');
    expect(routeFromStats(stats('prflx', 'host', '2001:db8::7'))).toBe('internet');
    expect(routeFromStats(stats('relay', 'host'))).toBe('relay');
    expect(routeFromStats(new Map() as unknown as RTCStatsReport)).toBeNull();
    // A peer-reflexive address the browser hides: still a direct path. (It
    // stays hidden for the life of the connection, so "not known yet" kept
    // video off for good.)
    expect(routeFromStats(stats('host', 'prflx', ''))).toBe('direct');
    // Unless the other end offered a server relay it might be.
    const withRelay = stats('host', 'prflx', '') as unknown as Map<string, unknown>;
    withRelay.set('R2', { id: 'R2', type: 'remote-candidate', candidateType: 'relay' });
    expect(routeFromStats(withRelay as unknown as RTCStatsReport)).toBeNull();
  });
});
