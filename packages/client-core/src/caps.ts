import type { HostCaps, NatType } from '@crocodile/protocol';

/**
 * Rough NAT classification from ICE gathering: compare the public mapping two
 * different STUN servers see. Same port → endpoint-independent mapping (cone,
 * good for hosting); different → symmetric (poor host). If our host candidate
 * already is the public address we are directly reachable ("open").
 */
export async function detectNat(
  RTCPeerConnectionImpl: typeof RTCPeerConnection,
  stunUrls: string[],
  timeoutMs = 4000,
): Promise<NatType> {
  return (await probeNetwork(RTCPeerConnectionImpl, stunUrls, timeoutMs)).nat;
}

/**
 * What the network allows, from the coordination server's two STUN ports:
 * `udp` is false when neither answered (UDP blocked, so no direct
 * connections at all), `nat` is the mapping type as in detectNat.
 */
export interface NetworkProbe {
  nat: NatType;
  udp: boolean;
  /** What each part of the check found (absent from cached or fake results). */
  details?: NetworkProbeDetails;
}

export interface NetworkProbeDetails {
  /** Each STUN port asked, and whether it answered (null: can't tell). */
  servers: { url: string; answered: boolean | null }[];
  /** Public addresses the servers saw us as. */
  publicIps: string[];
  /** This device has a usable IPv6 address. */
  ipv6: boolean;
  /** Gathering finished before the time limit. */
  complete: boolean;
}

export async function probeNetwork(
  RTCPeerConnectionImpl: typeof RTCPeerConnection,
  stunUrls: string[],
  timeoutMs = 8000,
): Promise<NetworkProbe> {
  const servers = [...new Set(stunUrls)].slice(0, 2);
  if (servers.length === 0) return { nat: 'unknown', udp: true };
  // One connection asks both STUN ports from the same local sockets, so their
  // answers are comparable: behind a cone NAT both see the same mapping
  // (which WebRTC reports once), behind a symmetric NAT each sees its own.
  const pc = new RTCPeerConnectionImpl({ iceServers: servers.map((urls) => ({ urls })) });
  pc.createDataChannel('probe');
  /** Local sockets ("ip:port") and the public mappings the servers saw. */
  const hosts = new Set<string>();
  const hostIps = new Set<string>();
  const mapped = new Set<string>();
  const mappedIps = new Set<string>();
  /** The mappings each local socket got, when the candidate says which socket. */
  const bySocket = new Map<string, Set<string>>();
  /** STUN requests that failed, per local socket; `unattributed` if one didn't say. */
  const failed = new Map<string, number>();
  let unattributed = false;
  let complete = false;
  /** Per STUN URL: sockets whose request failed ('?' if the error didn't say). */
  const failedByUrl = new Map<string, Set<string>>();
  /** STUN URLs some public mapping came from. */
  const answeredBy = new Set<string>();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.onicecandidateerror = (ev) => {
      const e = ev as RTCPeerConnectionIceErrorEvent;
      const socket = e.address && e.port ? `${e.address}:${e.port}` : '?';
      if (socket !== '?') failed.set(socket, (failed.get(socket) ?? 0) + 1);
      else unattributed = true;
      if (e.url) {
        let set = failedByUrl.get(e.url);
        if (!set) failedByUrl.set(e.url, (set = new Set()));
        set.add(socket);
      }
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) {
        complete = true;
        clearTimeout(timer);
        resolve();
        return;
      }
      const parts = ev.candidate.candidate.split(' ');
      const ip = parts[4];
      const port = parts[5];
      const type = parts[7];
      if (!ip || parts[2]?.toLowerCase() !== 'udp') return;
      if (type === 'host') {
        hosts.add(`${ip}:${port}`);
        hostIps.add(ip);
      }
      if (type === 'srflx') {
        mapped.add(`${ip}:${port}`);
        mappedIps.add(ip);
        // Which server saw it (the event's url; not every browser says).
        const url = (ev as RTCPeerConnectionIceEvent & { url?: string | null }).url;
        if (url) answeredBy.add(url);
        // Which local socket it maps (browsers often hide it: 0.0.0.0 0).
        const raddr = parts[parts.indexOf('raddr') + 1];
        const rport = parts[parts.indexOf('rport') + 1];
        if (
          parts.includes('raddr') &&
          raddr &&
          rport &&
          rport !== '0' &&
          !/^(0\.0\.0\.0|::)$/.test(raddr)
        ) {
          const socket = `${raddr}:${rport}`;
          let set = bySocket.get(socket);
          if (!set) bySocket.set(socket, (set = new Set()));
          set.add(`${ip}:${port}`);
        }
      }
    };
    void pc.createOffer().then((o) => pc.setLocalDescription(o));
  });
  pc.close();
  const details: NetworkProbeDetails = {
    servers: servers.map((url) => {
      if (answeredBy.has(url)) return { url, answered: true };
      if (!complete) return { url, answered: null };
      const fails = failedByUrl.get(url);
      if (!fails) return { url, answered: true };
      if (fails.has('?') || hosts.size === 0) return { url, answered: fails.size ? false : null };
      return { url, answered: [...hosts].some((h) => !fails.has(h)) };
    }),
    publicIps: [...mappedIps],
    ipv6: [...hostIps].some((ip) => ip.includes(':') && !/^fe80/i.test(ip)),
    complete,
  };
  return { ...classify(), details };

  function classify(): Omit<NetworkProbe, 'details'> {
    if (mapped.size === 0) {
      // Nobody saw us from outside. Either no request got an answer (UDP
      // blocked), or every answer matched a local address, which WebRTC drops
      // as a duplicate: nothing translates our address on the way to the server.
      if (!complete) return { nat: 'unknown', udp: true };
      if (failed.size === 0 && !unattributed) return { nat: 'open', udp: true };
      // Blocked only if the requests failed on every local socket: one failing
      // interface (say IPv6) next to a working one says nothing.
      const everySocketFailed =
        !unattributed && hosts.size > 0 && [...hosts].every((h) => failed.has(h));
      return everySocketFailed ? { nat: 'unknown', udp: false } : { nat: 'unknown', udp: true };
    }
    if ([...mappedIps].some((ip) => hostIps.has(ip))) return { nat: 'open', udp: true };
    if (servers.length < 2) return { nat: 'unknown', udp: true };
    const failures = (socket: string) => failed.get(socket) ?? 0;
    // Two mappings of one socket: the NAT maps each destination separately.
    if (bySocket.size > 0) {
      if ([...bySocket.values()].some((m) => m.size > 1)) return { nat: 'symmetric', udp: true };
      // One mapping is a cone only if both servers answered that socket.
      const compared = [...bySocket.keys()].some((socket) => failures(socket) === 0);
      return { nat: compared && !unattributed ? 'cone' : 'unknown', udp: true };
    }
    // Mappings not tied to sockets: compare their number with the sockets that
    // got any answer (a socket every request failed on contributes none).
    const answered = [...hosts].filter((h) => failures(h) < servers.length).length;
    if (mapped.size > Math.max(1, answered)) return { nat: 'symmetric', udp: true };
    // A socket only one server answered can't show whether its mapping changes.
    const partly = [...hosts].some((h) => failures(h) > 0 && failures(h) < servers.length);
    return { nat: partly || unattributed ? 'unknown' : 'cone', udp: true };
  }
}

