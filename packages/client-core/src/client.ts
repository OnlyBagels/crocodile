import {
  createChatMessage,
  createIdentity,
  decodeRecoveryKey,
  encodeRecoveryKey,
  identityFromSeed,
  isSpaceMember,
  keyMatchesUserId,
  linkSecurityCode,
  openAnonymous,
  openForSelf,
  openLink,
  openSealed,
  randomDeviceId,
  randomId,
  rotatePrekeys,
  sealAnonymous,
  sealForSelf,
  sealLink,
  sealToDevice,
  userIdFromKey,
  signMailProof,
  canManageSpace,
  signRecord,
  signSpaceAuthority,
  spaceAuthorityValid,
  spaceIdFor,
  userTag,
  verifyChatMessage,
  type Identity,
  type PrekeySecret,
} from '@crocodile/crypto';
import {
  DELETED_PROFILE_NAME,
  FILE_AUTO_DOWNLOAD_MAX,
  FILE_MAX_SIZE,
  FileManifest,
  FileThumb,
  LIMITS,
  fileMediaKind,
  NotePayload,
  fromB64u,
  isSealedFriends,
  parseSessionId,
  peerIds,
  recordKey,
  sessionIds,
  streamIds,
  toB64u,
  type Channel,
  type ChannelKind,
  type ChatMessage,
  type DeviceBody,
  type LinkBox,
  type MailItem,
  SealedPayload,
  messageSession,
  utf8,
  type SealedBox,
  type HostCaps,
  type NatType,
  type LegacyFriendsBody,
  type NoteBody,
  type PresenceStatus,
  type ProfileBody,
  type OperatorInfo,
  type ServerInfo,
  type SessionState,
  type MediaKind,
  type PresenceEntry,
  type SignedRecord,
  type SpaceBody,
  type VoiceOccupancy,
} from '@crocodile/protocol';
import { CoordinatorLink, type LinkStatus } from './coordinator-link';
import { CoordinatorConnection, RpcCallError } from './coordinator-connection';
import { Emitter } from './emitter';
import {
  countMine,
  decodeFriendList,
  emptyEntry,
  encodeFriendList,
  friendsView,
  mergeEntry,
  mergeFriendLists,
  needsNote,
  pruneFriendList,
  type FriendEntry,
  type FriendList,
  type Mine,
} from './friend-list';
import {
  GroupSession,
  defaultTransportFactory,
  type RelayStatus,
  type TransportFactory,
  type ConnectAttempt,
  type VideoBlock,
} from './group-session';
import type { PlatformAdapter } from './platform';
import { webrtcFileLinks, type FileLinkFactory } from './file-link';
import { FileTransfers, type FileSource, type FileView } from './files';
import {
  networkChecklist,
  networkVerdict,
  type NetworkCheckItem,
  type NetworkVerdict,
} from './caps';
import type { ConnectionRoute, LinkStats } from './relay-link';
import { Outbox } from './outbox';
import { RecordCache } from './records-cache';
import type { RankedServer } from './server-selection';
import { StateStore } from './store';
import type { OutgoingVideo, ScreenQuality, ScreenRequest, VoiceEngine } from './voice';

export interface ClientConfig {
  /** Directory services used to discover coordination servers. */
  directories: string[];
  /** Coordination servers to try before the directory's picks. */
  preferredServers?: string[];
  /** Override the WebRTC transport (tests). */
  transportFactory?: TransportFactory;
  /** Override direct connections for files (tests). */
  fileLinks?: FileLinkFactory;
  /** This device's clock (tests). */
  now?: () => number;
  /** How long an unanswered call rings before hanging up (45 s; tests). */
  ringTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Settings {
  /** Let this device act as session host (relay) when elected. */
  allowHosting: boolean;
  /** Self-reported upload bandwidth, used as a hint for host election. */
  uplinkKbps?: number;
  preferredServers: string[];
  status: 'online' | 'idle' | 'dnd' | 'invisible';
  notifications: boolean;
  /**
   * When no direct path to a host works, relay through a coordination server
   * (TURN). Traffic stays end-to-end encrypted; grants last at most an hour.
   */
  allowServerRelay: boolean;
  /**
   * When the other side of a DM is offline, let a coordination server hold
   * the message (sealed to their devices, unreadable to the server) until
   * they come online or the server's time limit passes.
   */
  useMailbox: boolean;
  /** Display name of this device. */
  deviceName?: string;
  /**
   * Fetch pictures and videos up to 10 MB by themselves: from friends and in
   * DMs, from anyone, or never. Fetching connects to whoever has the file,
   * who then sees this device's IP address.
   */
  autoDownload: 'friends' | 'everyone' | 'never';
  /** Give files this device downloaded to members of the same space or DM who ask. */
  shareDownloads: boolean;
}

export const defaultSettings: Settings = {
  allowHosting: true,
  preferredServers: [],
  status: 'online',
  notifications: true,
  allowServerRelay: false,
  useMailbox: false,
  autoDownload: 'friends',
  shareDownloads: true,
};

export interface ProfileView {
  userId: string;
  username: string;
  tag: string;
  avatar?: string;
  bio?: string;
  accent?: string;
  encKey: string;
  publicKey: string;
}

export interface SpaceView {
  id: string;
  name: string;
  icon?: string;
  owner: string;
  channels: Channel[];
  members: string[];
  bans: string[];
  /** Members the owner lets change the space. */
  admins: string[];
}

/** A session as the UI sees it: user ids (devices collapsed). */
export interface SessionView {
  id: string;
  status: RelayStatus;
  /** User id of the host. */
  host: string | null;
  backup: string | null;
  epoch: number;
  members: string[];
  /** Other users currently connected through the relay. */
  peers: string[];
  speaking: string[];
  muted: string[];
  deafened: string[];
  /** This device is the host. */
  iAmHost: boolean;
  /** Connected through a coordination server's relay until this time. */
  relay: { server: string; expiresAt: number } | null;
  /** How the connection to the host travels, once connected. */
  route: ConnectionRoute | null;
  /** Connecting to the host keeps failing. */
  trouble: boolean;
  /** When the current connection to the host opened (null while not connected). */
  connectedAt: number | null;
  /** Recent attempts to connect to the host, newest last (host as a user id). */
  attempts: ConnectAttempt[];
  /**
   * The network type each member device reported when joining: what host
   * election goes by (a symmetric NAT makes a poor host). One entry per
   * device, so two devices of one user each keep theirs.
   */
  networks: MemberNetwork[];
  /**
   * Users in the call (audio), us included: in a DM, the other side may be
   * connected for text only. Empty for sessions without a call.
   */
  inCall: string[];
  /** Each call member's round trip to the host, in ms, as they last measured it. */
  latency: Record<string, number>;
  /** Cameras and shared screens in the call. */
  video: {
    /** Why video can't be used in this call right now, if it can't. */
    blocked: VideoBlock | null;
    /** Video is on our connection: we can show and watch. */
    ready: boolean;
    streams: VideoStreamView[];
  };
}

/** A camera or shared screen in a call. */
export interface VideoStreamView {
  /** Stream id (`<peer>:camera` or `<peer>:screen`). */
  id: string;
  userId: string;
  kind: MediaKind;
  /** A screen shared with its sound. */
  audio: boolean;
  /** Ours: shown from the local preview. */
  mine: boolean;
  /**
   * What we get of it: `live` (it plays), `loading` (asked for, its first
   * picture is on its way), `paused` (the host's connection or ours is full),
   * `off` (a screen we haven't chosen to watch).
   */
  state: 'live' | 'loading' | 'paused' | 'off';
}

/** A space an invite leads to, as shown before joining. */
export interface InvitePreview {
  code: string;
  spaceId: string;
  name: string;
  icon?: string;
  /** We are a member already. */
  joined: boolean;
  /** Revoked or past its time: joining with it would fail. */
  expired: boolean;
}

/** One member device's network type, as the coordinator's election sees it. */
export interface MemberNetwork {
  user: string;
  nat: NatType;
  /** This device is the session's host. */
  host: boolean;
  /** This is our own device. */
  self: boolean;
}

/** What the network allows for direct connections (see checkNetwork). */
export interface NetworkStatus {
  verdict: NetworkVerdict;
  checking: boolean;
  checkedAt: number;
  /** What each check found, and why the verdict is what it is. */
  checks?: NetworkCheckItem[];
  reason?: string;
}

export interface DeviceView {
  deviceId: string;
  name: string;
  platform: string;
  current: boolean;
  revoked: boolean;
  lastUpdated: number;
}

export type LinkingState =
  | {
      role: 'new';
      step: 'waiting' | 'claimed' | 'done' | 'error';
      code?: string;
      securityCode?: string;
      account?: string;
      error?: string;
    }
  | {
      role: 'existing';
      step: 'confirm' | 'sent' | 'error';
      code: string;
      securityCode: string;
      error?: string;
    };

export interface MessageView extends ChatMessage {
  edited?: boolean;
  /** Written by us and not yet confirmed by anyone else. */
  pending?: boolean;
  /** Held by a server mailbox until the recipient comes online. */
  mailed?: boolean;
}

export interface ClientState {
  phase: 'loading' | 'onboarding' | 'ready';
  link: LinkStatus;
  /** The server this device is connected to, and who runs it if it says. */
  server: { info: ServerInfo; rttMs: number; operator?: OperatorInfo } | null;
  /** Every server the directories list, best first; unreachable ones last (rttMs Infinity). */
  servers: RankedServer[];
  me: ProfileView | null;
  profiles: Record<string, ProfileView>;
  presence: Record<string, PresenceStatus>;
  friends: { friends: string[]; incoming: string[]; outgoing: string[]; blocked: string[] };
  spaces: Record<string, SpaceView>;
  voice: Record<string, VoiceOccupancy>;
  sessions: Record<string, SessionView>;
  dms: string[];
  messages: Record<string, MessageView[]>;
  unread: Record<string, number>;
  typing: Record<string, Record<string, number>>;
  activeChannel: string | null;
  voiceSession: string | null;
  /** Someone is ringing us in a DM. */
  /** `video`: the caller turned their camera on to call. */
  incomingCall: { sessionId: string; from: string; at: number; video?: boolean } | null;
  /** We are ringing someone and they have not answered yet. */
  outgoingCall: { sessionId: string; to: string; at: number; video?: boolean } | null;
  /**
   * Since when the call we are in is live: connected, and in a DM with the
   * other side in it too. Null while ringing, connecting or alone.
   */
  callLiveSince: number | null;
  muted: boolean;
  deafened: boolean;
  /** Our camera is on (in the call we are in). */
  camera: boolean;
  /** We share a screen, and how. */
  screenShare: { quality: ScreenQuality; audio: boolean } | null;
  settings: Settings;
  /** Toasts: problems, and `info` notices such as a call ending. */
  errors: { id: number; message: string; kind?: 'info' }[];
  /** This account's devices. */
  devices: DeviceView[];
  deviceId: string | null;
  linking: LinkingState | null;
  /** The server relay window ended; the UI may offer to extend it. */
  relayEnded: { sessionId: string; reason: string } | null;
  /** This device was signed out because the account was deleted. */
  accountDeleted: boolean;
  /** Result of the latest network check; null before the first one. */
  network: NetworkStatus | null;
  /**
   * Connecting to someone keeps failing and the relay is off: the UI offers
   * it (useRelay). `with` is the person we were trying to reach.
   */
  connectionTrouble: { sessionId: string; with: string | null } | null;
  /** Files in messages this device knows of: what is here and what is on its way. */
  files: Record<string, FileView>;
}

export type ClientEvents = {
  /** `update`: an edit or deletion of an earlier message, not a new one. */
  message: { channel: string; message: ChatMessage; mine: boolean; update: boolean };
  error: { message: string };
  /** A call we are in: went live, someone joined or left it, or it ended. */
  call: { sessionId: string; event: 'live' | 'joined' | 'left' | 'ended' };
  /** Someone fetched all of a file from this device. `to` is a user id. */
  fileServed: { fileId: string; to: string };
};

const APP_VERSION_FALLBACK = '0.1.0';
/** How far ahead of our clock a message's time may be before it is refused. */
const MAX_AHEAD_MS = 5 * 60_000;
/** How long direct delivery gets before an opted-in DM goes to a mailbox. */
const MAIL_AFTER_MS = 5000;
/** Plaintext bytes of messages in one mailbox box. */
const MAIL_BOX_BYTES = 48 * 1024;
/** Bytes of boxes in one mail.put request. */
const MAIL_REQUEST_BYTES = 512 * 1024;
/** How soon to retry a note owed to someone who just came online. */
const FRIEND_NOTE_RETRY_MS = 5000;
/** And how often while connected, whoever it is owed to. */
const FRIEND_NOTE_SWEEP_MS = 10 * 60_000;
/** A caller rings again every 2.5 s at most: this long without a ring, it has gone. */
const RING_SILENCE_MS = 8000;
/** Time for a hang-up to go out before the call's connection closes. */
const HANG_UP_FLUSH_MS = 200;
/** How long a DM call waits for the other side to come back before it ends. */
const CALL_LOST_GRACE_MS = 20_000;

/**
 * The whole client behind one object. UIs render `store` and call methods;
 * nothing here is specific to a UI toolkit or to Electron.
 */
export class CrocodileClient extends Emitter<ClientEvents> {
  readonly store: StateStore<ClientState>;
  identity: Identity | null = null;
  deviceId = '';
  private prekeys: PrekeySecret[] = [];
  private prekeyTimer?: ReturnType<typeof setInterval>;
  link?: CoordinatorLink;
  readonly records: RecordCache;
  private sessions = new Map<string, GroupSession>();
  private outbox: Outbox;
  private mailTimer?: ReturnType<typeof setTimeout>;
  private transportFactory?: TransportFactory;
  private stun: string[] = [];
  private errorId = 0;
  private engine?: VoiceEngine;
  private offVideo?: () => void;
  /** Voice and video on this device (set by the app; absent where there is none). */
  get voiceEngine(): VoiceEngine | undefined {
    return this.engine;
  }
  set voiceEngine(engine: VoiceEngine | undefined) {
    this.offVideo?.();
    this.engine = engine;
    this.offVideo = engine?.on('video', (out) => this.onOutgoingVideo(out));
  }
  /** Our relationships, decrypted (see friend-list.ts). */
  private friendList: FriendList = new Map();
  /** The list as our stored record has it, encoded; anything else still needs saving. */
  private friendListStored = '';
  /** Our stored list is in a form this version can't read: don't overwrite it. */
  private friendListUnreadable = false;
  /** Changes to the list run one at a time. */
  private friendOps: Promise<unknown> = Promise.resolve();
  private friendRetryTimer?: ReturnType<typeof setTimeout>;
  /** Grows while notes keep failing, so an unreachable person isn't asked about constantly. */
  private friendRetryDelay = FRIEND_NOTE_RETRY_MS;
  private friendSweepTimer?: ReturnType<typeof setInterval>;
  /** Absent when the platform can't store files or connect directly. */
  files?: FileTransfers;

