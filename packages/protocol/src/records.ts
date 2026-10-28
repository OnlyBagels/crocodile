import { z } from 'zod';
import { LIMITS } from './constants';

/**
 * Replicated metadata. Every record is signed by its author's identity key so
 * any coordination server in the mesh can store, serve and forward it without
 * being trusted: clients and servers both verify signatures and authority.
 *
 * Voice and text content are never records.
 */
export const RECORD_KINDS = [
  'profile',
  'device',
  'friends',
  'space',
  'invite',
  'member',
  'note',
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

const id = z.string().regex(/^[a-z2-7]{8,64}$/);
const pubKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const b64u = /^[A-Za-z0-9_-]*$/;
export const DeviceId = z.string().regex(/^[a-z2-7]{8,32}$/);
const peerId = z.string().regex(/^[a-z2-7]{8,64}\.[a-z2-7]{8,32}$/);

/**
 * A device's current one-time-ish prekey: an X25519 key plus an ML-KEM-768
 * key (post-quantum). Sender keys are sealed to both (hybrid), and devices
 * rotate prekeys weekly and delete the old secrets, giving forward secrecy.
 */
export const PrekeyBundle = z.object({
  id: z.number().int().min(0).max(0xffffffff),
  x25519: pubKey,
  /** ML-KEM-768 encapsulation key, base64url (1184 bytes). */
  mlkem: z.string().regex(/^[A-Za-z0-9_-]{1579}$/),
  expiresAt: z.number().int(),
});
export type PrekeyBundle = z.infer<typeof PrekeyBundle>;

export const DeviceBody = z.object({
  userId: id,
  deviceId: DeviceId,
  /** Human-readable, e.g. "Desktop · Windows". */
  name: z.string().trim().min(1).max(64),
  platform: z.enum(['desktop', 'web', 'mobile', 'bot']),
  prekey: PrekeyBundle,
  /** Revocation is permanent: later versions of a revoked device are refused. */
  revoked: z.boolean().optional(),
});
export type DeviceBody = z.infer<typeof DeviceBody>;

export const ProfileBody = z.object({
  username: z.string().trim().min(1).max(LIMITS.usernameMax),
  /** X25519 public key used to seal sender keys and pairwise messages to this user. */
  encKey: pubKey,
  avatar: z
    .string()
    .max(Math.ceil(LIMITS.avatarMaxBytes * 1.4))
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,/)
    .optional(),
  bio: z.string().max(LIMITS.bioMax).optional(),
  /** Accent colour for the profile banner, #rrggbb. */
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  /**
   * The account was deleted. Permanent: servers then drop the user's other
   * records and refuse any new record signed by this identity. The profile
   * stays as this marker (named DELETED_PROFILE_NAME, with no other details)
   * so stale copies elsewhere can't bring the account back.
   */
  deleted: z.boolean().optional(),
});
export type ProfileBody = z.infer<typeof ProfileBody>;

/** The name a deleted account's marker profile carries. */
export const DELETED_PROFILE_NAME = 'Deleted user';

/**
 * The old, readable form of a user's relationship list: everyone could see
 * whom you listed. Still accepted from apps that have not updated yet, and
 * read once to move a list into the sealed form.
 */
export const LegacyFriendsBody = z.object({
  friends: z.array(id).max(LIMITS.friendsMax),
  blocked: z.array(id).max(LIMITS.friendsMax),
});
export type LegacyFriendsBody = z.infer<typeof LegacyFriendsBody>;

/**
 * A user's relationship list (friends, requests, blocks), encrypted with a
 * key only the user's own devices derive from the account seed. Servers store
 * and replicate it but can't read it. The other side of each relationship
 * learns about it from sealed notes (see NoteBody).
 */
export const SealedFriendsBody = z.object({
  sealed: z.string().regex(b64u).max(LIMITS.recordMaxBytes),
});
export type SealedFriendsBody = z.infer<typeof SealedFriendsBody>;

export const FriendsBody = z.union([SealedFriendsBody, LegacyFriendsBody]);
export type FriendsBody = SealedFriendsBody | LegacyFriendsBody;

export function isSealedFriends(body: FriendsBody): body is SealedFriendsBody {
  return typeof (body as { sealed?: unknown }).sealed === 'string';
}

/**
 * A box to one device that hides its sender: the sender's identity and
 * signature are inside the encryption (hybrid X25519 + ML-KEM-768 against the
 * device's prekey, like SealedBox), so a server sees only the recipient.
 */
export const AnonBox = z.object({
  v: z.literal(3),
  /** Recipient peer id. */
  to: peerId,
  /** Recipient prekey id. */
  pk: z.number().int().min(0).max(0xffffffff),
  /** Ephemeral X25519 public key. */
  epk: pubKey,
  /** ML-KEM-768 ciphertext (1088 bytes). */
  kem: z.string().regex(/^[A-Za-z0-9_-]{1451}$/),
  ct: z.string().regex(b64u).max(8192),
});
export type AnonBox = z.infer<typeof AnonBox>;

