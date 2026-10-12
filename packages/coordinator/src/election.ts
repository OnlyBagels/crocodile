import type { SessionMember } from '@crocodile/protocol';

/**
 * Host election. The host runs the session's relay, so we want the member
 * most likely to be reachable by everyone with bandwidth to spare: an open or
 * cone NAT, a desktop on mains power, fast uplink, low latency. A little
 * tenure bonus plus "keep the current host while it is healthy" avoid
 * flapping when a slightly better peer joins.
 *
 * One exception to keeping the host: a host behind a symmetric NAT gives way
 * to the best member whose NAT isn't symmetric (open, cone, or not fully
 * tested). Whoever starts a call or opens a channel first is elected while
 * alone, and members on other networks often can't reach a symmetric-NAT
 * host at all, while it can always reach them.
 */
const NAT_SCORE = { open: 40, cone: 25, unknown: 10, symmetric: 0 } as const;

export function isHostEligible(m: SessionMember): boolean {
  return m.caps.canHost && (m.caps.platform === 'desktop' || m.caps.platform === 'bot');
}

export function hostScore(m: SessionMember, now: number): number {
  if (!isHostEligible(m)) return Number.NEGATIVE_INFINITY;
  const c = m.caps;
  let score = NAT_SCORE[c.nat];
  if (c.uplinkKbps !== undefined) score += Math.min(30, Math.log2(1 + c.uplinkKbps / 500) * 10);
  else score += 10;
  score += Math.min(10, (c.cpuCores ?? 4) * 1.25);
  if (c.onBattery) score -= 15;
  if (c.rttMs !== undefined) score -= Math.min(15, c.rttMs / 20);
  score += Math.min(5, (now - m.joinedAt) / 60_000);
  return score;
}

export interface ElectionInput {
  members: SessionMember[];
  host: string | null;
  backup: string | null;
  /** peer id -> epoch ms until which the member may not host (failed as host recently). */
  penalties: Map<string, number>;
  now: number;
}

export function elect({ members, host, backup, penalties, now }: ElectionInput): {
  host: string | null;
  backup: string | null;
} {
  const available = (m: SessionMember) => isHostEligible(m) && (penalties.get(m.peer) ?? 0) <= now;
  const byId = new Map(members.map((m) => [m.peer, m]));
  const ranked = members
    .filter(available)
    .sort((a, b) => hostScore(b, now) - hostScore(a, now) || a.peer.localeCompare(b.peer));

  let nextHost: string | null = null;
  const current = host ? byId.get(host) : undefined;
  // A network check that couldn't finish ('unknown') is still a better bet
  // than a known symmetric NAT (a device with UDP blocked reports symmetric).
  const reachable = (m: SessionMember) => m.caps.nat !== 'symmetric';
  const betterReachable =
    current?.caps.nat === 'symmetric' ? ranked.find((m) => reachable(m)) : undefined;
  if (betterReachable) nextHost = betterReachable.peer;
  else if (current && available(current)) nextHost = current.peer;
  else {
    const standby = backup ? byId.get(backup) : undefined;
    if (standby && available(standby)) nextHost = standby.peer;
    else nextHost = ranked[0]?.peer ?? null;
  }
  // A penalty means "prefer someone else". With nobody else, keep (or take)
  // a penalised host: members who can't reach it directly may still get
  // through the relay, and nobody can without a host.
  if (!nextHost) {
    if (current && isHostEligible(current)) nextHost = current.peer;
    else
      nextHost =
        members
          .filter(isHostEligible)
          .sort((a, b) => hostScore(b, now) - hostScore(a, now) || a.peer.localeCompare(b.peer))[0]
          ?.peer ?? null;
  }

  // Keep the backup stable unless a clearly better candidate appears.
  const candidates = ranked.filter((m) => m.peer !== nextHost);
  let nextBackup: string | null = candidates[0]?.peer ?? null;
  const currentBackup = backup && backup !== nextHost ? byId.get(backup) : undefined;
  if (currentBackup && available(currentBackup) && candidates[0]) {
    if (hostScore(candidates[0], now) - hostScore(currentBackup, now) < 10)
      nextBackup = currentBackup.peer;
  }
  return { host: nextHost, backup: nextBackup };
}

/** Rendezvous (highest random weight) hashing: every server computes the same owner. */
export function rendezvousOwner(sessionId: string, serverIds: string[]): string {
  let best = '';
  let bestWeight = -1;
  for (const id of serverIds) {
    const w = fnv1a(`${id}|${sessionId}`);
    if (w > bestWeight || (w === bestWeight && id < best)) {
      best = id;
      bestWeight = w;
    }
  }
  return best;
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Final avalanche (murmur3 fmix32) so similar inputs spread well.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