  constructor(
    readonly platform: PlatformAdapter,
    readonly config: ClientConfig,
  ) {
    super();
    this.records = new RecordCache(platform.kv);
    this.outbox = new Outbox(platform.kv);
    this.transportFactory = config.transportFactory ?? defaultTransportFactory(platform);
    const links =
      config.fileLinks ??
      (platform.rtc ? webrtcFileLinks(platform.rtc.RTCPeerConnection) : undefined);
    if (platform.files && links) this.files = this.makeFiles(platform.files, links);
    this.store = new StateStore<ClientState>({
      phase: 'loading',
      link: 'idle',
      server: null,
      servers: [],
      me: null,
      profiles: {},
      presence: {},
      friends: { friends: [], incoming: [], outgoing: [], blocked: [] },
      spaces: {},
      voice: {},
      sessions: {},
      dms: [],
      messages: {},
      unread: {},
      typing: {},
      activeChannel: null,
      voiceSession: null,
      incomingCall: null,
      outgoingCall: null,
      callLiveSince: null,
      muted: false,
      deafened: false,
      camera: false,
      screenShare: null,
      settings: defaultSettings,
      errors: [],
      devices: [],
      deviceId: null,
      linking: null,
      relayEnded: null,
      accountDeleted: false,
      network: null,
      connectionTrouble: null,
      files: {},
    });
    this.records.on('changed', (r) => this.onRecordChanged(r));
    this.records.on('wanted', (keys) => this.fetchWanted(keys));
  }

  get state() {
    return this.store.get();
  }

  /** STUN servers handed out by the current coordination server. */
  get stunUrls(): string[] {
    return this.stun;
  }

  get userId(): string {
    if (!this.identity) throw new Error('not signed in');
    return this.identity.userId;
  }

  /** This device's peer id (`<userId>.<deviceId>`). */
  get peer(): string {
    return peerIds.make(this.userId, this.deviceId);
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    this.config.log?.(msg, extra);
  }

  reportError(message: string) {
    this.toast(message);
    this.emit('error', { message });
  }

  /** A notice that isn't a problem ("Call ended"). */
  reportInfo(message: string) {
    this.toast(message, 'info');
  }

  private toast(message: string, kind?: 'info') {
    const id = ++this.errorId;
    this.store.set((s) => ({
      errors: [...s.errors.slice(-4), { id, message, ...(kind ? { kind } : {}) }],
    }));
    setTimeout(
      () => this.store.set((s) => ({ errors: s.errors.filter((e) => e.id !== id) })),
      8000,
    );
  }

  // ===========================================================================
  // Identity and onboarding
  // ===========================================================================

  /** Loads the saved identity; if there is none the UI shows onboarding. */
  async init() {
    const settings = {
      ...defaultSettings,
      ...((await this.platform.kv.get<Partial<Settings>>('settings')) ?? {}),
    };
    const dms = (await this.platform.kv.get<string[]>('dms')) ?? [];
    await this.loadDevice();
    await this.outbox.load();
    await this.files?.load();
    this.store.set({ settings, dms, deviceId: this.deviceId });
    await this.records.load();
    const seed = await this.platform.kv.get<string>('identity-seed');
    if (!seed) {
      this.store.set({ phase: 'onboarding' });
      return;
    }
    this.identity = identityFromSeed(fromB64u(seed));
    // Changes not yet stored on a server (made offline) are kept here.
    const local = await this.platform.kv.get<string>('friend-list');
    const kept = local && decodeFriendList(fromB64u(local));
    if (kept) this.friendList = kept;
    this.refreshDerivedState();
    this.store.set({ phase: 'ready' });
    this.connect();
  }

  /**
   * First run: create an identity and publish the profile. Works offline: the
   * signed profile is kept locally and published once a server is reachable.
   */
  async createAccount(username: string, avatar?: string) {
    const identity = createIdentity();
    await this.adoptIdentity(identity);
    await this.saveProfile({ username: username.trim(), ...(avatar ? { avatar } : {}) }).catch(
      (err) => {
        if (!(err instanceof RpcCallError) || err.code !== 'unavailable') throw err;
        this.refreshDerivedState();
      },
    );
  }

  /**
   * Servers tried before the directory's picks that are not user settings,
   * e.g. a coordination server running on this computer.
   */
  setExtraServers(urls: string[]) {
    const current = this.config.preferredServers ?? [];
    if (current.length === urls.length && current.every((u, i) => u === urls[i])) return;
    this.config.preferredServers = urls;
    if (this.identity && this.state.link !== 'connected') this.connect();
  }

  /** Restore an existing identity from its recovery key. */
  async restoreAccount(recoveryKey: string, usernameIfNew?: string) {
    const identity = identityFromSeed(decodeRecoveryKey(recoveryKey));
    await this.adoptIdentity(identity);
    const existing = await this.link!.request('records.get', {
      keys: [recordKey.profile(identity.userId)],
    }).catch(() => null);
    if (existing?.records[0]) this.records.ingest(existing.records[0]);
    else if (usernameIfNew) await this.saveProfile({ username: usernameIfNew });
  }

  private async adoptIdentity(identity: Identity) {
    this.identity = identity;
    this.store.set({ accountDeleted: false });
    await this.platform.kv.set('identity-seed', toB64u(identity.seed));
    this.connect();
  }

  private async loadDevice() {
    let deviceId = await this.platform.kv.get<string>('device-id');
    if (!deviceId) {
      deviceId = randomDeviceId();
      await this.platform.kv.set('device-id', deviceId);
    }
    this.deviceId = deviceId;
    this.prekeys = (await this.platform.kv.get<PrekeySecret[]>('prekeys')) ?? [];
  }

  /**
   * Keep this device's prekey fresh and its device record published. Old
   * prekey secrets are deleted after a grace period (forward secrecy).
   */
  private async ensureDeviceRecord() {
    const identity = this.identity!;
    const { keys, rotated } = rotatePrekeys(this.prekeys);
    this.prekeys = keys;
    if (rotated) await this.platform.kv.set('prekeys', keys);
    const newest = keys.at(-1)!;
    const key = recordKey.device(identity.userId, this.deviceId);
    const res = await this.link!.request('records.get', { keys: [key] });
    const remote = res.records[0] as SignedRecord<'device'> | undefined;
    if (remote) this.records.ingest(remote);
    if (remote?.body.revoked) {
      this.reportError('This device was removed from your account on another device.');
      return;
    }
    const name = this.state.settings.deviceName ?? defaultDeviceName(this.platform.platform);
    if (remote && remote.body.prekey.id === newest.id && remote.body.name === name) return;
    const body: DeviceBody = {
      userId: identity.userId,
      deviceId: this.deviceId,
      name,
      platform: this.platform.platform,
      prekey: newest.bundle,
    };
    await this.putRecord(signRecord(identity, 'device', key, body, this.nextVersion(key)));
  }

  /** Onboarding UIs call this once the user has seen their recovery key. */
  finishOnboarding() {
    if (this.identity) this.store.set({ phase: 'ready' });
  }

  recoveryKey(): string {
    if (!this.identity) throw new Error('not signed in');
    return encodeRecoveryKey(this.identity.seed);
  }

  /** Forget this device's identity (the user should have saved the recovery key). */
  async signOut() {
    // While the link is still up: revoking goes through the server.
    if (this.identity && this.deviceId) {
      await this.revokeDevice(this.deviceId).catch(() => {});
    }
    await this.forgetLocalAccount({ deleted: false });
  }

  /**
   * Deletes the account everywhere: spaces you own are deleted for everyone,
   * you leave the others, and the profile becomes a permanent "deleted"
   * marker. Servers then erase your devices, friends list, memberships and
   * mail, and refuse anything this identity signs; your other devices are
   * signed out. Messages stored on other people's devices stay with them.
   */
  async deleteAccount() {
    const id = this.identity;
    if (!id) throw new Error('not signed in');
    if (this.state.link !== 'connected')
      throw new Error('Connect to a coordination server first, so the deletion reaches it.');
    const me = id.userId;
    // The server's full list, not just what this device has synced: once the
    // marker is out, nothing more can be signed, so a missed space stays.
    const mine = await this.link!.request('spaces.mine', {});
    this.records.ingestAll([...mine.spaces, ...mine.members]);
    for (const r of this.records.list('space:') as SignedRecord<'space'>[]) {
      if (r.body.owner !== me || r.body.deleted) continue;
      // The space disappears for its members; keep nothing but what identifies it.
      const body: SpaceBody = {
        name: 'Deleted space',
        owner: me,
        nonce: r.body.nonce,
        admins: [],
        bans: [],
        channels: [],
        deleted: true,
      };
      await this.putRecord(signRecord(id, 'space', r.key, body, this.nextVersion(r.key)));
    }
    for (const r of this.records.list('member:') as SignedRecord<'member'>[]) {
      if (r.body.userId === me && !r.body.left) await this.leaveSpace(r.body.spaceId);
    }
    const key = recordKey.profile(me);
    await this.putRecord(
      signRecord(
        id,
        'profile',
        key,
        { username: DELETED_PROFILE_NAME, encKey: id.encPublicKey, deleted: true },
        this.nextVersion(key),
      ),
    );
    await this.forgetLocalAccount({ deleted: true });
  }

  /** Clears this device's copy of the account, including stored messages. */
  private async forgetLocalAccount({ deleted }: { deleted: boolean }) {
    // A call in progress ends with the account: microphone off, nothing ringing.
    clearInterval(this.ringTimer);
    clearTimeout(this.ringingTimer);
    const voice = this.state.voiceSession;
    if (voice) this.voiceEngine?.stopSession(voice);
    this.voiceEngine?.stop();
    await Promise.all([...this.sessions.values()].map((s) => s.leave().catch(() => {})));
    this.sessions.clear();
    this.link?.stop();
    this.link = undefined;
    // Cancel pending saves first, or they could write erased data back.
    this.records.reset();
    this.outbox.dispose();
    await this.platform.messages.clear();
    if (this.files) {
      await this.files.close();
      for (const f of this.files.list()) await this.files.forget(f.id);
    }
    await this.platform.kv.delete('identity-seed');
    await this.platform.kv.delete('records-cache');
    await this.platform.kv.delete('prekeys');
    await this.platform.kv.delete('device-id');
    await this.platform.kv.delete('outbox');
    await this.platform.kv.delete('friend-list');
    this.outbox = new Outbox(this.platform.kv);
    clearTimeout(this.mailTimer);
    clearInterval(this.prekeyTimer);
    clearTimeout(this.friendRetryTimer);
    clearInterval(this.friendSweepTimer);
    this.prekeys = [];
    this.friendList = new Map();
    this.friendListStored = '';
    this.friendListUnreadable = false;
    await this.loadDevice();
    this.identity = null;
    this.store.set({
      phase: 'onboarding',
      me: null,
      profiles: {},
      friends: { friends: [], incoming: [], outgoing: [], blocked: [] },
      spaces: {},
      sessions: {},
      messages: {},
      dms: [],
      devices: [],
      voiceSession: null,
      outgoingCall: null,
      incomingCall: null,
      accountDeleted: deleted,
    });
  }

  async updateSettings(patch: Partial<Settings>) {
    const settings = { ...this.state.settings, ...patch };
    this.store.set({ settings });
    await this.platform.kv.set('settings', settings);
    if (patch.status)
      void this.link?.request('presence.set', { status: patch.status }).catch(() => {});
    if (patch.allowHosting !== undefined || patch.uplinkKbps !== undefined) {
      for (const s of this.sessions.values()) void s.updateCaps();
    }
    if (patch.preferredServers) {
      this.link?.stop();
      this.connect();
    }
  }

  // ===========================================================================
  // Coordination link
  // ===========================================================================

  /** Puts a server first among the preferred servers (moving it if listed). */
  preferServer(url: string): Promise<void> {
    const rest = this.state.settings.preferredServers.filter((p) => p !== url);
    return this.updateSettings({ preferredServers: [url, ...rest] });
  }

  /** Re-reads the server directories and measures every server. */
  refreshServers(): Promise<void> {
    return this.link?.refreshServers() ?? Promise.resolve();
  }

  /** Measures the round trip to the connected server once more. */
  measureLatency(): Promise<void> {
    return this.link?.measureLatency() ?? Promise.resolve();
  }

  private connect() {
    if (!this.identity) return;
    this.link?.stop();
    const link = new CoordinatorLink({
      identity: this.identity,
      deviceId: this.deviceId,
      platform: this.platform.platform,
      version: this.platform.appVersion || APP_VERSION_FALLBACK,
      kv: this.platform.kv,
      directories: this.config.directories,
      preferredServers: [
        ...this.state.settings.preferredServers,
        ...(this.config.preferredServers ?? []),
      ],
      fetchImpl: this.platform.fetch,
      WebSocketImpl: this.platform.WebSocketImpl,
    });
    this.link = link;
    link.on('status', (status) => this.store.set({ link: status }));
    link.on('servers', (servers) => {
      if (this.link === link) this.store.set({ servers });
    });
    link.on('connected', ({ server, rttMs, stun, operator }) => {
      this.stun = stun;
      void this.checkNetwork();
      this.store.set({ server: { info: server, rttMs, operator } });
      void this.onConnected().catch((err) =>
        this.log('post-connect sync failed', { err: String(err) }),
      );
    });
    link.on('latency', ({ rttMs }) => {
      if (this.link !== link) return;
      const server = this.state.server;
      if (server) this.store.set({ server: { ...server, rttMs } });
    });
    link.on('disconnected', () => this.store.set({ server: null }));
    // Deleted from another device: this one forgets the account too, but only
    // with a marker signed by this identity. A server's word is not enough.
    link.on('account_deleted', ({ record }) => {
      if (record) this.records.ingest(record);
      const mine = this.identity && this.records.get(recordKey.profile(this.identity.userId));
      if (!(mine?.body as ProfileBody | undefined)?.deleted) {
        this.log('ignoring an account deletion without a valid marker');
        return;
      }
      this.link?.stop();
      void this.forgetLocalAccount({ deleted: true });
    });
    link.on('record', ({ record }) => {
      if (record.kind === 'note') {
        void this.readNotes([record]);
        return;
      }
      this.records.ingest(record);
      // Membership of ours whose space we have not seen yet (joined on another device).
      if (record.kind === 'member') {
        const body = (record as SignedRecord<'member'>).body;
        if (
          body.userId === this.identity?.userId &&
          !body.left &&
          !this.records.get(recordKey.space(body.spaceId))
        ) {
          void this.adoptSpace(body.spaceId);
        }
      }
    });
    link.on('presence', (p) => {
      const was = this.state.presence[p.userId];
      this.store.set((s) => ({ presence: { ...s.presence, [p.userId]: p.status } }));
      // A friend with undelivered DMs came online: invite them to the session.
      if (p.status !== 'offline' && (was === 'offline' || was === undefined)) {
        const sid = sessionIds.dm(this.userId, p.userId);
        if (this.outbox.forSession(sid).length) void this.pokeDm(sid);
        // Someone we still owe a note (we couldn't reach their devices before):
        // try again once their app has had a moment to publish its device.
        const owed = this.friendList.get(p.userId);
        if (owed && needsNote(owed)) this.retryFriendNotes(FRIEND_NOTE_RETRY_MS);
      }
    });
    link.on('mail', ({ items }) => void this.onMail(items));
    link.on('session', ({ state }) => this.sessions.get(state.id)?.applyState(state));
    link.on('signal', ({ from, sessionId, data }) =>
      this.sessions.get(sessionId)?.handleSignal(from, data),
    );
    link.on('voice', (occ) => this.setOccupancy(occ));
    link.on('session_invite', ({ sessionId, from }) => void this.onSessionInvite(sessionId, from));
    link.on('replaced', () =>
      this.reportError('This device connected again from another window; this one is now offline.'),
    );
    link.on('relay_expired', ({ reason }) => {
      for (const s of this.sessions.values()) {
        // Only connections that went through the relay are interrupted (and
        // worth asking about); those that found a direct path carry on.
        if (s.dropServerRelay()) this.store.set({ relayEnded: { sessionId: s.sessionId, reason } });
      }
    });
    link.start();
  }

