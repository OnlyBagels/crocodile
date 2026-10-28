import { z } from 'zod';
import { FileId, FileManifest } from './files';

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

/** What a member can show: their camera, or a screen (with its sound, maybe). */
export type MediaKind = 'camera' | 'screen';
/** A member's camera or screen: `<peer id>:camera` or `<peer id>:screen`. */
export const StreamId = z.string().regex(/^[a-z2-7]{8,64}\.[a-z2-7]{8,32}:(camera|screen)$/);
export const streamIds = {
  make: (peer: string, kind: MediaKind) => `${peer}:${kind}`,
  peer: (stream: string) => stream.slice(0, stream.lastIndexOf(':')),
  kind: (stream: string) => stream.slice(stream.lastIndexOf(':') + 1) as MediaKind,
};

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
    /** Showing a camera. */
    camera: z.boolean().optional(),
    /** Sharing a screen, and whether its sound comes with it. */
    screen: z.object({ audio: z.boolean() }).optional(),
  }),
  /**
   * Adding video to the connection: a new offer for the same connection,
   * sent once the host said it can carry video (`hello.media`). It travels
   * on the encrypted channel, so it needs no signature of its own.
   */
  z.object({ t: z.literal('renegotiate'), sdp: z.string().max(100_000) }),
  /** The cameras and screens this member wants, most wanted first. */
  z.object({ t: z.literal('watch'), streams: z.array(StreamId).max(32) }),
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
  camera?: boolean;
  screen?: { audio: boolean };
}

export type RelayToClient =
  | {
      t: 'hello';
      you: string;
      host: string;
      peers: PeerState[];
      slots: number;
      /** The host can carry video: slots for cameras and screens, and for screens' sound. */
      media?: { video: number; audio: number };
    }
  /** The host's answer to `renegotiate`. */
  | { t: 'answer'; sdp: string }
  /**
   * Which stream each of this member's video slots and screen-sound slots
   * carries now, and the streams it asked for that the host can't send at
   * the moment (its connection, or this member's, is full).
   */
  | { t: 'media'; video: (string | null)[]; audio: (string | null)[]; paused: string[] }
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
  v: z.literal(3),
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
  /**
   * Session the message was written for. Channel ids are only unique within
   * a space, so a space's messages name it; a direct message leaves this out
   * because its `ch` is already the session id.
   */
  sid: z.string().max(200).optional(),
  author: userId,
  /** Author's Ed25519 key; userId must equal hash(key). */
  key: z.string(),
  ts: z.number().int(),
  body: z.string().max(4000),
  replyTo: z.string().max(40).optional(),
  /** Set on edits: id of the message being replaced. */
  edits: z.string().max(40).optional(),
  deleted: z.boolean().optional(),
  /** A file posted with the message (the body is its caption). */
  file: FileManifest.optional(),
  sig: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** The session a message belongs to: the space's, or for a direct message its own `ch`. */
export const messageSession = (m: Pick<ChatMessage, 'ch' | 'sid'>): string => m.sid ?? m.ch;

/** Plaintext of a sealed envelope. */
export const SealedPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sender_key'),
    /** Session the key belongs to; guards against cross-session replay. */
    sessionId: z.string(),
    /** Device the key is for: a key sealed to one device is no use to another. */
    to: peerId,
    /** When it was sealed (ms). Keys are taken in the order they were made, and not long after. */
    at: z.number().int().min(0),
    kid: z.number().int().min(0).max(0xffffffff),
    /** Current state of the sender's ratcheting chains (never earlier ones). */
    text: z.object({ gen: z.number().int().min(0), key: z.string() }),
    audio: z.object({ gen: z.number().int().min(0), key: z.string() }),
    /** The sender holds no key of the receiver's (it let go of it), and asks for it. */
    want: z.boolean().optional(),
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
  /** Answer to `file_want`: this device has the whole file and will serve it. */
  z.object({ type: z.literal('file_have'), file: FileId }),
  /**
   * Setting up a direct connection for one file: the downloader's offer and
   * the holder's answer. The box is signed by its sender, which binds the
   * connection's DTLS fingerprint to their identity.
   */
  z.object({
    type: z.literal('file_link'),
    file: FileId,
    /** Random id of this connection attempt. */
    link: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
    kind: z.enum(['offer', 'answer', 'reject']),
    sdp: z.string().max(64_000).optional(),
  }),
]);
export type SealedPayload = z.infer<typeof SealedPayload>;

/** Plaintext of a group envelope. */
export const GroupPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: ChatMessage }),
  z.object({ type: z.literal('typing'), ch: z.string().max(200) }),
  /** Direct-call signalling inside a DM session. */
  z.object({
    type: z.literal('call'),
    action: z.enum(['ring', 'accept', 'decline', 'end']),
    /** A ring for a video call (older apps drop it and see a call). */
    video: z.boolean().optional(),
  }),
  /** Looking for a member who has this file (posted in this session). */
  z.object({ type: z.literal('file_want'), file: FileId }),
]);
export type GroupPayload = z.infer<typeof GroupPayload>;
