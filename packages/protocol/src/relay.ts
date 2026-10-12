import { z } from 'zod';

/**
 * Messages on the reliable data channel between a member and the host relay.
 * The relay only routes: payloads (`d`) are end-to-end encrypted envelopes it
 * cannot read. The relay stamps `from` with the identity proven during the
 * signed offer/answer exchange.
 */
export const RELAY_CHANNEL_LABEL = 'croc';
export const RELAY_CHANNEL_ID = 0;

const userId = z.string().regex(/^[a-z2-7]{8,64}$/);
const peerId = z.string().regex(/^[a-z2-7]{8,64}\.[a-z2-7]{8,32}$/);

export const ClientToRelay = z.discriminatedUnion('t', [
  z.object({ t: z.literal('bcast'), d: z.unknown() }),
  z.object({ t: z.literal('direct'), to: peerId, d: z.unknown() }),
  z.object({ t: z.literal('ping'), ts: z.number() }),
  /**
   * Client-side state: mute (so the relay can skip forwarding and show icons),
   * whether this member is in the call (a DM's text session isn't), and its
   * round trip to the host, for everyone's latency display.
   */
  z.object({
    t: z.literal('state'),
    muted: z.boolean(),
    deafened: z.boolean(),
    voice: z.boolean().optional(),
    rtt: z.number().int().min(0).max(60_000).optional(),
  }),
]);
export type ClientToRelay = z.infer<typeof ClientToRelay>;

export interface PeerState {
  /** Peer id: `<userId>.<deviceId>`. */
  id: string;
  muted: boolean;
  deafened: boolean;
  /** In the call (audio), not just in the conversation. Absent from older apps. */
  voice?: boolean;
  /** This member's last measured round trip to the host, in ms. */
  rtt?: number;
}

export type RelayToClient =
  | { t: 'hello'; you: string; host: string; peers: PeerState[]; slots: number }
  | { t: 'peer_join'; peer: PeerState }
  | { t: 'peer_leave'; peer: string }
  | { t: 'peer_state'; peer: PeerState }
  | { t: 'msg'; from: string; direct: boolean; d: unknown }
  /** Which speaker currently occupies each of this listener's audio slots. */
  | { t: 'slots'; map: (string | null)[] }
  | { t: 'speaking'; users: string[] }
  | { t: 'pong'; ts: number };

// ---------------------------------------------------------------------------
// End-to-end envelopes carried inside relay messages (`d`).
// ---------------------------------------------------------------------------

/**
 * Hybrid post-quantum sealed box to one device: X25519 + ML-KEM-768 against
 * the device's current prekey, HKDF-SHA256, AES-256-GCM, signed by the sender.
 */
export const SealedBox = z.object({
  v: z.literal(2),
  /** Recipient peer id. */
  to: peerId,
  /** Recipient prekey id. */
  pk: z.number().int().min(0).max(0xffffffff),
  /** Ephemeral X25519 public key. */
  epk: z.string(),
  /** ML-KEM-768 ciphertext. */
  kem: z.string(),
  ct: z.string(),
  /** Sender's Ed25519 identity key. */
  from: z.string(),
  /** Sender's device id. */
  fromDevice: z.string().regex(/^[a-z2-7]{8,32}$/),
  sig: z.string(),
});
export type SealedBox = z.infer<typeof SealedBox>;

export const E2EEnvelope = z.discriminatedUnion('k', [
  /** Pairwise-sealed payload: sender keys, history sync. */
  z.object({ k: z.literal('sealed'), box: SealedBox }),
  /** Group message: key id + ratchet generation of the sender's text chain. */
  z.object({
    k: z.literal('group'),
    kid: z.number().int().min(0).max(0xffffffff),
    g: z.number().int().min(0),
    ct: z.string(),
  }),
]);
export type E2EEnvelope = z.infer<typeof E2EEnvelope>;

/** A chat message. Signed by its author so history can be re-shared verifiably. */
export const ChatMessage = z.object({
  id: z.string().min(10).max(40),
  /** Channel id, or the DM session id for direct messages. */
  ch: z.string().max(200),
  author: userId,
  /** Author's Ed25519 key; userId must equal hash(key). */
  key: z.string(),
  ts: z.number().int(),
  body: z.string().max(4000),
  replyTo: z.string().max(40).optional(),
  /** Set on edits: id of the message being replaced. */
  edits: z.string().max(40).optional(),
  deleted: z.boolean().optional(),
  sig: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** Plaintext of a sealed envelope. */
export const SealedPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sender_key'),
    /** Session the key belongs to; guards against cross-session replay. */
    sessionId: z.string(),
    kid: z.number().int().min(0).max(0xffffffff),
    /** Current state of the sender's ratcheting chains (never earlier ones). */
    text: z.object({ gen: z.number().int().min(0), key: z.string() }),
    audio: z.object({ gen: z.number().int().min(0), key: z.string() }),
  }),
  z.object({
    type: z.literal('history_req'),
    /** channelId -> newest timestamp the requester already has. */
    since: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal('history'),
    messages: z.array(ChatMessage).max(500),
    done: z.boolean(),
  }),
  z.object({ type: z.literal('message'), message: ChatMessage }),
  /** Outbox delivery confirmations: the sender may forget these message ids. */
  z.object({ type: z.literal('ack'), ids: z.array(z.string().max(40)).max(500) }),
  /** Messages delivered through a server mailbox while the recipient was offline. */
  z.object({ type: z.literal('mail'), messages: z.array(ChatMessage).max(50) }),
]);
export type SealedPayload = z.infer<typeof SealedPayload>;

/** Plaintext of a group envelope. */
export const GroupPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: ChatMessage }),
  z.object({ type: z.literal('typing'), ch: z.string().max(200) }),
  /** Direct-call signalling inside a DM session. */
  z.object({ type: z.literal('call'), action: z.enum(['ring', 'accept', 'decline', 'end']) }),
]);
export type GroupPayload = z.infer<typeof GroupPayload>;