  private async onConnected() {
    const link = this.link!;
    const me = this.userId;
    await this.ensureProfilePublished();
    await this.ensureDeviceRecord();
    clearInterval(this.prekeyTimer);
    this.prekeyTimer = setInterval(
      () => void this.ensureDeviceRecord().catch(() => {}),
      6 * 3600_000,
    );

    const [mine, incoming, own] = await Promise.all([
      link.request('spaces.mine', {}),
      link.request('friends.incoming', {}),
      link.request('records.get', { keys: [recordKey.profile(me), recordKey.friends(me)] }),
    ]);
    const myDevices = await link.request('records.list', { prefix: recordKey.devicePrefix(me) });
    this.records.ingestAll([
      ...own.records,
      ...myDevices.records,
      ...mine.spaces,
      ...mine.members,
      // Requests from apps that still write readable lists.
      ...incoming.records,
    ]);
    // Notes that came while we were away, then whatever our list still owes
    // the server (a change made offline, or moving an old readable list over)
    // and our friends (notes not sent yet).
    const notes = await link.request('records.list', { prefix: recordKey.notePrefix(me) });
    await this.readNotes(notes.records);
    await this.queueFriends(() => this.syncFriendList()).catch((err) =>
      this.log('friends list not saved', { err: String(err) }),
    );
    clearInterval(this.friendSweepTimer);
    this.friendSweepTimer = setInterval(() => this.retryFriendNotes(0), FRIEND_NOTE_SWEEP_MS);
    const spaceIds = mine.spaces.map((s) => s.key.slice('space:'.length));
    // Members of our spaces, so we can verify peers and show member lists.
    for (const id of spaceIds) {
      const members = await link.request('records.list', { prefix: recordKey.memberPrefix(id) });
      this.records.ingestAll(members.records);
    }
    await this.subscribe([
      recordKey.profile(me),
      recordKey.friends(me),
      recordKey.devicePrefix(me),
      ...spaceIds.flatMap((id) => [recordKey.space(id), recordKey.memberPrefix(id)]),
    ]);
    await this.syncProfiles();
    if (this.state.settings.status !== 'online')
      await link.request('presence.set', { status: this.state.settings.status });
    const { voice } = await link.request('voice.watch', { spaceIds });
    this.store.set({
      voice: Object.fromEntries(voice.map((v) => [sessionIds.voice(v.spaceId, v.channelId), v])),
    });

    // (Re)join sessions: every space's text mesh, plus whatever voice/DM we were in.
    for (const id of spaceIds) this.ensureSession(sessionIds.space(id));
    // DMs with undelivered messages: be in the session so the other side is invited.
    for (const other of this.state.dms) {
      const sid = sessionIds.dm(me, other);
      if (this.outbox.forSession(sid).length) this.ensureSession(sid);
    }
    for (const s of this.sessions.values())
      void s.join().catch((err) => this.log('join failed', { id: s.sessionId, err: String(err) }));
    // Mail held for this device while it was offline, anywhere in the mesh.
    // Signed for this server, so the others send their mail for us here too.
    const server = this.state.server?.info.id;
    void link
      .request(
        'mail.fetch',
        server
          ? { proof: signMailProof(this.identity!, { t: 'mail_fetch', peer: this.peer, server }) }
          : {},
      )
      .catch(() => {});
    this.scheduleMail();
  }

  // ===========================================================================
  // Outbox and mailbox
  // ===========================================================================

  /** Newest message of a channel that did not come from our own offline queue. */
  private async syncCursor(channel: string): Promise<number> {
    const page = await this.platform.messages.page(channel, { limit: 200 });
    for (let i = page.length - 1; i >= 0; i--) {
      if (!this.outbox.has(page[i]!.id)) return page[i]!.ts;
    }
    return 0;
  }

  private withDelivery(page: ChatMessage[]): MessageView[] {
    return page.map((m) => {
      const e = this.outbox.get(m.id);
      return e ? { ...m, pending: true, mailed: !!e.mailed } : m;
    });
  }

  private onAcked(ids: string[]) {
    const done = new Set(this.outbox.ack(ids));
    if (done.size === 0) return;
    this.store.set((s) => {
      const messages = { ...s.messages };
      let changed = false;
      for (const [ch, list] of Object.entries(messages)) {
        if (!list.some((m) => done.has(m.id))) continue;
        messages[ch] = list.map((m) =>
          done.has(m.id) ? { ...m, pending: false, mailed: false } : m,
        );
        changed = true;
      }
      return changed ? { messages } : {};
    });
  }

  /** Re-join a DM session so the coordinator invites the other side again. */
  private async pokeDm(sessionId: string) {
    if (!this.link || this.link.status !== 'connected') return;
    const session = this.ensureSession(sessionId);
    await session.join().catch(() => {});
  }

  /** Give direct delivery a few seconds before falling back to a mailbox. */
  private scheduleMail(delayMs = MAIL_AFTER_MS) {
    if (!this.state.settings.useMailbox) return;
    clearTimeout(this.mailTimer);
    this.mailTimer = setTimeout(() => void this.mailOutbox(), delayMs);
  }

  /**
   * Deposit unconfirmed DM messages in the coordination server's mailbox,
   * sealed separately to each of the recipient's devices (and our other
   * devices). The outbox keeps them until a peer confirms, so direct
   * delivery still happens if we meet first.
   */
  async mailOutbox() {
    const link = this.link;
    if (!this.state.settings.useMailbox || !link || link.status !== 'connected' || !this.identity)
      return;
    const me = this.userId;
    const bySession = new Map<string, ChatMessage[]>();
    for (const e of this.outbox.unmailed(MAIL_AFTER_MS - 500)) {
      const list = bySession.get(e.sessionId) ?? [];
      list.push(e.message);
      bySession.set(e.sessionId, list);
    }
    for (const [sessionId, pending] of bySession) {
      const scope = parseSessionId(sessionId);
      if (scope?.kind !== 'dm') continue;
      const other = scope.users.find((u) => u !== me) ?? me;
      try {
        const targets = await this.mailTargets([other, me]);
        if (targets.length === 0) continue;
        const items: { to: string; box: SealedBox }[] = [];
        // A server takes boxes of up to 96 KiB: sealed and encoded, 48 KiB of
        // messages stays well under that.
        const size = (m: ChatMessage) => utf8.encode(JSON.stringify(m)).length + 1;
        for (const chunk of chunksBySize(pending, MAIL_BOX_BYTES, size)) {
          const plaintext = utf8.encode(JSON.stringify({ type: 'mail', messages: chunk }));
          for (const t of targets) {
            items.push({
              to: t.peer,
              box: sealToDevice(this.identity, this.deviceId, t, plaintext),
            });
          }
        }
        // At most 20 boxes a request, and well under the 1 MiB frame limit.
        const boxSize = (it: { box: SealedBox }) => it.box.ct.length + 1024;
        for (const part of chunksBySize(items, MAIL_REQUEST_BYTES, boxSize, 20))
          await link.request('mail.put', { items: part });
        const ids = pending.map((m) => m.id);
        this.outbox.markMailed(ids);
        const mailed = new Set(ids);
        this.store.set((s) => {
          const list = s.messages[sessionId];
          if (!list) return {};
          return {
            messages: {
              ...s.messages,
              [sessionId]: list.map((m) => (mailed.has(m.id) ? { ...m, mailed: true } : m)),
            },
          };
        });
        this.log('mailed messages', { sessionId, count: ids.length, devices: targets.length });
      } catch (err) {
        this.log('mailbox unavailable', { sessionId, err: String(err) });
      }
    }
  }

  /** Current, unrevoked devices of some users, except this one (at most `max`). */
  private async mailTargets(userIds: string[], max = 20) {
    const out: { peer: string; prekey: DeviceBody['prekey'] }[] = [];
    for (const userId of new Set(userIds)) {
      const res = await this.link!.request('records.list', {
        prefix: recordKey.devicePrefix(userId),
      });
      this.records.ingestAll(res.records);
      for (const r of res.records as SignedRecord<'device'>[]) {
        const verified = this.records.get(r.key) as SignedRecord<'device'> | undefined;
        if (!verified || verified.sig !== r.sig || verified.body.revoked) continue;
        const peer = peerIds.make(userId, verified.body.deviceId);
        if (peer === this.peer) continue;
        out.push({ peer, prekey: verified.body.prekey });
      }
    }
    return out.slice(0, max);
  }

  /** Mail that waited on a server for this device. */
  private async onMail(items: MailItem[]) {
    const done: string[] = [];
    for (const item of items) {
      done.push(item.id);
      const opened = this.openBox(item.box);
      if (!opened) {
        this.log('could not open mail', { id: item.id });
        continue;
      }
      let payload: SealedPayload;
      try {
        payload = SealedPayload.parse(JSON.parse(utf8.decode(opened.plaintext)));
      } catch {
        continue;
      }
      if (payload.type !== 'mail') continue;
      const sender = peerIds.user(opened.from);
      for (const m of payload.messages) {
        if (m.author !== sender) continue;
        const scope = parseSessionId(m.ch);
        if (scope?.kind !== 'dm' || !scope.users.includes(this.userId)) continue;
        const other = scope.users.find((u) => u !== this.userId) ?? this.userId;
        if (this.state.friends.blocked.includes(other)) continue;
        if (await this.acceptMessage(m.ch, m)) this.addDm(other);
      }
    }
    if (done.length)
      await this.link
        ?.request('mail.ack', {
          ids: done,
          proof: signMailProof(this.identity!, { t: 'mail_ack', peer: this.peer, ids: done }),
        })
        .catch(() => {});
  }

  private async ensureProfilePublished() {
    const me = this.userId;
    const res = await this.link!.request('records.get', { keys: [recordKey.profile(me)] });
    const remote = res.records[0];
    if (remote) this.records.ingest(remote);
    const local = this.records.get(recordKey.profile(me));
    if (local && (!remote || remote.version < local.version))
      await this.link!.request('records.put', { record: local });
  }

  /** Fetch profiles of everyone we show: friends, requests, space members. */
  private async syncProfiles() {
    const ids = this.relevantUsers();
    const missing = ids.filter((id) => id !== this.userId);
    for (const part of chunks(missing, 400)) {
      const keys = part.map((id) => recordKey.profile(id));
      const res = await this.link!.request('records.get', { keys });
      this.records.ingestAll(res.records);
    }
    await this.subscribe(missing.map((id) => recordKey.profile(id)));
    const presence: PresenceEntry[] = [];
    for (const userIds of chunks(missing, 5000))
      presence.push(...(await this.link!.request('presence.subscribe', { userIds })).presence);
    this.store.set({ presence: Object.fromEntries(presence.map((p) => [p.userId, p.status])) });
  }

  /** Subscribe to record prefixes, at most as many per request as the server takes. */
  private async subscribe(prefixes: string[]) {
    for (const part of chunks(prefixes, 2000))
      await this.link!.request('records.subscribe', { prefixes: part });
  }

  private relevantUsers(): string[] {
    const s = this.state;
    const set = new Set<string>([
      ...s.friends.friends,
      ...s.friends.incoming,
      ...s.friends.outgoing,
      ...s.dms,
    ]);
    for (const space of Object.values(s.spaces)) for (const m of space.members) set.add(m);
    return [...set];
  }

  private profileQueue = new Set<string>();
  private profileBatch?: Promise<void>;

  /**
   * Profiles we don't have yet. Calls close together (one per record of a
   * long member list, say) share one batch of requests.
   */
  private fetchProfiles(userIds: string[]): Promise<void> {
    for (const id of userIds)
      if (!this.records.get(recordKey.profile(id))) this.profileQueue.add(id);
    if (!this.profileQueue.size) return Promise.resolve();
    this.profileBatch ??= new Promise((r) => setTimeout(r, 20)).then(() => {
      this.profileBatch = undefined;
      const ids = [...this.profileQueue];
      this.profileQueue.clear();
      return this.loadProfiles(ids);
    });
    return this.profileBatch;
  }

  private async loadProfiles(userIds: string[]) {
    const link = this.link;
    const missing = userIds.filter((id) => !this.records.get(recordKey.profile(id)));
    if (!missing.length || !link) return;
    for (const part of chunks(missing, 400)) {
      const res = await link
        .request('records.get', { keys: part.map((id) => recordKey.profile(id)) })
        .catch(() => null);
      if (res) this.records.ingestAll(res.records);
    }
    for (const part of chunks(missing, 2000))
      await link
        .request('records.subscribe', { prefixes: part.map((id) => recordKey.profile(id)) })
        .catch(() => {});
    for (const userIds of chunks(missing, 5000)) {
      const p = await link.request('presence.subscribe', { userIds }).catch(() => null);
      if (p)
        this.store.set((s) => ({
          presence: {
            ...s.presence,
            ...Object.fromEntries(p.presence.map((e) => [e.userId, e.status])),
          },
        }));
    }
  }

  // ===========================================================================
  // Derived state from records
  // ===========================================================================

  private onRecordChanged(record: SignedRecord) {
    if (!this.identity) return;
    if (record.kind === 'profile' && (record.body as ProfileBody).deleted) {
      // The cache dropped the account's devices and memberships: rebuild everything.
      this.refreshDerivedState();
      for (const s of this.sessions.values()) s.recheckPeers();
      return;
    }
    this.refreshDerivedState(record);
    if (
      record.kind === 'member' ||
      record.kind === 'device' ||
      record.kind === 'friends' ||
      record.kind === 'space'
    ) {
      for (const s of this.sessions.values()) s.recheckPeers();
    }
    if (record.kind === 'member') {
      // A space joined (or created) on another of our devices.
      const body = (record as SignedRecord<'member'>).body;
      if (body.userId === this.userId && !body.left && !this.state.spaces[body.spaceId])
        void this.adoptSpace(body.spaceId);
    }
    if (record.kind === 'friends' || record.kind === 'member') {
      void this.fetchProfiles(this.relevantUsers()).catch(() => {});
    }
    // Another device changed our list, or someone on an old app changed theirs:
    // store what our copy has that the record lacks.
    if (record.kind === 'friends' && this.friendListDirty())
      void this.queueFriends(() => this.saveFriendList()).catch((err) =>
        this.log('friends list not saved', { err: String(err) }),
      );
  }

  private profileView(r: SignedRecord<'profile'>): ProfileView {
    const userId = r.key.slice('profile:'.length);
    const b = r.body as ProfileBody;
    return {
      userId,
      username: b.username,
      tag: userTag(userId),
      avatar: b.avatar,
      bio: b.bio,
      accent: b.accent,
      encKey: b.encKey,
      publicKey: r.author,
    };
  }

