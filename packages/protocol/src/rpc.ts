import { z } from 'zod';
import type { SignedRecord } from './records';
import { SignedRecordEnvelope } from './records';
import {
  HostCaps,
  PeerId,
  SessionId,
  type SessionState,
  type VoiceOccupancy,
  Platform,
} from './session';
import { DeviceId } from './records';
import type { PublicServerInfo } from './directory';
import { SealedBox } from './relay';
import { MailProof } from './federation';

/** Public identity of a coordination server. */
export const ServerInfo = z.object({
  /** base32(sha256(key))[:26] */
  id: z.string(),
  /** Ed25519 public key, base64url. */
  key: z.string(),
  name: z.string().max(64),
  /** Public base URL, e.g. https://croc.example.org or http://203.0.113.4:7443 */
  url: z.string().url(),
  version: z.string().max(32),
  region: z.string().max(32).optional(),
});
export type ServerInfo = z.infer<typeof ServerInfo>;

/** An email address, or an https:// page such as the server's privacy notice. */
export function isOperatorContact(value: string): boolean {
  if (value.length > 200 || /\s/.test(value)) return false;
  // Domain labels exclude '.', so the pattern can't backtrack.
  if (/^[^@:/]+@[^@:/.]+(?:\.[^@:/.]+)+$/.test(value)) return true;
  // The literal prefix: URL parsing would also accept forms like https:example.org.
  if (!value.startsWith('https://')) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Who runs a server and how to reach them, as its operator states it. Not
 * signed and not verified by anyone: the app shows it as the server's own
 * claim. Kept out of ServerInfo, whose signature older apps and directories
 * check without knowing about new fields.
 */
export const OperatorInfo = z.object({
  contact: z.string().refine(isOperatorContact, 'an email address or an https:// page'),
});
export type OperatorInfo = z.infer<typeof OperatorInfo>;

export const PresenceStatus = z.enum(['online', 'idle', 'dnd', 'offline']);
export type PresenceStatus = z.infer<typeof PresenceStatus>;

export interface PresenceEntry {
  userId: string;
  status: PresenceStatus;
  /** Custom status text. */
  text?: string;
}

// ---------------------------------------------------------------------------
// Handshake (WebSocket /v1/client)
// ---------------------------------------------------------------------------

/**
 * Fresh per-connection keys for the encrypted client↔server channel
 * (X25519 + ML-KEM-768, forward secret). With these, even plain ws:// to a
 * home-hosted server keeps metadata confidential.
 */
export interface ChannelOffer {
  x25519: string;
  mlkem: string;
}

export interface ServerHello {
  t: 'hello';
  server: ServerInfo;
  challenge: string;
  /** STUN URLs clients should use for ICE. */
  stun: string[];
  time: number;
  channel: ChannelOffer;
  /** Server signature over (challenge, server.id, time, channel). */
  sig: string;
  /**
   * Server signature over the whole hello (helloFullPayload). Clients use
   * the STUN servers and operator details only when it checks out; servers
   * from before it existed send none.
   */
  sigFull?: string;
  /** Optional services this server offers. */
  features?: { relay?: boolean; mailbox?: { ttlMs: number } };
  /** Who runs the server, if they say. */
  operator?: OperatorInfo;
}

/** What `sigFull` covers: everything in the hello but the signatures. */
export function helloFullPayload(h: Omit<ServerHello, 'sig' | 'sigFull'>) {
  return {
    challenge: h.challenge,
    server: h.server,
    time: h.time,
    channel: h.channel,
    stun: h.stun,
    features: h.features ?? null,
    operator: h.operator ?? null,
  };
}

/**
 * The client's answer to the hello. Only its half of the channel is in the clear; who it is
 * travels sealed under that channel (see `ClientAuthBody`), so that someone watching a plain
 * `ws://` connection learns neither the user nor the device.
 */
export const ClientAuth = z.object({
  t: z.literal('auth'),
  /** Client's half of the channel: ephemeral X25519 key and ML-KEM ciphertext. */
  channel: z.object({ epk: z.string().max(64), kem: z.string().max(2000) }),
  /** A `ClientAuthBody`, sealed with the channel's first frame. */
  sealed: z.object({ n: z.number().int().min(0).max(1000), c: z.string().max(8000) }),
});
export type ClientAuth = z.infer<typeof ClientAuth>;

export const ClientAuthBody = z.object({
  key: z.string(),
  device: DeviceId,
  /** Signature over (challenge, server.id, device, channel). */
  sig: z.string(),
  client: z.object({
    platform: Platform,
    version: z.string().max(32),
  }),
});
export type ClientAuthBody = z.infer<typeof ClientAuthBody>;

export interface AuthOk {
  t: 'auth_ok';
  userId: string;
  /** This connection's peer id (`<userId>.<deviceId>`). */
  peer: string;
}

/** An encrypted frame on an established channel. */
export interface SecureFrame {
  t: 'x';
  /** Strictly increasing per direction; part of the nonce. */
  n: number;
  c: string;
}

export interface RpcRequest {
  t: 'req';
  id: number;
  m: string;
  p: unknown;
}

export interface RpcError {
  code:
    | 'bad_request'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'rate_limited'
    | 'unavailable'
    | 'internal'
    /** Sent when a deleted account tries to sign in, with the marker as proof. */
    | 'account_deleted';
  message: string;
  /** For account_deleted: the signed deletion marker, which clients verify before acting. */
  record?: SignedRecord;
}

export interface RpcResponse {
  t: 'res';
  id: number;
  ok?: unknown;
  err?: RpcError;
}

export interface RpcEvent {
  t: 'ev';
  ev: keyof ServerEvents;
  d: unknown;
}

export type ServerFrame =
  ServerHello | AuthOk | RpcResponse | RpcEvent | { t: 'error'; err: RpcError };
export type ClientFrame = ClientAuth | RpcRequest;

/** Account seed sealed to a new device during linking (see link.* methods). */
export const LinkBox = z.object({
  epk: z.string().max(64),
  ct: z.string().max(4000),
  from: z.string(),
  sig: z.string(),
});
export type LinkBox = z.infer<typeof LinkBox>;

/** Short-lived TURN credentials for the opt-in server relay. */
export interface RelayGrant {
  urls: string[];
  username: string;
  credential: string;
  expiresAt: number;
  /** Server that issued the grant (display). */
  server: string;
}

// ---------------------------------------------------------------------------
// Signalling between a member and the session host's relay. Opaque to the
// coordination server apart from routing; SDP is signed by the sender's
// identity key so a malicious server cannot splice in its own DTLS endpoint.
// ---------------------------------------------------------------------------

export const SignalData = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('offer'),
    epoch: z.number().int(),
    sdp: z.string().max(64_000),
    key: z.string(),
    sig: z.string(),
  }),
  z.object({
    type: z.literal('answer'),
    epoch: z.number().int(),
    sdp: z.string().max(64_000),
    key: z.string(),
    sig: z.string(),
  }),
  z.object({
    type: z.literal('candidate'),
    epoch: z.number().int(),
    dir: z.enum(['toRelay', 'toClient']),
    candidate: z.object({
      candidate: z.string().max(1024),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().int().nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal('bye'),
    epoch: z.number().int(),
    dir: z.enum(['toRelay', 'toClient']),
  }),
]);
export type SignalData = z.infer<typeof SignalData>;

