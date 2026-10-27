import { z } from 'zod';
import {
  HostCaps,
  LIMITS,
  PeerId,
  SealedBox,
  SessionId,
  SignalData,
  parseSessionId,
  type FedRoute,
} from '@crocodile/protocol';
import type { Coordinator } from './coordinator';

const id = z.string().max(200);

const SessionStateSchema = z.object({
  id: SessionId,
  epoch: z.number().int(),
  host: PeerId.nullable(),
  backup: PeerId.nullable(),
  members: z
    .array(z.object({ peer: PeerId, userId: id, joinedAt: z.number(), caps: HostCaps }))
    .max(LIMITS.sessionMembersMax),
  relaySlots: z.number().int().min(0).max(1000),
  updatedAt: z.number(),
});

/**
 * What each event a server may route to our clients must look like. Linking
 * has its own checks (codes, the commit and the security code), so its events
 * only need to be objects here.
 */
const ROUTED = {
  session: z.object({ state: SessionStateSchema }),
  signal: z.object({ from: PeerId, sessionId: SessionId, data: SignalData }),
  session_invite: z.object({ sessionId: SessionId, from: id }),
  link_claimed: z.looseObject({}),
  link_payload: z.looseObject({}),
  mail: z.object({
    items: z
      .array(z.object({ id: z.string().max(40), from: id, box: SealedBox, createdAt: z.number() }))
      .max(500),
  }),
  relay_expired: z.object({ reason: z.string().max(500) }),
} as const;

/**
 * A client event another server asks us to deliver. It is delivered only if
 * it has the shape of its event and the server could be the one sending it:
 * a signal only from the server that has the sending device connected, a
 * conversation invitation and a session's state only from the server that owns
 * the session. Returns what to deliver, or undefined to drop it.
 */
export function routedEvent(hub: Coordinator, from: string, frame: FedRoute): unknown {
  const schema = ROUTED[frame.ev as keyof typeof ROUTED];
  const parsed = schema?.safeParse(frame.d);
  if (!parsed?.success) return undefined;
  const d = parsed.data as Record<string, unknown>;
  switch (frame.ev) {
    case 'session':
      if (hub.sessions.ownerOf((d.state as { id: string }).id) !== from) return undefined;
      break;
    case 'signal':
      if (!hub.presence.hosts(from, d.from as string)) return undefined;
      break;
    case 'session_invite': {
      const scope = parseSessionId(d.sessionId as string);
      if (
        scope?.kind !== 'dm' ||
        !scope.users.includes(d.from as string) ||
        !scope.users.includes(frame.to) ||
        d.from === frame.to ||
        hub.sessions.ownerOf(d.sessionId as string) !== from
      )
        return undefined;
      break;
    }
    case 'relay_expired':
      if (!hub.presence.hosts(from, frame.to)) return undefined;
      break;
  }
  return d;
}