  private refreshDerivedState(changed?: SignedRecord) {
    const me = this.identity?.userId;
    if (!me) return;
    const patch: Partial<ClientState> = {};
    if (!changed || changed.kind === 'profile') {
      const profiles: Record<string, ProfileView> = {};
      for (const r of this.records.list('profile:')) {
        const v = this.profileView(r as SignedRecord<'profile'>);
        profiles[v.userId] = v;
      }
      patch.profiles = profiles;
      patch.me = profiles[me] ?? null;
    }
    if (!changed || changed.kind === 'device') {
      patch.devices = this.records
        .list(recordKey.devicePrefix(me))
        .map((r) => {
          const b = r.body as DeviceBody;
          return {
            deviceId: b.deviceId,
            name: b.name,
            platform: b.platform,
            current: b.deviceId === this.deviceId,
            revoked: !!b.revoked,
            lastUpdated: r.version,
          };
        })
        .sort((a, b) => Number(b.current) - Number(a.current) || b.lastUpdated - a.lastUpdated);
    }
    if (!changed || changed.kind === 'friends' || changed.kind === 'profile') {
      if (!changed || changed.kind === 'friends') this.absorbFriendRecords();
      patch.friends = this.friendsView();
    }
    if (!changed || changed.kind === 'space' || changed.kind === 'member') {
      const spaces: Record<string, SpaceView> = {};
      // A text channel id names the channel everywhere on this device, so two
      // spaces can't both use one. The space joined first keeps it (the
      // member record is signed by this user, so it can't be moved), and one
      // this user owns comes before any other.
      const joinedAt = (r: { key: string; body: unknown }) => {
        const id = r.key.slice('space:'.length);
        if ((r.body as SpaceBody).owner === me) return 0;
        return this.records.get(recordKey.member(id, me))?.version ?? Infinity;
      };
      const claimed = new Set<string>();
      const ordered = this.records
        .list('space:')
        .sort((a, b) => joinedAt(a) - joinedAt(b) || (a.key < b.key ? -1 : 1));
      for (const r of ordered) {
        const id = r.key.slice('space:'.length);
        const body = r.body as SpaceBody;
        if (body.deleted || !isSpaceMember(this.records, id, me)) continue;
        const members = new Set<string>([body.owner]);
        for (const m of this.records.list(recordKey.memberPrefix(id))) {
          const mb = m.body as { userId: string; left?: boolean };
          if (!mb.left && !body.bans.includes(mb.userId)) members.add(mb.userId);
        }
        spaces[id] = {
          id,
          name: body.name,
          icon: body.icon,
          owner: body.owner,
          channels: body.channels.filter((c) => {
            if (c.kind !== 'text') return true;
            if (claimed.has(c.id)) return false;
            claimed.add(c.id);
            return true;
          }),
          members: [...members],
          bans: body.bans,
          admins: spaceAuthorityValid(id, body) ? body.admins : [],
        };
      }
      patch.spaces = spaces;
      // Leave sessions of spaces we no longer belong to.
      for (const [sid, session] of this.sessions) {
        const scope = parseSessionId(sid);
        if (scope && scope.kind !== 'dm' && !spaces[scope.spaceId]) {
          void session.leave();
          this.sessions.delete(sid);
        }
      }
    }
    this.store.set(patch);
  }

  private setOccupancy(occ: VoiceOccupancy) {
    const id = sessionIds.voice(occ.spaceId, occ.channelId);
    this.store.set((s) => {
      const voice = { ...s.voice };
      if (occ.members.length === 0) delete voice[id];
      else voice[id] = occ;
      return { voice };
    });
    void this.fetchProfiles(occ.members).catch(() => {});
  }

  // ===========================================================================
  // Profile and friends
  // ===========================================================================

  private async putRecord(record: SignedRecord) {
    this.records.ingest(record);
    const res = await this.link!.request('records.put', { record });
    if (!res.accepted) {
      // Don't keep a record the server refused (e.g. over a quota): put back
      // the server's version, if it has one.
      this.records.forget(record.key, record.version);
      if (res.current) this.records.ingest(res.current);
      this.refreshDerivedState();
      throw new Error(res.reason ?? 'rejected by server');
    }
  }

  async saveProfile(update: Partial<Omit<ProfileBody, 'encKey'>>) {
    const id = this.identity!;
    const current = (
      this.records.get(recordKey.profile(id.userId)) as SignedRecord<'profile'> | undefined
    )?.body;
    const body: ProfileBody = {
      ...(current ?? { username: 'crocodile' }),
      ...update,
      encKey: id.encPublicKey,
    };
    for (const k of Object.keys(body) as (keyof ProfileBody)[])
      if (body[k] === undefined || body[k] === '') delete body[k];
    if (!body.username) body.username = current?.username ?? 'crocodile';
    const record = signRecord(
      id,
      'profile',
      recordKey.profile(id.userId),
      body,
      this.nextVersion(recordKey.profile(id.userId)),
    );
    this.records.ingest(record);
    await this.putRecord(record).catch((err) => {
      if (this.link?.status === 'connected') throw err;
      // Offline: it is cached locally and published on the next connection.
    });
  }

  private nextVersion(key: string) {
    const existing = this.records.get(key);
    return Math.max(Date.now(), (existing?.version ?? 0) + 1);
  }

  async searchUsers(query: string): Promise<ProfileView[]> {
    const res = await this.link!.request('users.search', { query });
    this.records.ingestAll(res.profiles);
    return res.profiles
      .filter((p) => this.records.get(p.key)?.sig === p.sig)
      .map((p) => this.profileView(p));
  }

  /** Runs changes to the friends list one at a time. */
  private queueFriends<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.friendOps.then(fn, fn);
    this.friendOps = run.catch(() => {});
    return run;
  }

  private friendsView() {
    const gone = new Set(
      (this.records.list('profile:') as SignedRecord<'profile'>[])
        .filter((r) => r.body.deleted)
        .map((r) => r.key.slice('profile:'.length)),
    );
    return friendsView(this.friendList, gone);
  }

  private refreshFriends() {
    void this.platform.kv.set('friend-list', toB64u(encodeFriendList(this.friendList)));
    this.store.set({ friends: this.friendsView() });
    for (const s of this.sessions.values()) s.recheckPeers();
    void this.fetchProfiles(this.relevantUsers()).catch(() => {});
  }

  /**
   * Folds the friends records we hold into our list: our own (sealed, or a
   * readable one from before sealing, which we take over), and readable ones
   * from people whose apps haven't updated yet, which say whether they list us.
   */
  private absorbFriendRecords() {
    const id = this.identity;
    if (!id) return;
    const me = id.userId;
    const ownKey = recordKey.friends(me);
    let list = this.friendList;
    const own = this.records.get(ownKey) as SignedRecord<'friends'> | undefined;
    if (own && isSealedFriends(own.body)) {
      const bytes = openForSelf(id, 'friends', own.body.sealed, ownKey);
      const stored = bytes && decodeFriendList(bytes);
      this.friendListUnreadable = !stored;
      if (stored) {
        list = mergeFriendLists(list, stored);
        this.friendListStored = toB64u(encodeFriendList(stored));
      } else this.log('could not read our friends list');
    } else if (own) {
      const body = own.body as LegacyFriendsBody;
      const legacy: FriendList = new Map();
      // Everyone we listed is told again, now in a note.
      for (const f of body.friends)
        legacy.set(f, { ...emptyEntry(), mine: 'listed', mineAt: own.version });
      for (const b of body.blocked) {
        legacy.set(b, {
          ...emptyEntry(),
          mine: 'blocked',
          mineAt: own.version,
          sentAt: own.version,
        });
      }
      list = mergeFriendLists(list, legacy);
      this.friendListStored = '';
    }
    for (const r of this.records.list('friends:') as SignedRecord<'friends'>[]) {
      if (r.key === ownKey || isSealedFriends(r.body)) continue;
      const other = r.key.slice('friends:'.length);
      const theirs: FriendEntry = {
        ...emptyEntry(),
        theirs: r.body.friends.includes(me),
        theirsAt: r.version,
      };
      list.set(other, mergeEntry(list.get(other) ?? emptyEntry(), theirs));
    }
    this.friendList = list;
  }

  private checkFriendListWritable() {
    if (this.friendListUnreadable)
      throw new Error(
        'Your friends list was saved by a newer version of Crocodile. Update this app to change it.',
      );
  }

  private friendListDirty() {
    return toB64u(encodeFriendList(this.friendList)) !== this.friendListStored;
  }

  /**
   * Stores our list, sealed so that only our own devices can read it. If
   * another device stored a newer one meanwhile, merges with it and retries.
   */
  private async saveFriendList() {
    const id = this.identity;
    const link = this.link;
    if (!id || !link || link.status !== 'connected') return;
    this.checkFriendListWritable();
    const key = recordKey.friends(id.userId);
    for (let attempt = 0; attempt < 3; attempt++) {
      pruneFriendList(this.friendList, Date.now());
      const bytes = encodeFriendList(this.friendList);
      if (toB64u(bytes) === this.friendListStored) return;
      const record = signRecord(
        id,
        'friends',
        key,
        { sealed: sealForSelf(id, 'friends', bytes, key) },
        this.nextVersion(key),
      );
      this.records.ingest(record);
      let res;
      try {
        res = await link.request('records.put', { record });
      } catch (err) {
        // Not stored as far as we know: keep it owed, so it is sent again.
        this.records.forget(record.key, record.version);
        this.friendListStored = '';
        throw err;
      }
      if (res.accepted) return;
      this.records.forget(record.key, record.version);
      this.friendListStored = '';
      // Newer from another device: ingesting it merges it into ours.
      if (res.current && res.current.version >= record.version) this.records.ingest(res.current);
      else throw new Error(res.reason ?? 'rejected by server');
    }
    throw new Error('the friends list kept changing; try again');
  }

  private friendRetryAt = 0;

  /** Try owed notes again in `delayMs`, unless a try is already due sooner. */
  private retryFriendNotes(delayMs: number) {
    const at = Date.now() + delayMs;
    if (this.friendRetryTimer && this.friendRetryAt <= at) return;
    clearTimeout(this.friendRetryTimer);
    this.friendRetryAt = at;
    this.friendRetryTimer = setTimeout(() => {
      this.friendRetryTimer = undefined;
      if ([...this.friendList.values()].some(needsNote))
        void this.queueFriends(() => this.syncFriendList()).catch(() => {});
    }, delayMs);
  }

  /** Saves the list, then tells people about changes they haven't heard of. */
  private async syncFriendList() {
    await this.saveFriendList();
    const id = this.identity;
    const link = this.link;
    if (!id || !link || link.status !== 'connected') return;
    let told = false;
    let failed = false;
    for (const [userId, e] of [...this.friendList]) {
      if (!needsNote(e)) continue;
      try {
        await this.sendFriendNote(userId, e);
      } catch (err) {
        // Kept as owed: tried again soon, then less and less often.
        this.log('friend note not sent', { userId, err: String(err) });
        failed = true;
        continue;
      }
      const cur = this.friendList.get(userId);
      if (cur) this.friendList.set(userId, { ...cur, sentAt: Math.max(cur.sentAt, e.mineAt) });
      told = true;
    }
    if (told) await this.saveFriendList();
    if (failed) {
      this.retryFriendNotes(this.friendRetryDelay);
      this.friendRetryDelay = Math.min(this.friendRetryDelay * 2, FRIEND_NOTE_SWEEP_MS);
    } else this.friendRetryDelay = FRIEND_NOTE_RETRY_MS;
  }

  /**
   * Tells a user whether we list them, in a note sealed to each of their
   * devices. The note is signed with a key made for it alone, and our identity
   * is inside the boxes, so the note itself doesn't say who it is from. (The
   * server we hand it to knows it came from us; the others don't.)
   */
  private async sendFriendNote(userId: string, e: FriendEntry) {
    const profile = this.records.get(recordKey.profile(userId)) as
      SignedRecord<'profile'> | undefined;
    // A deleted account has no one left to tell.
    if (profile?.body.deleted) return;
    // Every device they have: servers' default device quota per account.
    const targets = await this.mailTargets([userId], 100);
    if (targets.length === 0) throw new Error('no devices to tell');
    const payload: NotePayload = {
      type: 'friend',
      to: userId,
      listed: e.mine === 'listed',
      sees: e.theirs,
      at: e.mineAt,
    };
    const plaintext = utf8.encode(JSON.stringify(payload));
    // One note per few devices, so every device of theirs gets a box.
    for (let i = 0; i < targets.length; i += LIMITS.noteBoxesMax) {
      const boxes = targets
        .slice(i, i + LIMITS.noteBoxesMax)
        .map((t) => sealAnonymous(this.identity!, this.deviceId, t, plaintext));
      const author = createIdentity();
      const record = signRecord(author, 'note', recordKey.note(userId, author.userId), { boxes });
      const res = await this.link!.request('records.put', { record });
      if (!res.accepted) throw new Error(res.reason ?? 'note refused');
    }
  }

  /**
   * Notes for us: opens this device's box in each, updates the list, and once
   * the list is stored, deletes the notes from the servers.
   */
  private readNotes(records: SignedRecord[]) {
    return this.queueFriends(async () => {
      const id = this.identity;
      // A list we can't read: leave its notes for an app that can.
      if (!id || this.friendListUnreadable) return;
      const me = id.userId;
      const read: SignedRecord[] = [];
      let changed = false;
      for (const r of records) {
        if (r.kind !== 'note' || !r.key.startsWith(recordKey.notePrefix(me))) continue;
        const body = r.body as NoteBody;
        if (body.deleted) continue;
        const box = body.boxes?.find((b) => b.to === this.peer);
        // No box for this device (linked later): our other devices handle it.
        if (!box) continue;
        const opened = openAnonymous(
          { peer: this.peer },
          (k) => this.prekeys.find((p) => p.id === k),
          box,
          userIdFromKey,
        );
        if (!opened) {
          this.log('could not open note', { key: r.key });
          continue;
        }
        read.push(r);
        let payload: NotePayload;
        try {
          payload = NotePayload.parse(JSON.parse(utf8.decode(opened.plaintext)));
        } catch {
          continue;
        }
        if (payload.to !== me || opened.fromUser === me) continue;
        if (this.applyFriendNote(opened.fromUser, payload)) changed = true;
      }
      if (changed) {
        this.refreshFriends();
        await this.syncFriendList();
      }
      if (this.friendListDirty()) return;
      for (const r of read) {
        await this.link
          ?.request('records.put', {
            record: signRecord(
              id,
              'note',
              r.key,
              { boxes: [], deleted: true },
              Math.max(Date.now(), r.version + 1),
            ),
          })
          .catch(() => {});
      }
    }).catch((err) => this.log('notes not read', { err: String(err) }));
  }

  private applyFriendNote(from: string, note: NotePayload): boolean {
    const e = { ...(this.friendList.get(from) ?? emptyEntry()) };
    if (note.at <= e.theirsAt) return false;
    e.theirs = note.listed;
    e.theirsAt = note.at;
    // They have an old idea of us (a note of ours got lost): tell them again.
    if (note.sees !== (e.mine === 'listed') && e.mineAt > 0 && !needsNote(e))
      e.mineAt = Math.max(Date.now(), e.mineAt + 1);
    this.friendList.set(from, e);
    return true;
  }

  /**
   * Sets whether we list (or block) someone. The change shows at once and is
   * stored and sent when connected (now, or on the next connection).
   */
  private setMine(userId: string, mine: Mine) {
    return this.queueFriends(async () => {
      if (userId === this.userId) throw new Error("You can't add yourself");
      this.checkFriendListWritable();
      const prev = this.friendList.get(userId) ?? emptyEntry();
      if (prev.mine === mine) return;
      if (mine !== 'none' && countMine(this.friendList, mine) >= LIMITS.friendsMax)
        throw new Error(
          mine === 'listed'
            ? `You can have at most ${LIMITS.friendsMax} friends and requests`
            : `You can block at most ${LIMITS.friendsMax} people`,
        );
      const e = { ...prev, mine, mineAt: Math.max(Date.now(), prev.mineAt + 1) };
      // Blocking or unblocking someone we don't list changes nothing for them.
      if (!needsNote(prev) && (prev.mine === 'listed') === (mine === 'listed')) e.sentAt = e.mineAt;
      this.friendList.set(userId, e);
      this.refreshFriends();
      await this.syncFriendList();
    });
  }

