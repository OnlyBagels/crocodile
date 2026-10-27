import { z } from 'zod';
import { LIMITS } from './constants';
import type { SignedRecord } from './records';
import type { ServerInfo } from './rpc';
import { HostCaps, PeerId, SessionId, type VoiceOccupancy } from './session';

/**
 * Server-to-server protocol (WebSocket /v1/federation). Servers keep a few
 * overlay links and open direct ones as needed; records live on a few owner
 * servers each (docs/MESH.md). Owners copy records to each other, with
 * per-server sequence cursors to catch up; what every server needs to hear is
 * flooded through the overlay.
 */
export interface FedHello {
  t: 'fed_hello';
  server: ServerInfo;
  challenge: string;
  /** Fresh hybrid key-exchange offer for the encrypted link. */
  channel: { x25519: string; mlkem: string };
  /** PROTOCOL_VERSION of the sender; absent before 2. */
  protocol?: number;
}

/** "I'm alive", flooded every few seconds. Signed, so it can travel through others. */
export interface FedBeacon {
  t: 'beacon';
  server: ServerInfo;
  /** Increases with every beacon (a timestamp). */
  seq: number;
  /** The sender keeps a copy of every record. */
  full: boolean;
  /**
   * Sequence number of the sender's latest presence news: a server that has
   * seen less missed some, and fetches the sender's full presence.
   */
  presence?: number;
  /** Ed25519 by the server key over { server, seq, full, presence }. */
  sig: string;
}

/** A frame for every server, passed on by each to its other links. */
export interface FedFlood {
  t: 'flood';
  /** Unique; a server passes each id on once. */
  id: string;
  /** The server it came from. */
  origin: string;
  hops: number;
  f: FedLinkQuery | FedLinkAnswer | FedMailQuery | FedMailAck;
}

/** A request to one server; answered with FedResponse. */
export interface FedRequest {
  t: 'req';
  rid: string;
  m:
    | 'rec_put'
    | 'rec_get'
    | 'rec_list'
    | 'rec_term'
    | 'rec_store'
    | 'watch'
    | 'digest'
    | 'digest_keys'
    | 'presence_state';
  p: unknown;
}

/** Parameters of each FedRequest method; servers check them like client input. */
export const FedRequestParams = {
  /** A client's new record, for an owner of its home shard to check (fresh) and store. */
  rec_put: z.object({ record: z.unknown() }),
  rec_get: z.object({ keys: z.array(z.string().max(200)).max(1000) }),
  rec_list: z.object({
    prefix: z.string().min(3).max(200),
    limit: z.number().int().min(1).max(5000).optional(),
  }),
  rec_term: z.object({
    term: z.string().min(3).max(300),
    limit: z.number().int().min(1).max(5000).optional(),
  }),
  /** Records the receiver should store as an owner; answered once applied. */
  rec_store: z.object({ records: z.array(z.unknown()).max(200) }),
  /** The receiver's full presence (FedPresence with full: true). */
  presence_state: z.object({}),
  /** Push changes to these shards (records whose key starts with prefix) for ttlMs. */
  watch: z.object({
    items: z
      .array(z.object({ shard: z.string().min(3).max(300), prefix: z.string().max(200) }))
      .max(5000),
    ttlMs: z
      .number()
      .int()
      .min(1000)
      .max(15 * 60_000),
  }),
  /**
   * Repair: 256 bucket sums over the records both servers own; the answer
   * lists the buckets that differ.
   */
  digest: z.object({ buckets: z.array(z.number().int().min(0)).length(256) }),
  /** Repair: (key, version) of the records both own, in these buckets. */
  digest_keys: z.object({ buckets: z.array(z.number().int().min(0).max(255)).max(256) }),
} as const;

export interface FedResponse {
  t: 'res';
  rid: string;
  ok?: unknown;
  err?: { code: string; message: string };
}

/** A record a watching server asked to hear about; not for storing. */
export interface FedRecordPush {
  t: 'rec_push';
  record: SignedRecord;
}

export interface FedAuth {
  t: 'fed_auth';
  /** Our answer to the peer's channel offer. */
  answer: { epk: string; kem: string };
  /** Signature over (peer challenge, own id, peer id, own offer, answer). */
  sig: string;
  /** Highest seq of the peer's log that we have already applied. */
  cursor: number;
}

/** Device linking: find which server holds a link code. */
export interface FedLinkQuery {
  t: 'link_query';
  qid: string;
  code: string;
  /** The claiming device, the only one the new device may reveal its nonce to. */
  by?: string;
}

export interface FedLinkAnswer {
  t: 'link_answer';
  qid: string;
  found?: { peer: string; key: string; encKey: string; kemKey: string; commit: string };
}

