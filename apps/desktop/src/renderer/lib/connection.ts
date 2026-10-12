import type { ConnectAttempt, FailStage, SessionView } from '@crocodile/client-core';
import type { NatType } from '@crocodile/protocol';
import { ROUTE_TEXT } from './network';

/** The steps of connecting to a session's host, in order, as the user reads them. */
export const STEPS = [
  { step: 'offer', label: 'Asked the host to connect, through the coordination server' },
  { step: 'answer', label: 'The host answered' },
  { step: 'path', label: 'Found a network path' },
  { step: 'open', label: 'Opened the encrypted channel' },
] as const;

/** Why a connection attempt failed, and what may help. */
export const STAGE_TEXT: Record<FailStage, { title: string; detail: string }> = {
  'no-answer': {
    title: "The host didn't answer",
    detail:
      'The request reached the coordination server but no answer came back. The host may have just gone offline or switched servers; Crocodile keeps trying, and picks another host if this one stays silent.',
  },
  'no-path': {
    title: 'No network path worked',
    detail:
      'You and the host both tried every address you have, and none got through: the networks on both sides block it. The relay gets around this.',
  },
  'no-channel': {
    title: "Connected, but the encrypted channel didn't open",
    detail:
      'A network path worked but the secure channel on top of it never came up. This is rare; trying again usually helps.',
  },
  lost: {
    title: 'The connection was lost',
    detail:
      "It worked, then the other side stopped answering: a network change (Wi-Fi, VPN, sleep) or the host's app closing. Crocodile reconnects by itself.",
  },
  'host-left': {
    title: 'The host closed the connection',
    detail: 'The host left or handed over to someone else. Crocodile connects to the new host.',
  },
  superseded: {
    title: 'Stopped: the session moved on',
    detail:
      'Another host took over, or the conversation was closed, before this attempt finished. Nothing went wrong.',
  },
  rejected: {
    title: "The host's answer didn't check out",
    detail:
      "Its signature didn't match the host's identity, so Crocodile refused it. If this keeps happening, report it.",
  },
};

/** A member's network type as election sees it, in the network check's words. */
export const NAT_TEXT: Record<NatType, string> = {
  open: 'open',
  cone: 'direct connections work',
  symmetric: 'limited',
  unknown: 'not fully tested',
};

/** "2 min", "45 s", "1 h 5 min". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A one-line account of an attempt: "Connected", "Failed: no network path worked", … */
export function attemptSummary(a: ConnectAttempt): string {
  if (!a.end) return 'Trying…';
  if (a.end.ok) return 'Connected';
  const opened = a.steps.find((s) => s.step === 'open');
  if (a.end.stage === 'lost' && opened)
    return `Worked for ${duration(a.end.at - opened.at)}, then was lost`;
  return STAGE_TEXT[a.end.stage].title;
}

/**
 * How a DM with someone stands, for the conversation list. Presence only
 * says they are online; whether a connection works is the session's to say.
 */
export function dmStatusLabel(online: boolean, session: SessionView | undefined): string {
  if (!online) return 'Offline · delivers when online';
  if (!session) return 'Online';
  if (session.status === 'connected' && session.iAmHost)
    // Our route is to our own relay; theirs we don't see.
    return session.peers.length > 0 ? 'Online · connected' : 'Online';
  if (session.status === 'connected')
    return session.route ? `Online · ${ROUTE_TEXT[session.route]}` : 'Online · connected';
  if (session.trouble) return "Online · can't connect directly";
  if (session.status === 'connecting' || session.status === 'joining')
    return 'Online · connecting…';
  if (session.status === 'reconnecting') return 'Online · reconnecting…';
  return 'Online';
}