/**
 * A note: a small sealed message to a user that every server keeps until the
 * user's devices have read it (they then replace it with `deleted`), and at
 * most NOTE_TTL_MS. Notes carry friend requests and their answers.
 *
 * Key `note:<recipient>:<noteId>`. A note is signed by a one-time key with
 * noteId = userIdFromKey(that key), so servers can check it without learning
 * who sent it; only the recipient may delete it.
 */
export const NoteBody = z.object({
  boxes: z.array(AnonBox).max(LIMITS.noteBoxesMax),
  deleted: z.boolean().optional(),
});
export type NoteBody = z.infer<typeof NoteBody>;

/** What a note says, inside its boxes. */
export const NotePayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('friend'),
    /** Recipient user id; a note can't be passed on to someone else. */
    to: id,
    /** Whether the sender lists the recipient (a request, or a friendship once both do). */
    listed: z.boolean(),
    /** Whether the sender thinks the recipient lists them, so a stale side can catch up. */
    sees: z.boolean(),
    /** When the sender set `listed`; later ones win. */
    at: z.number().int().positive(),
  }),
]);
export type NotePayload = z.infer<typeof NotePayload>;

export const ChannelKind = z.enum(['text', 'voice']);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const Channel = z.object({
  id,
  name: z.string().trim().min(1).max(LIMITS.channelNameMax),
  kind: ChannelKind,
  topic: z.string().max(1024).optional(),
});
export type Channel = z.infer<typeof Channel>;

export const SpaceBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.spaceNameMax),
  icon: z
    .string()
    .max(Math.ceil(LIMITS.avatarMaxBytes * 1.4))
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,/)
    .optional(),
  /** userId of the owner. spaceId = hash(owner key, nonce), so it cannot change. */
  owner: id,
  nonce: z.string().min(8).max(64),
  /** Members who may change the space (not delete it, nor change who the admins are). */
  admins: z.array(id).max(100),
  bans: z.array(id).max(10_000),
  channels: z.array(Channel).max(LIMITS.channelsPerSpace),
  deleted: z.boolean().optional(),
  /**
   * The owner's signature on `admins`, with the owner's key: lets anyone
   * check an admin's edit on its own. `at` grows each time the owner
   * changes the list, so an edit under an older list is refused.
   */
  authority: z
    .object({
      ownerKey: z.string().max(64),
      at: z.number().int().min(0),
      sig: z.string().max(200),
    })
    .optional(),
});
export type SpaceBody = z.infer<typeof SpaceBody>;

export const InviteBody = z.object({
  spaceId: id,
  code: z.string().regex(/^[a-z2-7]{8,16}$/),
  /** Epoch ms, or null for never. */
  expiresAt: z.number().int().nullable(),
  revoked: z.boolean().optional(),
});
export type InviteBody = z.infer<typeof InviteBody>;

export const MemberBody = z.object({
  spaceId: id,
  userId: id,
  /** Invite used to join; the space owner and admins may omit it. */
  inviteCode: z.string().optional(),
  left: z.boolean().optional(),
});
export type MemberBody = z.infer<typeof MemberBody>;

export interface RecordBodies {
  profile: ProfileBody;
  device: DeviceBody;
  friends: FriendsBody;
  space: SpaceBody;
  invite: InviteBody;
  member: MemberBody;
  note: NoteBody;
}

export const RECORD_BODY_SCHEMAS = {
  profile: ProfileBody,
  device: DeviceBody,
  friends: FriendsBody,
  space: SpaceBody,
  invite: InviteBody,
  member: MemberBody,
  note: NoteBody,
} as const satisfies Record<RecordKind, z.ZodType>;

export interface SignedRecord<K extends RecordKind = RecordKind> {
  v: 1;
  kind: K;
  /** `${kind}:${...}`; see recordKey helpers. */
  key: string;
  /** Ed25519 public key of the signer, base64url. */
  author: string;
  /** Epoch ms. Last writer wins; must strictly increase for a key. */
  version: number;
  body: RecordBodies[K];
  sig: string;
}

export const SignedRecordEnvelope = z.object({
  v: z.literal(1),
  kind: z.enum(RECORD_KINDS),
  key: z.string().min(3).max(200),
  author: pubKey,
  version: z.number().int().positive(),
  body: z.unknown(),
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export const recordKey = {
  profile: (userId: string) => `profile:${userId}`,
  device: (userId: string, deviceId: string) => `device:${userId}:${deviceId}`,
  devicePrefix: (userId: string) => `device:${userId}:`,
  friends: (userId: string) => `friends:${userId}`,
  space: (spaceId: string) => `space:${spaceId}`,
  invite: (code: string) => `invite:${code}`,
  invitePrefix: 'invite:',
  member: (spaceId: string, userId: string) => `member:${spaceId}:${userId}`,
  memberPrefix: (spaceId: string) => `member:${spaceId}:`,
  note: (userId: string, noteId: string) => `note:${userId}:${noteId}`,
  notePrefix: (userId: string) => `note:${userId}:`,
};

/** Replication order: records later in this list may depend on earlier ones. */
export const RECORD_KIND_ORDER: Record<RecordKind, number> = {
  profile: 0,
  device: 1,
  friends: 2,
  space: 3,
  invite: 4,
  member: 5,
  note: 6,
};