  /** Sends a friend request, or accepts one if they already asked. */
  addFriend(userId: string) {
    return this.setMine(userId, 'listed');
  }

  removeFriend(userId: string) {
    return this.setMine(userId, 'none');
  }

  block(userId: string) {
    return this.setMine(userId, 'blocked');
  }

  unblock(userId: string) {
    return this.setMine(userId, 'none');
  }

  async setStatus(status: Settings['status']) {
    await this.updateSettings({ status });
  }

  // ===========================================================================
  // Spaces
  // ===========================================================================

  async createSpace(name: string, icon?: string): Promise<string> {
    const id = this.identity!;
    const nonce = randomId();
    const spaceId = spaceIdFor(id.publicKey, nonce);
    const body: SpaceBody = {
      name: name.trim(),
      owner: id.userId,
      nonce,
      admins: [],
      bans: [],
      channels: [
        { id: randomId(), name: 'general', kind: 'text' },
        { id: randomId(), name: 'General', kind: 'voice' },
      ],
      ...(icon ? { icon } : {}),
    };
    await this.putRecord(signRecord(id, 'space', recordKey.space(spaceId), body));
    await this.putRecord(
      signRecord(id, 'member', recordKey.member(spaceId, id.userId), {
        spaceId,
        userId: id.userId,
      }),
    );
    await this.afterSpaceJoined(spaceId);
    return spaceId;
  }

  private wanted = new Set<string>();
  private wantedTimer?: ReturnType<typeof setTimeout>;

  /** Fetch records that others depend on (e.g. the invite behind a membership). */
  private fetchWanted(keys: string[]) {
    for (const k of keys) this.wanted.add(k);
    if (this.wantedTimer) return;
    this.wantedTimer = setTimeout(() => {
      this.wantedTimer = undefined;
      const batch = [...this.wanted].slice(0, 400);
      for (const k of batch) this.wanted.delete(k);
      void this.link
        ?.request('records.get', { keys: batch })
        .then((res) => this.records.ingestAll(res.records))
        .catch(() => {});
    }, 20);
  }

  private adopting = new Set<string>();

  private async adoptSpace(spaceId: string) {
    if (this.adopting.has(spaceId) || !this.link) return;
    this.adopting.add(spaceId);
    try {
      const res = await this.link.request('records.get', { keys: [recordKey.space(spaceId)] });
      this.records.ingestAll(res.records);
      if (this.state.spaces[spaceId]) await this.afterSpaceJoined(spaceId);
    } catch (err) {
      this.log('could not adopt space', { spaceId, err: String(err) });
    } finally {
      this.adopting.delete(spaceId);
    }
  }

  private async afterSpaceJoined(spaceId: string) {
    await this.link!.request('records.subscribe', {
      prefixes: [recordKey.space(spaceId), recordKey.memberPrefix(spaceId)],
    });
    const members = await this.link!.request('records.list', {
      prefix: recordKey.memberPrefix(spaceId),
    });
    this.records.ingestAll(members.records);
    const spaceIds = Object.keys(this.state.spaces);
    const { voice } = await this.link!.request('voice.watch', { spaceIds });
    for (const v of voice) this.setOccupancy(v);
    await this.fetchProfiles(this.state.spaces[spaceId]?.members ?? []);
    const session = this.ensureSession(sessionIds.space(spaceId));
    await session
      .join()
      .catch((err) => this.log('space session join failed', { err: String(err) }));
  }

  /**
   * Change a space, as its owner or one of its admins. The owner's version
   * carries a fresh signature on the admin list whenever it changes; an
   * admin's keeps the owner's list and signature as they are.
   */
  async updateSpace(spaceId: string, mutate: (b: SpaceBody) => SpaceBody) {
    const key = recordKey.space(spaceId);
    const r = this.records.get(key) as SignedRecord<'space'> | undefined;
    if (!r) throw new Error('unknown space');
    const me = this.userId;
    if (
      !canManageSpace(r.body, me) ||
      (r.body.owner !== me && !spaceAuthorityValid(spaceId, r.body))
    )
      throw new Error('only the owner or an admin can change this space');
    let body = mutate(structuredClone(r.body));
    if (r.body.owner === me) {
      const admins = [...new Set(body.admins)].filter((u) => u !== me);
      const unchanged =
        !!r.body.authority &&
        admins.length === r.body.admins.length &&
        admins.every((u, i) => u === r.body.admins[i]);
      body = {
        ...body,
        admins,
        authority: unchanged
          ? r.body.authority
          : signSpaceAuthority(
              this.identity!,
              spaceId,
              admins,
              Math.max(Date.now(), (r.body.authority?.at ?? 0) + 1),
            ),
      };
    } else {
      // What only the owner decides stays as the owner left it.
      const { owner, nonce, admins, authority } = r.body;
      body = { ...body, owner, nonce, admins, authority, deleted: r.body.deleted };
      if (body.deleted === undefined) delete body.deleted;
      body.bans = body.bans.filter((u) => u !== owner && !admins.includes(u));
    }
    await this.putRecord(signRecord(this.identity!, 'space', key, body, this.nextVersion(key)));
  }

  private spaceOwner(spaceId: string): string | undefined {
    return (this.records.get(recordKey.space(spaceId)) as SignedRecord<'space'> | undefined)?.body
      .owner;
  }

  /** Let a member change the space, or stop them (owner only). */
  async setAdmin(spaceId: string, userId: string, admin: boolean) {
    if (this.spaceOwner(spaceId) !== this.userId)
      throw new Error('only the owner can choose admins');
    return this.updateSpace(spaceId, (b) => ({
      ...b,
      admins: admin ? [...b.admins, userId] : b.admins.filter((u) => u !== userId),
    }));
  }

  addChannel(spaceId: string, name: string, kind: ChannelKind) {
    const clean = kind === 'text' ? name.trim().toLowerCase().replace(/\s+/g, '-') : name.trim();
    return this.updateSpace(spaceId, (b) => ({
      ...b,
      channels: [...b.channels, { id: randomId(), name: clean, kind }],
    }));
  }

  renameChannel(spaceId: string, channelId: string, name: string) {
    return this.updateSpace(spaceId, (b) => ({
      ...b,
      channels: b.channels.map((c) => (c.id === channelId ? { ...c, name: name.trim() } : c)),
    }));
  }

  removeChannel(spaceId: string, channelId: string) {
    return this.updateSpace(spaceId, (b) => ({
      ...b,
      channels: b.channels.filter((c) => c.id !== channelId),
    }));
  }

  banMember(spaceId: string, userId: string) {
    return this.updateSpace(spaceId, (b) => ({ ...b, bans: [...new Set([...b.bans, userId])] }));
  }

  async deleteSpace(spaceId: string) {
    if (this.spaceOwner(spaceId) !== this.userId)
      throw new Error('only the owner can delete a space');
    return this.updateSpace(spaceId, (b) => ({ ...b, deleted: true }));
  }

  /**
   * An invite to share: one of ours for this space that is still valid for at
   * least a day, or a new one. Reusing keeps the space under the server's
   * invite quota.
   */
  async shareInvite(spaceId: string): Promise<string> {
    const me = this.identity!.publicKey;
    const minExpiry = Date.now() + 24 * 3600_000;
    const reusable = (this.records.list('invite:') as SignedRecord<'invite'>[])
      .filter(
        (r) =>
          r.author === me &&
          r.body.spaceId === spaceId &&
          !r.body.revoked &&
          (r.body.expiresAt === null || r.body.expiresAt > minExpiry),
      )
      .sort((a, b) => b.version - a.version)[0];
    return reusable ? reusable.body.code : this.createInvite(spaceId);
  }

  /** Creates an invite code others can use to join. */
  async createInvite(
    spaceId: string,
    expiresInMs: number | null = 7 * 24 * 3600_000,
  ): Promise<string> {
    const code = randomId(5);
    await this.putRecord(
      signRecord(this.identity!, 'invite', recordKey.invite(code), {
        spaceId,
        code,
        expiresAt: expiresInMs === null ? null : Date.now() + expiresInMs,
      }),
    );
    return code;
  }

  /**
   * What an invite leads to, for showing it in a chat before anyone joins:
   * the space's name and icon, whether we are in it already, and whether it
   * still works. Null if the server doesn't know the invite.
   */
  async previewInvite(input: string): Promise<InvitePreview | null> {
    const code = inviteCodeOf(input);
    const key = recordKey.invite(code);
    const res = await this.link!.request('records.get', { keys: [key] });
    const claimed = res.records[0] as SignedRecord<'invite'> | undefined;
    if (!claimed || claimed.kind !== 'invite' || claimed.key !== key) return null;
    // Only what the cache accepts counts: the invite must be signed by its
    // space's owner (or an admin), so a server can't point it elsewhere.
    // Checked like any record, but kept only in memory: we haven't joined.
    const spaceKey = recordKey.space(claimed.body.spaceId);
    if (!this.records.get(spaceKey)) {
      const got = await this.link!.request('records.get', { keys: [spaceKey] });
      this.records.ingestAll(got.records, false);
    }
    this.records.ingest(claimed, false);
    const invite = this.records.get(key) as SignedRecord<'invite'> | undefined;
    if (!invite || invite.body.code !== code) return null;
    const { spaceId } = invite.body;
    const space = this.records.get(recordKey.space(spaceId)) as SignedRecord<'space'> | undefined;
    if (!space || space.body.deleted) return null;
    const expired =
      !!invite.body.revoked ||
      (invite.body.expiresAt !== null && invite.body.expiresAt < Date.now());
    return {
      code,
      spaceId,
      name: space.body.name,
      ...(space.body.icon ? { icon: space.body.icon } : {}),
      joined: !!this.state.spaces[spaceId],
      expired,
    };
  }

  /** Accepts "abcd1234", "croc://join/abcd1234" or "https://…/join/abcd1234". */
  async joinWithInvite(input: string): Promise<string> {
    const code = inviteCodeOf(input);
    const res = await this.link!.request('records.get', { keys: [recordKey.invite(code)] });
    const invite = res.records[0] as SignedRecord<'invite'> | undefined;
    if (!invite) throw new Error('That invite does not exist (yet). Check the code and try again.');
    const { spaceId } = invite.body;
    const space = await this.link!.request('records.get', { keys: [recordKey.space(spaceId)] });
    this.records.ingestAll([...space.records, invite]);
    const me = this.userId;
    const key = recordKey.member(spaceId, me);
    await this.putRecord(
      signRecord(
        this.identity!,
        'member',
        key,
        { spaceId, userId: me, inviteCode: code },
        this.nextVersion(key),
      ),
    );
    await this.afterSpaceJoined(spaceId);
    return spaceId;
  }

  async leaveSpace(spaceId: string) {
    const me = this.userId;
    const key = recordKey.member(spaceId, me);
    await this.putRecord(
      signRecord(
        this.identity!,
        'member',
        key,
        { spaceId, userId: me, left: true },
        this.nextVersion(key),
      ),
    );
  }

  // ===========================================================================
  // Sessions
  // ===========================================================================

  private ensureSession(sessionId: string): GroupSession {
    let session = this.sessions.get(sessionId);
    if (session) return session;
    if (!this.transportFactory) throw new Error('This device cannot open peer-to-peer connections');
    const scope = parseSessionId(sessionId);
    const withVoice =
      scope?.kind === 'voice' || scope?.kind === 'dm' ? this.voiceEngine : undefined;
    session = new GroupSession(
      sessionId,
      {
        identity: this.identity!,
        peer: this.peer,
        link: () => this.link!,
        platform: this.platform,
        messages: this.platform.messages,
        iceServers: () => this.stun.map((urls) => ({ urls })),
        caps: () => this.caps(),
        seal: (to, pt) => this.sealTo(to, pt),
        open: (box) => this.openBox(box),
        isAllowedPeer: (sid, p) => this.isAllowedPeer(sid, p),
        refreshPeer: (sid, p) => this.refreshPeer(sid, p),
        relay: {
          allowed: () => this.state.settings.allowServerRelay,
          request: async (sid) =>
            (await this.link!.request('relay.request', { sessionId: sid })).grant,
        },
        historyChannels: (sid) => this.historyChannels(sid),
        acceptMessage: (sid, m) => this.acceptMessage(sid, m),
        outbox: {
          pending: (sid) => this.outbox.forSession(sid),
          acked: (ids) => this.onAcked(ids),
        },
        syncCursor: (ch) => this.syncCursor(ch),
        log: (m, e) => this.log(m, { session: sessionId, ...e }),
      },
      this.transportFactory,
      withVoice
        ? {
            micTrack: () => withVoice.micTrack(),
            frameCrypto: (k) => withVoice.frameCrypto(k),
            // Only the call we are in shows our camera or screen.
            outgoing: () =>
              this.state.voiceSession === sessionId
                ? withVoice.outgoing()
                : { camera: null, screen: null },
          }
        : undefined,
    );
    session.on('update', () => this.publishSession(session!));
    session.on('screenAudio', ({ slot, track }) =>
      this.voiceEngine?.playSlot(sessionId, `screen${slot}`, track, () => {
        const stream = session!.screenAudioSlots[slot];
        return stream ? peerIds.user(streamIds.peer(stream)) : null;
      }),
    );
    session.on('track', (ev) =>
      this.voiceEngine?.playSlot(sessionId, ev.slot, ev.track, () => {
        const peer = session!.slots[ev.slot];
        return peer ? peerIds.user(peer) : null;
      }),
    );
    session.on('call', ({ userId, action, video }) =>
      this.onCallSignal(sessionId, userId, action, video),
    );
    session.on('file', ({ from, payload }) => this.files?.onMessage(sessionId, from, payload));
    session.on('update', () => this.files?.sessionChanged(sessionId));
    session.on('typing', ({ userId, ch }) => {
      const until = Date.now() + 6000;
      this.store.set((s) => ({
        typing: { ...s.typing, [ch]: { ...(s.typing[ch] ?? {}), [userId]: until } },
      }));
    });
    if (scope?.kind === 'voice') session.isVoice = true;
    this.sessions.set(sessionId, session);
    return session;
  }