/**
 * probeNetwork with a cache: one probe serves the network check and host
 * election for `ttlMs`, as long as the STUN servers (the coordination server
 * we're on) stay the same.
 */
export function createNetworkProber(
  RTCPeerConnectionImpl: typeof RTCPeerConnection,
  stunUrls: () => string[],
  ttlMs = 10 * 60_000,
) {
  let cache: { at: number; servers: string; probe: Promise<NetworkProbe> } | undefined;
  return (fresh = false): Promise<NetworkProbe> => {
    const urls = stunUrls();
    const servers = urls.join(' ');
    if (fresh || !cache || cache.servers !== servers || Date.now() - cache.at > ttlMs) {
      cache = {
        at: Date.now(),
        servers,
        probe: probeNetwork(RTCPeerConnectionImpl, urls).catch((): NetworkProbe => ({
          nat: 'unknown',
          udp: true,
        })),
      };
    }
    return cache.probe;
  };
}

/** How well direct connections can work from here. */
export type NetworkVerdict = 'good' | 'limited' | 'blocked' | 'unknown';

export function networkVerdict(probe: NetworkProbe): NetworkVerdict {
  if (!probe.udp) return 'blocked';
  if (probe.nat === 'open' || probe.nat === 'cone') return 'good';
  if (probe.nat === 'symmetric') return 'limited';
  return 'unknown';
}