/**
 * A device's signature on a mailbox request, so servers other than its own
 * act on it only for that device: `key` is the device user's Ed25519 key,
 * `sig` covers the request (see mailProofPayload) and `at`, its time.
 */
export const MailProof = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  at: z.number().int(),
  sig: z.string().max(200),
});
export type MailProof = z.infer<typeof MailProof>;

/** What a MailProof signs: the request, and where it may be answered. */
export function mailProofPayload(
  req:
    | { t: 'mail_fetch'; peer: string; server: string }
    | { t: 'mail_ack'; peer: string; ids: string[] },
  at: number,
) {
  return { ...req, at };
}

/** Mailbox: a device connected here; servers holding mail for it send it over. */
export interface FedMailQuery {
  t: 'mail_query';
  peer: string;
  /** Signed by the device for the origin server. Without one, only its own server answers. */
  proof?: MailProof;
}

/** Mailbox: the device received these items; everyone may delete them. */
export interface FedMailAck {
  t: 'mail_ack';
  peer: string;
  ids: string[];
  /** Signed by the device; other servers delete nothing without it. */
  proof?: MailProof;
}

export interface FedRecords {
  t: 'records';
  items: { seq: number; record: SignedRecord }[];
  /** Sender's latest seq covered by this batch. */
  upTo: number;
}

export interface FedPresence {
  t: 'presence';
  /** The server these users are connected to. */
  origin: string;
  /** Increases with every update from the origin; older ones are ignored. */
  seq: number;
  /** true: replace everything known about the origin's users. */
  full: boolean;
  /**
   * Status of users connected to the sender. 'invisible' users still need to be
   * routable, so the mesh knows them, but clients are shown 'offline'.
   */
  entries: {
    userId: string;
    status: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
    text?: string;
    since: number;
    /** Device ids of the user connected to the sender. */
    devices: string[];
  }[];
  /** The origin's public key; its hash is `origin`. */
  key: string;
  /** The origin's signature (SIG_DOMAIN.presence over `presenceSigned`). */
  sig: string;
}

/** Deliver a client event to a user connected to the receiving server. */
export interface FedRoute {
  t: 'route';
  /** A user id (all their devices on the receiver) or a peer id (one device). */
  to: string;
  ev: string;
  d: unknown;
}

export type SessionOp =
  | {
      op: 'join';
      caps: HostCaps;
      /** Last state the member's server saw; lets a new owner keep the same host. */
      hint?: { epoch: number; host: string | null; backup: string | null };
    }
  | { op: 'update'; caps: HostCaps }
  | { op: 'leave' }
  | { op: 'report'; epoch: number; issue: 'host_unreachable' };

/** A session operation forwarded to the server that owns the session. */
export interface FedSessionOp {
  t: 'session_op';
  opId: string;
  sessionId: string;
  /** Peer id of the member. */
  peer: string;
  op: SessionOp;
}

export interface FedSessionOpResult {
  t: 'session_op_res';
  opId: string;
  ok?: unknown;
  err?: { code: string; message: string };
}

/** Known-server gossip so meshes converge even if the directory is down. */
export interface FedServers {
  t: 'servers';
  servers: ServerInfo[];
}

/** Voice channel occupancy announced by the session owner to every server. */
export interface FedVoice {
  t: 'voice';
  sessionId: string;
  occ: VoiceOccupancy;
  /** The session's owner. */
  owner: string;
  /** When the owner announced it; the latest per session wins. */
  at: number;
  /** The owner's public key; its hash is `owner`. */
  key: string;
  /** The owner's signature (SIG_DOMAIN.voice over `voiceSigned`). */
  sig: string;
}

/** What the origin server signs in a presence frame (SIG_DOMAIN.presence). */
export function presenceSigned(f: Pick<FedPresence, 'origin' | 'seq' | 'full' | 'entries'>) {
  return { origin: f.origin, seq: f.seq, full: f.full, entries: f.entries };
}

/** What the owner signs in a voice frame (SIG_DOMAIN.voice). */
export function voiceSigned(f: Pick<FedVoice, 'sessionId' | 'occ' | 'owner' | 'at'>) {
  return { sessionId: f.sessionId, occ: f.occ, owner: f.owner, at: f.at };
}

/** Client events another server may route to our clients (FedRoute.ev). */
export const ROUTED_EVENTS = [
  'session',
  'signal',
  'session_invite',
  'link_claimed',
  'link_reveal',
  'link_payload',
  'mail',
  'relay_expired',
] as const;

const str = (max: number) => z.string().max(max);
const id = str(200);
const anyJson = z.unknown();