  private publishSession(session: GroupSession) {
    // A session we replaced (a DM call back to text) must not overwrite its successor.
    if (this.sessions.get(session.sessionId) !== session) return;
    const st: SessionState | null = session.state;
    const peers = [...session.peers.values()];
    const users = (ids: string[]) => [...new Set(ids.map((p) => peerIds.user(p)))];
    const me = this.userId;
    const grant = session.relayGrant;
    // Our own voice state is known locally (the relay does not echo us).
    const selfMuted =
      session.isVoice && this.state.voiceSession === session.sessionId && this.state.muted
        ? [me]
        : [];
    const selfDeaf =
      session.isVoice && this.state.voiceSession === session.sessionId && this.state.deafened
        ? [me]
        : [];
    const view: SessionView = {
      id: session.sessionId,
      status: session.status,
      host: st?.host ? peerIds.user(st.host) : null,
      backup: st?.backup ? peerIds.user(st.backup) : null,
      epoch: st?.epoch ?? 0,
      members: users(st?.members.map((m) => m.peer) ?? []),
      peers: users(peers.map((p) => p.id)).filter((u) => u !== me),
      speaking: users(session.speaking),
      muted: [...users(peers.filter((p) => p.muted).map((p) => p.id)), ...selfMuted],
      deafened: [...users(peers.filter((p) => p.deafened).map((p) => p.id)), ...selfDeaf],
      iAmHost: session.isHost,
      relay: grant ? { server: grant.server, expiresAt: grant.expiresAt } : null,
      route: session.status === 'connected' ? session.route : null,
      trouble: session.trouble,
      connectedAt: session.connectedAt,
      networks: (st?.members ?? []).map((m) => ({
        user: peerIds.user(m.peer),
        nat: m.caps.nat,
        host: m.peer === st?.host,
        self: m.peer === this.peer,
      })),
      attempts: session.attempts.map((a) => ({
        ...a,
        host: peerIds.user(a.host),
        steps: [...a.steps],
        ...(a.end ? { end: { ...a.end } } : {}),
      })),
      // Apps (and hosts) from before calls said who is in them leave it unknown.
      inCall: [
        ...(session.isVoice ? [me] : []),
        ...users(peers.filter((p) => p.voice).map((p) => p.id)).filter((u) => u !== me),
      ],
      latency: Object.fromEntries([
        ...peers
          .filter((p) => p.rtt !== undefined && peerIds.user(p.id) !== me)
          .map((p) => [peerIds.user(p.id), p.rtt!] as const),
        ...(session.isVoice && session.rttMs !== null ? [[me, session.rttMs] as const] : []),
      ]),
      video: this.videoView(session),
    };
    this.store.set((s) => ({ sessions: { ...s.sessions, [session.sessionId]: view } }));
    this.noteTrouble(view);
    if (this.state.voiceSession === session.sessionId) this.followCall(view, session.welcomed);
  }

  private videoView(session: GroupSession): SessionView['video'] {
    const streams: VideoStreamView[] = [];
    const inThisCall = this.state.voiceSession === session.sessionId;
    const out = inThisCall ? this.voiceEngine?.outgoing() : undefined;
    const blocked = session.videoBlocked;
    if (out && session.videoUsable) {
      if (out.camera)
        streams.push({
          id: streamIds.make(this.peer, 'camera'),
          userId: this.userId,
          kind: 'camera',
          audio: false,
          mine: true,
          state: 'live',
        });
      if (out.screen)
        streams.push({
          id: streamIds.make(this.peer, 'screen'),
          userId: this.userId,
          kind: 'screen',
          audio: !!out.screen.audio,
          mine: true,
          state: 'live',
        });
    }
    for (const p of session.peers.values()) {
      if (p.id === this.peer) continue;
      for (const kind of ['screen', 'camera'] as const) {
        if (kind === 'camera' ? !p.camera : !p.screen) continue;
        const id = streamIds.make(p.id, kind);
        const watched = kind === 'camera' || session.watchedScreens.includes(id);
        const slot = session.videoSlots.indexOf(id);
        streams.push({
          id,
          userId: peerIds.user(p.id),
          kind,
          audio: kind === 'screen' && !!p.screen?.audio,
          mine: false,
          state: !watched
            ? 'off'
            : session.pausedStreams.includes(id)
              ? 'paused'
              : slot >= 0 && session.videoStream(id) && session.videoShowingNow(id)
                ? 'live'
                : 'loading',
        });
      }
    }
    return {
      blocked: inThisCall ? blocked : null,
      ready: session.mediaReady && session.route !== null,
      streams,
    };
  }

  // ===========================================================================
  // Camera and screen
  // ===========================================================================

  private onOutgoingVideo(out: OutgoingVideo) {
    this.store.set({
      camera: !!out.camera,
      screenShare: out.screen ? { quality: out.screen.quality, audio: !!out.screen.audio } : null,
    });
    const id = this.state.voiceSession;
    const session = id ? this.sessions.get(id) : undefined;
    if (session) {
      session.refreshVideo();
      this.publishSession(session);
    }
  }

  /** Show our camera in the call we are in, or stop. */
  async setCamera(on: boolean, deviceId?: string) {
    const engine = this.voiceEngine;
    if (!on) return engine?.stopCamera();
    if (!engine) throw new Error('Video is not available on this device');
    if (!this.state.voiceSession) throw new Error('Join a call to show your camera');
    await engine.startCamera(deviceId);
  }

  /** Share a screen or window in the call we are in. */
  async shareScreen(request: ScreenRequest) {
    const engine = this.voiceEngine;
    if (!engine?.canShareScreen) throw new Error('This device cannot share its screen');
    if (!this.state.voiceSession) throw new Error('Join a call to share your screen');
    await engine.startScreen(request);
  }

  stopScreenShare() {
    this.voiceEngine?.stopScreen();
  }

  /** What we show, for our own preview. */
  localVideo(kind: MediaKind): MediaStream | null {
    const out = this.voiceEngine?.outgoing();
    const track = kind === 'camera' ? out?.camera : out?.screen?.video;
    return track && typeof MediaStream !== 'undefined' ? new MediaStream([track]) : null;
  }

  /** Start or stop watching someone's shared screen. */
  watchScreen(sessionId: string, stream: string, on: boolean) {
    this.sessions.get(sessionId)?.watchScreen(stream, on);
  }

  /** The picture of someone's camera or screen in a call, while we get it. */
  videoStream(sessionId: string, stream: string): MediaStream | null {
    return this.sessions.get(sessionId)?.videoStream(stream) ?? null;
  }

  /** Who was in the call we are in, at the last update (users, us excluded). */
  private callOthers = new Set<string>();
  /** The DM call we answered, or whose callee answered. */
  private callAnswered: string | null = null;
  /** Users who were in the DM call and dropped out of the conversation altogether. */
  private callMissing = new Set<string>();
  /** Someone in this call has said they are in it (apps from 0.6 on do). */
  private callPresenceSeen = false;
  private callLostTimer?: ReturnType<typeof setTimeout>;

  /**
   * Keep the call's live state honest: it is live once connected and, in a
   * DM, once the other side is in it; it ends when they hang up, or when
   * they stay gone. Others joining and leaving are events (sounds).
   */
  private followCall(view: SessionView, welcomed: boolean) {
    const me = this.userId;
    const isDm = view.id.startsWith('dm:');
    // Who is there is known once the host has said hello on this connection.
    const connected = view.status === 'connected' && welcomed;
    if (!connected) return;
    const others = new Set(view.inCall.filter((u) => u !== me));
    const before = this.callOthers;
    const joined = [...others].filter((u) => !before.has(u));
    const left = [...before].filter((u) => !others.has(u));
    if (joined.length) this.emit('call', { sessionId: view.id, event: 'joined' });
    if (left.length) this.emit('call', { sessionId: view.id, event: 'left' });
    this.callOthers = others;
    for (const u of others) this.callMissing.delete(u);

    // Once the other side has said it is in the call, its presence decides;
    // only an older app that never says counts as live on being answered.
    if (others.size > 0) this.callPresenceSeen = true;
    const live =
      !isDm || others.size > 0 || (this.callAnswered === view.id && !this.callPresenceSeen);
    if (live && !this.state.callLiveSince) {
      this.store.set({ callLiveSince: Date.now() });
      this.emit('call', { sessionId: view.id, event: 'live' });
    } else if (!live && this.state.callLiveSince) {
      this.store.set({ callLiveSince: null });
    }

    if (!isDm) return;
    for (const u of left) this.callMissing.add(u);
    if (others.size > 0) {
      this.callMissing.clear();
      clearTimeout(this.callLostTimer);
      this.callLostTimer = undefined;
      return;
    }
    if ([...this.callMissing].some((u) => view.peers.includes(u))) {
      // Connected, but out of the call: they hung up.
      void this.endCall(view.id, 'Call ended');
      return;
    }
    if (this.callMissing.size === 0 || this.callLostTimer) return;
    // Gone altogether: their app or network may be back in a moment.
    this.callLostTimer = setTimeout(() => {
      this.callLostTimer = undefined;
      const v = this.state.sessions[view.id];
      if (this.state.voiceSession === view.id && v && !v.inCall.some((u) => u !== me))
        void this.endCall(view.id, 'Call ended: the connection was lost');
    }, CALL_LOST_GRACE_MS);
    this.callLostTimer.unref?.();
  }

  /** The call ended from the other side: leave it too. */
  private async endCall(sessionId: string, notice: string) {
    if (this.state.voiceSession !== sessionId) return;
    this.reportInfo(notice);
    this.emit('call', { sessionId, event: 'ended' });
    await this.leaveVoice({ quiet: true });
  }

  /** Offer the relay when a session can't connect directly and it's off. */
  private noteTrouble(view: SessionView) {
    const current = this.state.connectionTrouble;
    const stuck =
      view.trouble &&
      !view.relay &&
      !this.state.settings.allowServerRelay &&
      !this.troubleDismissed.has(view.id);
    if (stuck && !current) {
      const peer = this.sessions.get(view.id)?.unreachable;
      this.store.set({
        connectionTrouble: { sessionId: view.id, with: peer ? peerIds.user(peer) : view.host },
      });
    } else if (!stuck && current?.sessionId === view.id) {
      this.store.set({ connectionTrouble: null });
    }
  }