/** Browser-side capability hints for host election. */
export async function browserCapabilities(): Promise<Partial<HostCaps>> {
  const nav = globalThis.navigator as Navigator & {
    getBattery?: () => Promise<{ charging: boolean }>;
  };
  const caps: Partial<HostCaps> = {};
  if (nav?.hardwareConcurrency) caps.cpuCores = nav.hardwareConcurrency;
  try {
    const battery = await nav?.getBattery?.();
    if (battery) caps.onBattery = !battery.charging;
  } catch {
    /* not available */
  }
  return caps;
}

/** One line of the network check, as shown to the user. */
export interface NetworkCheckItem {
  id: 'udp' | 'ports' | 'address' | 'mapping' | 'ipv6';
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'unknown' | 'info';
  detail: string;
}

/** The network check as a checklist, and which checks decided the result. */
export function networkChecklist(probe: NetworkProbe): {
  items: NetworkCheckItem[];
  reason: string;
} {
  const d = probe.details;
  const port = (url: string) => url.match(/:(\d+)(?:\?|$)/)?.[1] ?? url;
  const answered = d?.servers.filter((s) => s.answered) ?? [];
  const silent = d?.servers.filter((s) => s.answered === false) ?? [];
  const items: NetworkCheckItem[] = [];

  items.push({
    id: 'udp',
    label: 'UDP reaches the coordination server',
    ...(!probe.udp
      ? {
          status: 'fail',
          detail:
            'No answer came back. Calls and chats travel over UDP, so nothing can connect directly; only the relay can help (if it is reachable).',
        }
      : d && !d.complete && answered.length === 0
        ? { status: 'unknown', detail: 'The server took too long to answer.' }
        : { status: 'ok', detail: 'Answers came back, so UDP traffic gets through.' }),
  });

  if (d && d.servers.length > 1) {
    items.push({
      id: 'ports',
      label: 'Both of the server’s test ports answered',
      ...(answered.length === d.servers.length
        ? {
            status: 'ok',
            detail: `Ports ${d.servers.map((s) => port(s.url)).join(' and ')} both answered, so the next check could compare them.`,
          }
        : silent.length
          ? {
              status: 'warn',
              detail: `Port ${silent.map((s) => port(s.url)).join(' and ')} didn't answer (a firewall may block it), so your router's behaviour couldn't be compared.`,
            }
          : { status: 'unknown', detail: "It couldn't be told which ports answered." }),
    });
  }

  items.push({
    id: 'address',
    label: 'Your public address',
    ...(probe.nat === 'open'
      ? {
          status: 'ok',
          detail:
            'Your device has a public address itself, with no router translating it: the easiest case for direct connections.',
        }
      : d?.publicIps.length
        ? {
            status: 'ok',
            detail: `The server sees you as ${d.publicIps.join(', ')}, behind a router that translates your address (normal at home and at work).`,
          }
        : { status: 'unknown', detail: 'The server could not tell your public address.' }),
  });

  items.push({
    id: 'mapping',
    label: 'Your router keeps one public port for every destination',
    ...(probe.nat === 'open' || probe.nat === 'cone'
      ? {
          status: 'ok',
          detail:
            'Both test ports saw the same public port, so people can reach the address the server sees.',
        }
      : probe.nat === 'symmetric'
        ? {
            status: 'warn',
            detail:
              "Each destination got a different public port (a 'symmetric' router, common on mobile hotspots and some office networks). You can still connect directly to people on open networks; between two networks like this, only the relay works.",
          }
        : {
            status: 'unknown',
            detail: "It couldn't be compared: it needs answers from both test ports.",
          }),
  });

  if (d) {
    items.push({
      id: 'ipv6',
      label: 'IPv6',
      status: 'info',
      detail: d.ipv6
        ? 'This device has an IPv6 address. With people who have one too, connections usually skip the router problems above.'
        : 'No IPv6 address. That is common, and only matters as a way around router problems.',
    });
  }

  const verdict = networkVerdict(probe);
  const reason = {
    good: 'Direct connections work: UDP gets through and your router keeps the same public port for every destination.',
    limited:
      'Limited, because your router changes the public port for each destination. Direct connections still work with most people; with someone whose network is limited too, they need the relay.',
    blocked:
      "Blocked, because the server's UDP test got no answer: nothing can connect directly from this network.",
    unknown:
      "Not decided: some checks couldn't be completed. If you can't reach someone, Crocodile tells you and offers the relay.",
  }[verdict];
  return { items, reason };
}
