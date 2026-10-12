import type { SessionView } from '@crocodile/client-core';

/** Where a call we are in stands, as the user should read it. */
export type CallPhase = 'ringing' | 'connecting' | 'no-host' | 'reconnecting' | 'waiting' | 'live';

/**
 * A call is only live once it is connected and, in a DM, the other side is
 * in it too: ringing, connecting or waiting alone is not talking.
 */
export function callPhase(
  session: SessionView | undefined,
  opts: { ringing: boolean; liveSince: number | null },
): CallPhase {
  if (opts.ringing) return 'ringing';
  if (!session) return 'connecting';
  if (session.status === 'no-host') return 'no-host';
  if (session.status === 'reconnecting') return 'reconnecting';
  if (session.status !== 'connected') return 'connecting';
  return opts.liveSince ? 'live' : 'waiting';
}

/** "Ringing…", "4:05", "Waiting for Bob to join"… */
export function callStatusText(
  phase: CallPhase,
  opts: { liveSince: number | null; now: number; other?: string },
): string {
  switch (phase) {
    case 'ringing':
      return 'Ringing…';
    case 'connecting':
      return 'Connecting…';
    case 'no-host':
      return 'Waiting for a host';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'waiting':
      return opts.other ? `Waiting for ${opts.other} to join` : 'Waiting for others to join';
    case 'live':
      return clock(opts.now - (opts.liveSince ?? opts.now));
  }
}

/** "0:07", "12:40", "1:02:03". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** How a round trip to the host feels in conversation. */
export function latencyQuality(ms: number): 'good' | 'fair' | 'poor' {
  return ms < 100 ? 'good' : ms < 250 ? 'fair' : 'poor';
}

/** Theme colour classes for each quality. */
export const LATENCY_CLASS = {
  good: 'text-online',
  fair: 'text-warn',
  poor: 'text-danger',
} as const;

/**
 * Whether a DM shows its call stage: once we are in the call, or when the
 * other side is in it without us (to join). Not while it rings for us: the
 * incoming-call prompt is the one place to answer or decline.
 */
export function showDmCallStage(s: {
  joined: boolean;
  ringingIn: boolean;
  otherInCall: boolean;
}): boolean {
  return s.joined || (s.otherInCall && !s.ringingIn);
}