  sessionFor(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  private async caps(): Promise<HostCaps> {
    const extra: Partial<HostCaps> = (await this.platform.capabilities?.().catch(() => ({}))) ?? {};
    const settings = this.state.settings;
    return {
      canHost: !!this.platform.relay && settings.allowHosting && (extra.canHost ?? true),
      platform: this.platform.platform,
      nat: extra.nat ?? 'unknown',
      ...((settings.uplinkKbps ?? extra.uplinkKbps)
        ? { uplinkKbps: settings.uplinkKbps ?? extra.uplinkKbps }
        : {}),
      ...(extra.cpuCores ? { cpuCores: extra.cpuCores } : {}),
      ...(extra.onBattery !== undefined ? { onBattery: extra.onBattery } : {}),
      ...(this.state.server ? { rttMs: Math.round(this.state.server.rttMs) } : {}),
    };
  }

  /** Current, unrevoked device record of a peer, fetching it if needed. */
  private async deviceOf(peer: string): Promise<DeviceBody | null> {
    const userId = peerIds.user(peer);
    const key = recordKey.device(userId, peerIds.device(peer));
    let r = this.records.get(key) as SignedRecord<'device'> | undefined;
    if (!r || r.body.prekey.expiresAt < Date.now()) {
      const res = await this.link?.request('records.get', { keys: [key] }).catch(() => null);
      if (res) this.records.ingestAll(res.records);
      void this.link
        ?.request('records.subscribe', { prefixes: [recordKey.devicePrefix(userId)] })
        .catch(() => {});
      r = this.records.get(key) as SignedRecord<'device'> | undefined;
    }
    if (!r || r.body.revoked) return null;
    return r.body;
  }

  private async sealTo(peer: string, plaintext: Uint8Array): Promise<SealedBox | null> {
    const device = await this.deviceOf(peer);
    if (!device) return null;
    return sealToDevice(this.identity!, this.deviceId, { peer, prekey: device.prekey }, plaintext);
  }

  private openBox(box: SealedBox): { from: string; plaintext: Uint8Array } | null {
    const opened = openSealed(
      { peer: this.peer },
      (id) => this.prekeys.find((k) => k.id === id),
      box,
      userIdFromKey,
    );
    return opened ? { from: opened.from, plaintext: opened.plaintext } : null;
  }

  private async refreshPeer(sessionId: string, peer: string) {
    const scope = parseSessionId(sessionId);
    if (!scope || !this.link) return;
    const userId = peerIds.user(peer);
    const keys = [recordKey.device(userId, peerIds.device(peer))];
    if (scope.kind !== 'dm')
      keys.push(recordKey.member(scope.spaceId, userId), recordKey.space(scope.spaceId));
    const res = await this.link.request('records.get', { keys });
    this.records.ingestAll(res.records);
  }

  /** `peer` is `<userId>.<deviceId>`; bare user ids are accepted too. */
  isAllowedPeer(sessionId: string, peer: string): boolean {
    const scope = parseSessionId(sessionId);
    if (!scope) return false;
    const userId = peerIds.user(peer);
    if (peer.includes('.')) {
      const device = this.records.get(recordKey.device(userId, peerIds.device(peer))) as
        SignedRecord<'device'> | undefined;
      if (device?.body.revoked) return false;
    }
    if (scope.kind === 'dm') {
      if (!scope.users.includes(userId)) return false;
      return !this.state.friends.blocked.includes(userId);
    }
    return isSpaceMember(this.records, scope.spaceId, userId);
  }

  // ===========================================================================
  // Devices and linking
  // ===========================================================================

  /** Remove a device from this account (permanent). */
  async revokeDevice(deviceId: string) {
    const id = this.identity!;
    const key = recordKey.device(id.userId, deviceId);
    const current = this.records.get(key) as SignedRecord<'device'> | undefined;
    if (!current) throw new Error('unknown device');
    await this.putRecord(
      signRecord(id, 'device', key, { ...current.body, revoked: true }, this.nextVersion(key)),
    );
  }

  async renameDevice(name: string) {
    await this.updateSettings({ deviceName: name.trim() || undefined });
    await this.ensureDeviceRecord();
  }

  private linkTemp?: { identity: Identity; conn: CoordinatorConnection; claimedBy?: string };

  /**
   * New device: get a short code to type on a device that is already signed
   * in. Resolves when the account arrives (the user must also compare the
   * security code shown on both screens).
   */
  async startDeviceLink(): Promise<void> {
    this.cancelDeviceLink();
    const temp = createIdentity();
    const urls = [...this.state.settings.preferredServers, ...(this.config.preferredServers ?? [])];
    let conn: CoordinatorConnection | undefined;
    const candidates = urls.length
      ? urls
      : await import('./server-selection').then(async (m) => {
          const { servers, loads } = await m.fetchServerList(
            this.config.directories,
            this.platform.kv,
            this.platform.fetch,
          );
          return (await m.rankServers(servers, loads, this.platform.fetch)).map((r) => r.info.url);
        });
    for (const url of candidates) {
      try {
        conn = await CoordinatorConnection.connect({
          url,
          identity: temp,
          deviceId: randomDeviceId(),
          platform: this.platform.platform,
          version: this.platform.appVersion,
          WebSocketImpl: this.platform.WebSocketImpl,
        });
        break;
      } catch {
        /* try next */
      }
    }
    if (!conn) {
      this.store.set({
        linking: { role: 'new', step: 'error', error: 'No coordination server reachable' },
      });
      return;
    }
    this.linkTemp = { identity: temp, conn };
    const { code } = await conn.request('link.open', { encKey: temp.encPublicKey });
    this.store.set({ linking: { role: 'new', step: 'waiting', code: code.toUpperCase() } });
    conn.on('link_claimed', ({ key, userId }) => {
      if (!this.linkTemp || !keyMatchesUserId(key, userId)) return;
      this.linkTemp.claimedBy = userId;
      this.store.set({
        linking: {
          role: 'new',
          step: 'claimed',
          code: code.toUpperCase(),
          securityCode: linkSecurityCode(temp.publicKey, temp.encPublicKey, key),
          account: userId,
        },
      });
    });
    conn.on('link_payload', ({ box }) => void this.onLinkPayload(box));
  }

  private async onLinkPayload(box: LinkBox) {
    const t = this.linkTemp;
    if (!t?.claimedBy) return;
    const seed = openLink(t.identity, box, t.claimedBy);
    if (!seed) {
      this.store.set({
        linking: { role: 'new', step: 'error', error: 'The account could not be verified.' },
      });
      return;
    }
    t.conn.close();
    this.linkTemp = undefined;
    this.store.set({ linking: { role: 'new', step: 'done' } });
    await this.adoptIdentity(identityFromSeed(seed));
  }

  cancelDeviceLink() {
    this.linkTemp?.conn.close();
    this.linkTemp = undefined;
    this.store.set({ linking: null });
  }

  private pendingLinkTarget?: { code: string; encKey: string };

  /** Existing device: enter the code the new device shows. */
  async claimDeviceLink(code: string): Promise<string> {
    const res = await this.link!.request('link.claim', { code });
    // The code covers the key the account will be sealed to: a server that
    // swapped it would make the two devices show different codes.
    const securityCode = linkSecurityCode(res.key, res.encKey, this.identity!.publicKey);
    this.pendingLinkTarget = { code, encKey: res.encKey };
    this.store.set({ linking: { role: 'existing', step: 'confirm', code, securityCode } });
    return securityCode;
  }

  /** Existing device: the security codes match, send the account over. */
  async confirmDeviceLink() {
    const t = this.pendingLinkTarget;
    const linking = this.state.linking;
    if (!t || linking?.role !== 'existing') return;
    const box = sealLink(this.identity!, t.encKey, this.identity!.seed);
    await this.link!.request('link.send', { code: t.code, box });
    this.pendingLinkTarget = undefined;
    this.store.set({ linking: { ...linking, step: 'sent' } });
  }

  /** Server relay: extend after the one-hour window ended (explicit user action). */
  async extendRelay(sessionId: string) {
    this.store.set({ relayEnded: null });
    await this.sessions.get(sessionId)?.useServerRelay();
  }

  dismissRelayNotice() {
    this.store.set({ relayEnded: null });
  }

  private networkCheck?: Promise<void>;

  /**
   * Checks what the network allows for direct connections, using the
   * coordination server's STUN ports. Runs on every server connection;
   * `fresh` re-tests instead of using a recent result.
   */
  checkNetwork(fresh = false): Promise<void> {
    const probe = this.platform.probeNetwork;
    if (!probe) return Promise.resolve();
    if (this.networkCheck) return this.networkCheck;
    this.store.set((s) => ({
      network: s.network
        ? { ...s.network, checking: true }
        : { verdict: 'unknown', checkedAt: 0, checking: true },
    }));
    this.networkCheck = probe(fresh)
      .then((result) => {
        const verdict = networkVerdict(result);
        const { items, reason } = networkChecklist(result);
        // Addresses stay out of the log (it goes into bug reports).
        this.log('network check', {
          nat: result.nat,
          udp: result.udp,
          verdict,
          checks: Object.fromEntries(items.map((i) => [i.id, i.status])),
        });
        this.store.set({
          network: { verdict, checking: false, checkedAt: Date.now(), checks: items, reason },
        });
      })
      .catch((err) => {
        this.log('network check failed', { err: String(err) });
        this.store.set((s) => ({
          network: {
            verdict: 'unknown',
            checking: false,
            checkedAt: s.network?.checkedAt ?? 0,
            reason: `The check itself failed (${String(err)}).`,
          },
        }));
      })
      .finally(() => {
        this.networkCheck = undefined;
      });
    return this.networkCheck;
  }

  /** Turns the relay on and reconnects a session that can't connect directly. */
  async useRelay(sessionId: string) {
    this.store.set({ connectionTrouble: null });
    if (!this.state.settings.allowServerRelay)
      await this.updateSettings({ allowServerRelay: true });
    await this.sessions.get(sessionId)?.useServerRelay();
  }

  dismissConnectionTrouble() {
    const trouble = this.state.connectionTrouble;
    if (trouble) this.troubleDismissed.add(trouble.sessionId);
    this.store.set({ connectionTrouble: null });
  }

  private troubleDismissed = new Set<string>();

  /** Live WebRTC numbers for a session's connection to its host (debug panel). */
  async sessionStats(sessionId: string): Promise<LinkStats | null> {
    return (await this.sessions.get(sessionId)?.stats()) ?? null;
  }

  private historyChannels(sessionId: string): string[] {
    const scope = parseSessionId(sessionId);
    if (!scope) return [];
    if (scope.kind === 'dm') return [sessionId];
    if (scope.kind === 'space') {
      return (this.state.spaces[scope.spaceId]?.channels ?? [])
        .filter((c) => c.kind === 'text')
        .map((c) => c.id);
    }
    return [];
  }

  private async onSessionInvite(sessionId: string, from: string) {
    const scope = parseSessionId(sessionId);
    if (!scope || scope.kind !== 'dm' || !scope.users.includes(this.userId)) return;
    if (this.state.friends.blocked.includes(from)) return;
    this.addDm(from);
    const session = this.ensureSession(sessionId);
    if (!session.state) await session.join().catch(() => {});
  }

  private addDm(userId: string) {
    if (this.state.dms.includes(userId)) return;
    const dms = [userId, ...this.state.dms];
    this.store.set({ dms });
    void this.platform.kv.set('dms', dms);
    void this.fetchProfiles([userId]).catch(() => {});
  }

  /** Opens (or re-opens) a direct conversation. Returns its channel id. */
  async openDm(userId: string): Promise<string> {
    const sessionId = sessionIds.dm(this.userId, userId);
    this.addDm(userId);
    const session = this.ensureSession(sessionId);
    if (!session.state)
      await session
        .join()
        .catch((err) => this.reportError(`Could not open conversation: ${err.message}`));
    return sessionId;
  }

  async closeDm(userId: string) {
    const sessionId = sessionIds.dm(this.userId, userId);
    if (this.state.voiceSession === sessionId) await this.leaveVoice();
    await this.sessions.get(sessionId)?.leave();
    this.sessions.delete(sessionId);
    const dms = this.state.dms.filter((d) => d !== userId);
    this.store.set({ dms });
    await this.platform.kv.set('dms', dms);
  }

  // ===========================================================================
  // Chat
  // ===========================================================================

  /** Session that carries a channel's messages. */
  sessionOfChannel(channel: string): string | null {
    if (channel.startsWith('dm:')) return channel;
    for (const space of Object.values(this.state.spaces)) {
      if (space.channels.some((c) => c.id === channel)) return sessionIds.space(space.id);
    }
    return null;
  }

  async openChannel(channel: string) {
    this.store.set((s) => ({ activeChannel: channel, unread: { ...s.unread, [channel]: 0 } }));
    if (!this.state.messages[channel]) {
      const page = await this.platform.messages.page(channel, { limit: 100 });
      this.store.set((s) => ({
        messages: { ...s.messages, [channel]: foldEdits(this.withDelivery(page)) },
      }));
    }
  }

  private loadingOlder = new Map<string, Promise<boolean>>();

  /** The page before the oldest message shown. Calls while one loads share it. */
  loadOlder(channel: string): Promise<boolean> {
    let loading = this.loadingOlder.get(channel);
    if (!loading) {
      loading = this.loadOlderPage(channel).finally(() => this.loadingOlder.delete(channel));
      this.loadingOlder.set(channel, loading);
    }
    return loading;
  }

  private async loadOlderPage(channel: string): Promise<boolean> {
    const oldest = (this.state.messages[channel] ?? [])[0];
    const page = await this.platform.messages.page(channel, {
      before: oldest?.ts,
      beforeId: oldest?.id,
      limit: 100,
    });
    if (page.length === 0) return false;
    this.store.set((s) => {
      const shown = s.messages[channel] ?? [];
      const have = new Set(shown.map((m) => m.id));
      const older = this.withDelivery(page.filter((m) => !have.has(m.id)));
      return { messages: { ...s.messages, [channel]: foldEdits([...older, ...shown]) } };
    });
    return true;
  }

  closeChannel() {
    this.store.set({ activeChannel: null });
  }

  async sendMessage(
    channel: string,
    body: string,
    opts: { replyTo?: string; edits?: string; deleted?: boolean; file?: FileManifest } = {},
    /** Runs once the message exists and before anyone can see it. */
    created?: (message: ChatMessage, sessionId: string) => Promise<void>,
  ) {
    const text = body.trim();
    if (!text && !opts.deleted && !opts.file) return;
    if (text.length > LIMITS.messageMaxChars)
      throw new Error(`Messages are limited to ${LIMITS.messageMaxChars} characters`);
    const sessionId = this.sessionOfChannel(channel);
    if (!sessionId) throw new Error('unknown channel');
    // Chats are ordered by the time in each message, which comes from its
    // author's clock. Never stamp one earlier than what this channel already
    // holds, so a reply stays below the message it answers even when this
    // computer's clock is behind the other person's. A time further ahead
    // than others accept (a clock that was wrong when it was stamped) is not
    // followed: messages after it would be refused.
    const now = this.config.now?.() ?? Date.now();
    const latest = Math.max(
      await this.platform.messages.latestTs(channel),
      ...(this.state.messages[channel] ?? []).map((m) => m.ts),
    );
    const ts = latest + 1 > now && latest + 1 <= now + MAX_AHEAD_MS - 60_000 ? latest + 1 : now;
    const message = createChatMessage(
      this.identity!,
      { ch: channel, ...(sessionId === channel ? {} : { sid: sessionId }), body: text, ...opts },
      ts,
    );
    await created?.(message, sessionId);
    await this.platform.messages.put(message);
    if (opts.deleted && opts.edits) await this.files?.forgetMessage(opts.edits, this.userId);
    this.outbox.add(message, sessionId);
    const session = this.sessions.get(sessionId);
    const delivered =
      !!session?.connected &&
      session.peers.size > 0 &&
      session.sendGroup({ type: 'message', message });
    this.addToTimeline(channel, { ...message, pending: true });
    this.emit('message', { channel, message, mine: true, update: !!message.edits });
    if (!delivered && sessionId.startsWith('dm:')) void this.pokeDm(sessionId);
    this.scheduleMail();
  }

  /**
   * Posts a file: encrypts it into this device's storage, then sends the
   * message that carries its manifest. Members fetch it from this device (or
   * anyone who already has it) over a direct connection.
   */
  async sendFile(
    channel: string,
    source: FileSource,
    opts: {
      caption?: string;
      replyTo?: string;
      /** Made by the UI for pictures and videos. */
      preview?: { thumb?: string; w?: number; h?: number; dur?: number };
      onProgress?: (done: number) => void;
      /**
       * False: keep no encrypted copy; the platform's block store makes
       * blocks from the original. `prepared` runs before the message goes
       * out, so the store can learn where that is.
       */
      store?: boolean;
      prepared?: (file: FileManifest) => void | Promise<void>;
    } = {},
  ) {
    const files = this.files;
    if (!files) throw new Error('This device cannot send files');
    if (!this.sessionOfChannel(channel)) throw new Error('unknown channel');
    if (source.size > FILE_MAX_SIZE) throw new Error('Files are limited to 1 TB');
    const caption = opts.caption?.trim() ?? '';
    if (caption.length > LIMITS.messageMaxChars)
      throw new Error(`Messages are limited to ${LIMITS.messageMaxChars} characters`);
    const { manifest, hashes } = await files.prepare(source, opts.onProgress, opts.store ?? true);
    try {
      const p = opts.preview ?? {};
      const file = FileManifest.parse({
        ...manifest,
        name: cleanFileName(manifest.name),
        type: manifest.type.slice(0, 127),
        ...(p.thumb && FileThumb.safeParse(p.thumb).success ? { thumb: p.thumb } : {}),
        ...(p.w && p.h ? { w: Math.round(p.w), h: Math.round(p.h) } : {}),
        ...(p.dur !== undefined && Number.isFinite(p.dur) ? { dur: p.dur } : {}),
      });
      await opts.prepared?.(file);
      await this.sendMessage(
        channel,
        caption,
        { file, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) },
        (message, sessionId) => files.posted(sessionId, { ...message, file }, hashes),
      );
      return file.id;
    } catch (err) {
      // Not posted: the encrypted copy has nothing left to serve.
      await files.forget(manifest.id);
      throw err;
    }
  }

  /** Start fetching a file in a message. */
  async downloadFile(fileId: string) {
    if (!this.files) throw new Error('This device cannot receive files');
    await this.files.download(fileId);
  }

  /**
   * Fetch a file by itself if the auto-download setting allows it. With
   * "from friends", only from the author or a friend: whoever sends it sees
   * this device's IP address, and nobody chose to connect to anyone else.
   */
  async autoDownloadFile(message: ChatMessage) {
    if (!this.shouldAutoDownload(message)) return;
    const author = message.author;
    const anyone = this.state.settings.autoDownload === 'everyone';
    await this.files!.download(
      message.file!.id,
      anyone
        ? {}
        : {
            from: (peer) => {
              const user = peerIds.user(peer);
              return user === author || this.state.friends.friends.includes(user);
            },
          },
    );
  }

  /** A downloaded (or sent) file's contents, block by block. */
  async readFile(fileId: string, sink: (plain: Uint8Array) => Promise<void> | void) {
    if (!this.files) throw new Error('This device cannot read files');
    await this.files.read(fileId, sink);
  }

  /** Deletes the copies of files this device downloaded (not the ones it sent). */
  async clearDownloadedFiles() {
    if (!this.files) return;
    for (const f of this.files.list())
      if (!f.mine) await this.files.forget(f.id, { keepRecord: true });
  }

  /** Bytes of files on this device. */
  async fileStorageUsed() {
    return (await this.platform.files?.usage?.()) ?? 0;
  }

  /**
   * Whether a file should be fetched without asking: pictures and videos up
   * to 10 MB, from the people the auto-download setting allows.
   */
  shouldAutoDownload(message: ChatMessage): boolean {
    const f = message.file;
    if (!f || !this.files || message.deleted) return false;
    if (message.author === this.identity?.userId) return false;
    if (!fileMediaKind(f.type) || f.size > FILE_AUTO_DOWNLOAD_MAX) return false;
    const view = this.state.files[f.id];
    if (view && view.status !== 'none') return false;
    const mode = this.state.settings.autoDownload;
    if (mode === 'never') return false;
    if (mode === 'everyone') return true;
    return message.ch.startsWith('dm:') || this.state.friends.friends.includes(message.author);
  }

  editMessage(channel: string, id: string, body: string) {
    return this.sendMessage(channel, body, { edits: id });
  }

  deleteMessage(channel: string, id: string) {
    return this.sendMessage(channel, '', { edits: id, deleted: true });
  }

  sendTyping(channel: string) {
    const sessionId = this.sessionOfChannel(channel);
    if (sessionId) this.sessions.get(sessionId)?.sendGroup({ type: 'typing', ch: channel });
  }