// ---------------------------------------------------------------------------
// RPC methods
// ---------------------------------------------------------------------------

const userId = z.string().regex(/^[a-z2-7]{8,64}$/);

export const RpcParams = {
  'records.put': z.object({ record: SignedRecordEnvelope }),
  'records.get': z.object({ keys: z.array(z.string().max(200)).max(500) }),
  'records.list': z.object({
    prefix: z.string().min(3).max(200),
    limit: z.number().int().min(1).max(5000).optional(),
    /** Continue after this key, when the previous answer said there is more. */
    after: z.string().max(200).optional(),
  }),
  'records.subscribe': z.object({ prefixes: z.array(z.string().min(3).max(200)).max(2000) }),
  'users.search': z.object({ query: z.string().min(1).max(64) }),
  'friends.incoming': z.object({}),
  'spaces.mine': z.object({}),
  'presence.subscribe': z.object({ userIds: z.array(userId).max(5000) }),
  'presence.set': z.object({
    status: z.enum(['online', 'idle', 'dnd', 'invisible']),
    text: z.string().max(128).optional(),
  }),
  'session.join': z.object({ sessionId: SessionId, caps: HostCaps }),
  'session.leave': z.object({ sessionId: SessionId }),
  'session.update': z.object({ sessionId: SessionId, caps: HostCaps }),
  'session.report': z.object({
    sessionId: SessionId,
    epoch: z.number().int(),
    issue: z.enum(['host_unreachable']),
  }),
  'voice.watch': z.object({ spaceIds: z.array(userId).max(200) }),
  'signal.send': z.object({ to: PeerId, sessionId: SessionId, data: SignalData }),
  'servers.list': z.object({}),
  /** New device: get a short code to show; the existing device enters it. */
  'link.open': z.object({ encKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  /** Existing device: look up the new device behind a code. */
  'link.claim': z.object({ code: z.string().min(6).max(16) }),
  /** Existing device: deliver the sealed account seed. */
  'link.send': z.object({ code: z.string().min(6).max(16), box: LinkBox }),
  /** Opt-in relay through this coordination server (TURN), max one hour. */
  'relay.request': z.object({ sessionId: SessionId }),
  'relay.release': z.object({}),
  /**
   * Opt-in mailbox: hold boxes sealed to offline devices until they connect
   * or the server's TTL passes. The server only sees ciphertext.
   */
  'mail.put': z.object({
    items: z
      .array(z.object({ to: PeerId, box: SealedBox }))
      .min(1)
      .max(20),
  }),
  /** Recipient: deliver mail held for this device anywhere in the mesh. */
  /** `proof` lets other servers send their mail for this device here (MailProof). */
  'mail.fetch': z.object({ proof: MailProof.optional() }),
  /** Recipient: these mailbox items arrived; delete them everywhere (with `proof`). */
  'mail.ack': z.object({
    ids: z.array(z.string().max(40)).min(1).max(500),
    proof: MailProof.optional(),
  }),
} as const;

export interface RpcMethods {
  'records.put': { accepted: boolean; current: SignedRecord | null; reason?: string };
  /**
   * `more`: the answer was cut to fit one frame; ask again for the keys from index `next` on.
   * Keys before it were answered, or have no record to give.
   */
  'records.get': { records: SignedRecord[]; more?: boolean; next?: number };
  /**
   * `more`: there are records after these. Ask again with `after` the last key returned, or `next`
   * if given (a page that held nothing to return).
   */
  'records.list': { records: SignedRecord[]; more?: boolean; next?: string };
  'records.subscribe': Record<string, never>;
  'users.search': { profiles: SignedRecord<'profile'>[] };
  'friends.incoming': { records: SignedRecord<'friends'>[] };
  'spaces.mine': { spaces: SignedRecord<'space'>[]; members: SignedRecord<'member'>[] };
  'presence.subscribe': { presence: PresenceEntry[] };
  'presence.set': Record<string, never>;
  'session.join': { state: SessionState };
  'session.leave': Record<string, never>;
  'session.update': Record<string, never>;
  'session.report': Record<string, never>;
  'voice.watch': { voice: VoiceOccupancy[] };
  'signal.send': { delivered: boolean };
  'servers.list': { servers: PublicServerInfo[] };
  'link.open': { code: string; expiresAt: number };
  'link.claim': { peer: string; key: string; encKey: string };
  'link.send': Record<string, never>;
  'relay.request': { grant: RelayGrant };
  'relay.release': Record<string, never>;
  'mail.put': { ids: string[]; expiresAt: number };
  'mail.fetch': Record<string, never>;
  'mail.ack': Record<string, never>;
}

/** A mailbox item on its way to the recipient device. */
export interface MailItem {
  id: string;
  /** Sender user id (as authenticated by the depositing server). */
  from: string;
  box: SealedBox;
  createdAt: number;
}

export type RpcMethod = keyof RpcMethods;
export type RpcParamsOf<M extends RpcMethod> = z.input<(typeof RpcParams)[M]>;

export interface ServerEvents {
  record: { record: SignedRecord };
  presence: PresenceEntry;
  session: { state: SessionState };
  /** The session no longer includes you (kicked, space left, or server moved it). */
  session_closed: { sessionId: string; reason: string };
  /** `from` is a peer id. */
  signal: { from: string; sessionId: string; data: SignalData };
  voice: VoiceOccupancy;
  /** Someone opened a direct conversation with you; join it to talk. */
  session_invite: { sessionId: string; from: string };
  /** Another connection authenticated as the same device. */
  replaced: { reason: string };
  /** Linking: an existing device claimed our code (compare the security code!). */
  link_claimed: { key: string; userId: string };
  /** Linking: the sealed account seed. */
  link_payload: { box: LinkBox };
  /** The relay grant ran out; the relayed connection will stop. */
  relay_expired: { reason: string };
  /** Mailbox items held for this device while it was offline. Ack with mail.ack. */
  mail: { items: MailItem[] };
}