const FloodBody = z.discriminatedUnion('t', [
  z.object({ t: z.literal('link_query'), qid: id, code: str(32), by: PeerId.optional() }),
  z.object({
    t: z.literal('link_answer'),
    qid: id,
    found: z
      .object({ peer: PeerId, key: str(64), encKey: str(64), kemKey: str(1600), commit: str(64) })
      .optional(),
  }),
  z.object({ t: z.literal('mail_query'), peer: PeerId, proof: MailProof.optional() }),
  z.object({
    t: z.literal('mail_ack'),
    peer: PeerId,
    ids: z.array(str(40)).max(500),
    proof: MailProof.optional(),
  }),
]);

const PresenceEntry = z.object({
  userId: id,
  status: z.enum(['online', 'idle', 'dnd', 'invisible', 'offline']),
  text: str(128).optional(),
  since: z.number(),
  devices: z.array(id).max(100),
});

const VoiceOccupancySchema = z.object({
  spaceId: id,
  channelId: id,
  members: z.array(id).max(LIMITS.sessionMembersMax),
  host: id.nullable(),
});

const SessionOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('join'),
    caps: HostCaps,
    hint: z
      .object({ epoch: z.number().int(), host: id.nullable(), backup: id.nullable() })
      .optional(),
  }),
  z.object({ op: z.literal('update'), caps: HostCaps }),
  z.object({ op: z.literal('leave') }),
  z.object({
    op: z.literal('report'),
    epoch: z.number().int(),
    issue: z.literal('host_unreachable'),
  }),
]);

const errorBody = z.object({ code: str(64), message: str(2000) }).optional();

/**
 * Every frame a server accepts from another, checked like client input
 * before it is acted on. Records and request parameters are checked again
 * where they are used (validateRecord, FedRequestParams).
 */
export const FedFrameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('fed_hello'),
    // Checked (ServerInfo) where used; left as sent so signatures still verify.
    server: anyJson,
    challenge: str(200),
    channel: z.object({ x25519: str(100), mlkem: str(4000) }),
    protocol: z.number().int().optional(),
  }),
  z.object({
    t: z.literal('fed_auth'),
    answer: z.object({ epk: str(100), kem: str(4000) }),
    sig: str(200),
    cursor: z.number().int().min(0),
  }),
  z.object({
    t: z.literal('beacon'),
    // Checked (ServerInfo) where used; left as sent so signatures still verify.
    server: anyJson,
    seq: z.number(),
    full: z.boolean(),
    presence: z.number().optional(),
    sig: str(200),
  }),
  z.object({
    t: z.literal('flood'),
    id: str(64),
    origin: id,
    hops: z.number().int().min(0).max(64),
    f: FloodBody,
  }),
  z.object({
    t: z.literal('req'),
    rid: str(64),
    m: z.enum([
      'rec_put',
      'rec_get',
      'rec_list',
      'rec_term',
      'rec_store',
      'watch',
      'digest',
      'digest_keys',
      'presence_state',
    ]),
    p: anyJson,
  }),
  z.object({ t: z.literal('res'), rid: str(64), ok: anyJson.optional(), err: errorBody }),
  z.object({ t: z.literal('rec_push'), record: anyJson }),
  z.object({
    t: z.literal('records'),
    items: z.array(z.object({ seq: z.number().int(), record: anyJson })).max(1000),
    upTo: z.number().int(),
  }),
  z.object({
    t: z.literal('presence'),
    origin: id,
    seq: z.number(),
    full: z.boolean(),
    entries: z.array(PresenceEntry).max(100_000),
    key: str(64),
    sig: str(200),
  }),
  z.object({ t: z.literal('route'), to: str(200), ev: z.enum(ROUTED_EVENTS), d: anyJson }),
  z.object({
    t: z.literal('session_op'),
    opId: str(64),
    sessionId: SessionId,
    peer: PeerId,
    op: SessionOpSchema,
  }),
  z.object({
    t: z.literal('session_op_res'),
    opId: str(64),
    ok: anyJson.optional(),
    err: errorBody,
  }),
  z.object({ t: z.literal('servers'), servers: z.array(anyJson).max(5000) }),
  z.object({
    t: z.literal('voice'),
    sessionId: SessionId,
    occ: VoiceOccupancySchema,
    owner: id,
    at: z.number(),
    key: str(64),
    sig: str(200),
  }),
  // Sent directly as well as flooded.
  ...FloodBody.options,
  z.object({ t: z.literal('x'), n: z.number().int(), c: z.string() }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('pong') }),
]);

export type FedFrame =
  | FedHello
  | FedAuth
  | FedBeacon
  | FedFlood
  | FedRequest
  | FedResponse
  | FedRecordPush
  | FedRecords
  | FedPresence
  | FedRoute
  | FedSessionOp
  | FedSessionOpResult
  | FedServers
  | FedVoice
  | FedLinkQuery
  | FedLinkAnswer
  | FedMailQuery
  | FedMailAck
  | { t: 'x'; n: number; c: string }
  | { t: 'ping' }
  | { t: 'pong' };