  private async acceptMessage(sessionId: string, message: ChatMessage): Promise<boolean> {
    if (!verifyChatMessage(message)) return false;
    if (!this.historyChannels(sessionId).includes(message.ch)) return false;
    // Channel ids are only unique within a space: a message written for another
    // space does not belong here, even under the same channel id.
    if (messageSession(message) !== sessionId) return false;
    if (message.author !== this.userId && !this.isAllowedPeer(sessionId, message.author))
      return false;
    if (message.ts > (this.config.now?.() ?? Date.now()) + MAX_AHEAD_MS) return false;
    const fresh = await this.platform.messages.put(message);
    if (!fresh) return false;
    this.addToTimeline(message.ch, message);
    const mine = message.author === this.userId;
    await this.noteFile(sessionId, message, mine);
    // Edits and deletions change what's there; they aren't news.
    const update = !!message.edits;
    if (!mine && !update && this.state.activeChannel !== message.ch) {
      this.store.set((s) => ({
        unread: { ...s.unread, [message.ch]: (s.unread[message.ch] ?? 0) + 1 },
      }));
    }
    this.store.set((s) => {
      const typing = s.typing[message.ch];
      if (!typing?.[message.author]) return {};
      const { [message.author]: _, ...rest } = typing;
      return { typing: { ...s.typing, [message.ch]: rest } };
    });
    this.emit('message', { channel: message.ch, message, mine, update });
    return true;
  }

  /** Keeps track of files posted in messages, and of their deletion. */
  private async noteFile(sessionId: string, message: ChatMessage, mine: boolean) {
    const files = this.files;
    if (!files) return;
    if (message.file && !message.edits) {
      await files.noted(sessionId, { ...message, file: message.file }, mine);
      // Live messages (not old history) may be fetched right away.
      const now = this.config.now?.() ?? Date.now();
      if (now - message.ts < 2 * 60_000) void this.autoDownloadFile(message).catch(() => {});
    } else if (message.edits && message.deleted) {
      await files.forgetMessage(message.edits, message.author);
    }
  }

  private addToTimeline(channel: string, message: MessageView) {
    this.store.set((s) => {
      const list = s.messages[channel];
      if (!list) return {};
      return {
        messages: {
          ...s.messages,
          [channel]: foldEdits([...list.filter((m) => m.id !== message.id), message]),
        },
      };
    });
  }

  // ===========================================================================
  // Voice
  // ===========================================================================

  async joinVoice(spaceId: string, channelId: string) {
    return this.joinVoiceSession(sessionIds.voice(spaceId, channelId));
  }

  /**
   * Call inside a DM: joins the call and rings the other side, or answers
   * their ring. With `video`, our camera is on from the start: we see
   * ourselves while it rings, they see us once they answer.
   */
  async callDm(userId: string, opts: { video?: boolean } = {}) {
    const sessionId = await this.openDm(userId);
    const answering = this.state.incomingCall?.sessionId === sessionId;
    await this.joinVoiceSession(sessionId);
    const attempt = this.callAttempt;
    // A missing or busy camera doesn't stop the call itself.
    if (opts.video)
      await this.setCamera(true).catch((err: unknown) =>
        this.reportError(err instanceof Error ? err.message : String(err)),
      );
    // Hung up (or another call placed) while the camera was opening, say at
    // its permission prompt: don't ring or answer for a call that's over.
    if (attempt !== this.callAttempt) return;
    if (answering) {
      this.callAnswered = sessionId;
      this.store.set({ incomingCall: null });
      this.sendCallSignal(sessionId, 'accept');
      return;
    }
    this.store.set({
      outgoingCall: {
        sessionId,
        to: userId,
        at: Date.now(),
        ...(opts.video ? { video: true } : {}),
      },
    });
    this.ringLoop(sessionId);
  }

  private ringTimer?: ReturnType<typeof setInterval>;
  private ringingTimer?: ReturnType<typeof setTimeout>;

  private ringLoop(sessionId: string) {
    clearInterval(this.ringTimer);
    const started = Date.now();
    const timeout = this.config.ringTimeoutMs ?? 45_000;
    const ring = () => {
      const out = this.state.outgoingCall;
      if (!out || out.sessionId !== sessionId) {
        clearInterval(this.ringTimer);
        return;
      }
      if (Date.now() - started > timeout) {
        // Nobody picked up: hang up rather than sit in an empty call.
        clearInterval(this.ringTimer);
        this.reportError('No answer');
        void this.leaveVoice();
        return;
      }
      this.sendCallSignal(sessionId, 'ring', out.video);
    };
    ring();
    this.ringTimer = setInterval(ring, Math.min(2500, timeout / 2));
  }

  private sendCallSignal(
    sessionId: string,
    action: 'ring' | 'accept' | 'decline' | 'end',
    video?: boolean,
  ) {
    return (
      this.sessions
        .get(sessionId)
        ?.sendGroup({ type: 'call', action, ...(video ? { video: true } : {}) }) ?? false
    );
  }

  declineCall() {
    const call = this.state.incomingCall;
    if (!call) return;
    this.store.set({ incomingCall: null });
    this.sendCallSignal(call.sessionId, 'decline');
  }

  private onCallSignal(
    sessionId: string,
    from: string,
    action: 'ring' | 'accept' | 'decline' | 'end',
    video?: boolean,
  ) {
    if (from === this.userId) return;
    if (action === 'ring') {
      if (this.state.voiceSession === sessionId) {
        this.sendCallSignal(sessionId, 'accept');
        return;
      }
      const ringing = this.state.incomingCall;
      if (ringing && ringing.sessionId !== sessionId) return;
      if (!ringing)
        this.store.set({
          incomingCall: { sessionId, from, at: Date.now(), ...(video ? { video: true } : {}) },
        });
      // A hang-up can be lost (the caller's app quit, say): stop when the rings do.
      clearTimeout(this.ringingTimer);
      this.ringingTimer = setTimeout(() => {
        if (this.state.incomingCall?.sessionId === sessionId)
          this.store.set({ incomingCall: null });
      }, RING_SILENCE_MS);
      this.ringingTimer.unref?.();
    } else if (action === 'accept') {
      if (this.state.outgoingCall?.sessionId === sessionId) {
        this.callAnswered = sessionId;
        this.store.set({ outgoingCall: null });
        const view = this.state.sessions[sessionId];
        const session = this.sessions.get(sessionId);
        if (view && session) this.followCall(view, session.welcomed);
      }
    } else if (action === 'decline') {
      if (this.state.outgoingCall?.sessionId === sessionId) {
        this.store.set({ outgoingCall: null });
        this.reportError('Call declined');
        void this.leaveVoice();
      }
    } else if (action === 'end') {
      if (this.state.incomingCall?.sessionId === sessionId) this.store.set({ incomingCall: null });
      if (this.state.voiceSession === sessionId) void this.endCall(sessionId, 'Call ended');
    }
  }

  private async joinVoiceSession(sessionId: string) {
    const engine = this.voiceEngine;
    if (!engine) throw new Error('Voice is not available on this device');
    // Calling back right after hanging up: let the hang-up finish first, or
    // its last steps would end the new call (it's the same DM session).
    await this.leaving;
    if (this.state.voiceSession && this.state.voiceSession !== sessionId) await this.leaveVoice();
    this.callAttempt++;
    await engine.start();
    this.store.set({ voiceSession: sessionId });
    let session = this.sessions.get(sessionId);
    if (session && sessionId.startsWith('dm:') && !session.isVoice) {
      // Upgrade the DM's text-only session to one with audio.
      this.sessions.delete(sessionId);
      await session.leave();
      session = undefined;
    }
    session = session ?? this.ensureSession(sessionId);
    session.isVoice = true;
    session.setVoiceState(this.state.muted, this.state.deafened);
    await session.join();
  }

  /** Hang up. `quiet`: the other side already ended it, no need to tell them. */
  /** A hang-up still going out; a new call waits for it. */
  private leaving: Promise<void> | null = null;
  /** Moves on with every call joined or left, so a step that waited knows. */
  private callAttempt = 0;

  async leaveVoice(opts: { quiet?: boolean } = {}) {
    if (this.leaving) return this.leaving;
    const done = this.leaveVoiceNow(opts).finally(() => {
      if (this.leaving === done) this.leaving = null;
    });
    this.leaving = done;
    return done;
  }

  private async leaveVoiceNow(opts: { quiet?: boolean }) {
    const sessionId = this.state.voiceSession;
    if (!sessionId) return;
    this.callAttempt++;
    if (this.state.outgoingCall?.sessionId === sessionId) this.store.set({ outgoingCall: null });
    if (sessionId.startsWith('dm:') && !opts.quiet) {
      // Tell the other side, ringing or talking. Let the hang-up go out
      // first: if we host the call, leaving closes the relay.
      if (this.sendCallSignal(sessionId, 'end'))
        await new Promise((r) => setTimeout(r, HANG_UP_FLUSH_MS));
      if (this.state.voiceSession !== sessionId) return;
    }
    clearTimeout(this.callLostTimer);
    this.callLostTimer = undefined;
    this.callOthers.clear();
    this.callMissing.clear();
    this.callPresenceSeen = false;
    this.callAnswered = null;
    this.store.set({ voiceSession: null, callLiveSince: null });
    const session = this.sessions.get(sessionId);
    // Camera and screen belong to the call.
    this.voiceEngine?.stopCamera();
    this.voiceEngine?.stopScreen();
    this.voiceEngine?.stopSession(sessionId);
    if (sessionId.startsWith('dm:')) {
      // Keep the DM open for text. The call's session goes first, so its
      // last updates while it closes don't show us still in the call.
      this.sessions.delete(sessionId);
      // Until the text session is up: out of the call, reconnecting.
      this.store.set((st) => {
        const v = st.sessions[sessionId];
        if (!v) return {};
        const view: SessionView = {
          ...v,
          status: 'connecting',
          peers: [],
          inCall: [],
          latency: {},
        };
        return { sessions: { ...st.sessions, [sessionId]: view } };
      });
      await session?.leave();
      const s = this.ensureSession(sessionId);
      await s.join().catch(() => {});
    } else {
      await session?.leave();
      this.sessions.delete(sessionId);
      this.store.set((s) => {
        const { [sessionId]: _, ...rest } = s.sessions;
        return { sessions: rest };
      });
    }
    if (!this.state.voiceSession) this.voiceEngine?.stop();
  }

  setMuted(muted: boolean) {
    this.store.set({ muted });
    this.voiceEngine?.setMuted(muted);
    this.pushVoiceState();
  }

  setDeafened(deafened: boolean) {
    // Deafening also mutes, as users expect from Discord/TeamSpeak.
    const muted = deafened ? true : this.state.muted;
    this.store.set({ deafened, muted });
    this.voiceEngine?.setMuted(muted);
    this.voiceEngine?.setDeafened(deafened);
    this.pushVoiceState();
  }

  private pushVoiceState() {
    const id = this.state.voiceSession;
    if (id) this.sessions.get(id)?.setVoiceState(this.state.muted, this.state.deafened);
  }

  async shutdown() {
    clearTimeout(this.mailTimer);
    clearTimeout(this.friendRetryTimer);
    clearInterval(this.friendSweepTimer);
    clearTimeout(this.ringingTimer);
    await this.leaveVoice().catch(() => {});
    for (const s of this.sessions.values()) await s.leave().catch(() => {});
    await this.files?.close();
    this.link?.stop();
    await this.outbox.flush().catch(() => {});
    // Nothing is written after this returns: the platform may close its storage.
    await this.records.flush().catch(() => {});
  }

  private makeFiles(blocks: NonNullable<PlatformAdapter['files']>, links: FileLinkFactory) {
    return new FileTransfers({
      kv: this.platform.kv,
      blocks,
      links,
      peer: () => this.peer,
      iceServers: () => this.stun.map((urls) => ({ urls })),
      session: (sid) => this.sessions.get(sid),
      openSession: async (sid) => {
        const scope = parseSessionId(sid);
        if (scope?.kind === 'dm') {
          const other = scope.users.find((u) => u !== this.userId) ?? this.userId;
          await this.openDm(other);
          return;
        }
        const session = this.ensureSession(sid);
        if (!session.state) await session.join();
      },
      isAllowedPeer: (sid, peer) => this.isAllowedPeer(sid, peer),
      shareDownloads: () => this.state.settings.shareDownloads,
      changed: (id, view) =>
        this.store.set((st) => {
          if (view) return { files: { ...st.files, [id]: view } };
          const { [id]: _, ...rest } = st.files;
          return { files: rest };
        }),
      served: (fileId, to) => this.emit('fileServed', { fileId, to: peerIds.user(to) }),
      log: (m, e) => this.log(m, e),
    });
  }
}

/**
 * A file name safe to show and to offer when saving: no folders, control
 * characters or characters Windows refuses, not hidden, not empty.
 */
export function cleanFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_');
  // Dots and spaces off both ends, in one pass each (a regex anchored at the
  // end would retry from every space of a long run).
  const trimmed = (ch: string) => ch === '.' || /\s/.test(ch);
  let start = 0;
  let end = base.length;
  while (start < end && trimmed(base[start]!)) start++;
  while (end > start && trimmed(base[end - 1]!)) end--;
  return fitName(base.slice(start, end)) || 'file';
}

/** Bytes a file name may take: what most file systems allow. */
const NAME_MAX_BYTES = 255;

/** A name cut to fit in UTF-8 bytes, whole characters only, keeping a short extension. */
function fitName(name: string) {
  const bytes = (s: string) => utf8.encode(s).length;
  if (name.length <= NAME_MAX_BYTES / 3 || bytes(name) <= NAME_MAX_BYTES) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  let room = NAME_MAX_BYTES - bytes(ext);
  let out = '';
  for (const ch of name.slice(0, name.length - ext.length)) {
    room -= bytes(ch);
    if (room < 0) break;
    out += ch;
  }
  return out + ext;
}

/** The code in an invite link or code as pasted ("croc://join/abc…", "ABC…"). */
export function inviteCodeOf(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .split('/')
    .pop()!
    .replace(/[^a-z2-7]/g, '');
}

export function defaultDeviceName(platform: string): string {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  const ua = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  const os = /Win/i.test(ua)
    ? 'Windows'
    : /Mac/i.test(ua)
      ? 'macOS'
      : /Linux/i.test(ua)
        ? 'Linux'
        : /Android/i.test(ua)
          ? 'Android'
          : /iPhone|iPad/i.test(ua)
            ? 'iOS'
            : '';
  const kind =
    platform === 'desktop'
      ? 'Desktop'
      : platform === 'mobile'
        ? 'Phone'
        : platform === 'web'
          ? 'Browser'
          : 'Bot';
  return os ? `${kind} · ${os}` : kind;
}

/** Applies edit/delete messages onto the originals they reference. */
export function foldEdits(messages: MessageView[]): MessageView[] {
  const sorted = [...messages].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  const byId = new Map<string, MessageView>();
  const out: MessageView[] = [];
  for (const m of sorted) {
    if (m.edits) {
      const original = byId.get(m.edits);
      if (original && original.author === m.author) {
        const updated: MessageView = {
          ...original,
          body: m.deleted ? '' : m.body,
          edited: !m.deleted,
          deleted: m.deleted,
        };
        if (m.deleted) delete updated.file;
        byId.set(original.id, updated);
        out[out.indexOf(original)] = updated;
      }
      continue;
    }
    byId.set(m.id, m);
    out.push(m);
  }
  return out;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs of items within `max` total size (and `count` items); a larger item goes alone. */
function chunksBySize<T>(items: T[], max: number, size: (t: T) => number, count = Infinity): T[][] {
  const out: T[][] = [];
  let run: T[] = [];
  let total = 0;
  for (const item of items) {
    const n = size(item);
    if (run.length && (total + n > max || run.length >= count)) {
      out.push(run);
      run = [];
      total = 0;
    }
    run.push(item);
    total += n;
  }
  if (run.length) out.push(run);
  return out;
}
