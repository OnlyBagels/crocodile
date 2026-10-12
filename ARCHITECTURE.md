# Crocodile architecture

Crocodile is a voice and text communicator in which **content only ever
travels between the people in a conversation**, always end-to-end encrypted.
Servers exist only to introduce peers to each other and to decide which peer
hosts a group. This document explains how the pieces fit and why.

```
                 ┌────────────────────┐
                 │  Directory service │  list of coordination servers
                 └─────────┬──────────┘  (no users, no content)
                           │ register / list
        ┌──────────────────┼───────────────────┐
┌───────┴────────┐  mesh  ┌┴────────────────┐ mesh ┌────────────────┐
│ Coordinator A  │◄──────►│ Coordinator B   │◄────►│ Coordinator C  │  signed metadata,
└───────┬────────┘        └───────┬─────────┘      └────────────────┘  presence, signalling,
        │ WebSocket (metadata      │                                    host election
        │ + signalling only)       │
   ┌────┴─────┐               ┌────┴─────┐
   │  Alice   │               │   Bob    │ ◄─┐
   │ (host) ┌─┴─────────┐     └──────────┘   │  WebRTC (DTLS/SRTP) carrying
   │        │ host relay │◄──────────────────┘  frames already E2E-encrypted
   │        │  (SFU)     │◄──────────────────┐  with per-sender keys
   └────────┴────────────┘              ┌────┴─────┐
                                        │  Carol   │
                                        └──────────┘
```

## 1. Components

| Package                | What it is                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/protocol`    | Wire formats and zod schemas: signed records, client↔coordinator RPC, server mesh frames, directory entries, relay data-channel messages, E2E envelopes.                                                                       |
| `packages/crypto`      | Identities, record signing/validation, sealed boxes, sender keys, frame and group encryption, signed chat messages and SDP, safety numbers, recovery keys. Pure TypeScript (`@noble/*`), identical on desktop, web and mobile. |
| `packages/coordinator` | The coordination server. Embeddable (the desktop app runs one on request) and standalone (`crocodile-coordinator`, Docker).                                                                                                    |
| `apps/directory`       | The directory: a phone book of coordination servers.                                                                                                                                                                           |
| `packages/relay`       | The **host relay**: a small SFU the elected host peer runs inside its app (werift).                                                                                                                                            |
| `packages/client-core` | The platform-neutral client: server selection, sessions, E2E layer, chat, history sync, voice engine.                                                                                                                          |
| `apps/desktop`         | Electron app (Windows, macOS, Linux) with the React UI.                                                                                                                                                                        |

## 2. Design principles → mechanisms

| Principle                                                             | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice and text only P2P, always E2E                                   | Voice frames are encrypted by the sender's app (Encoded Transforms, SFrame-style) before they leave the device; text is group-encrypted with ratcheting sender keys. The host relay forwards ciphertext. Coordination servers carry signalling only. If peers cannot reach the host, the host is re-elected first; only users who opted in may then fall back to a coordinator's relay (TURN), which carries the same end-to-end ciphertext, for at most an hour at a time and for a capped number of users per server. |
| Coordination servers on a good-will basis                             | Anyone can run `crocodile-coordinator` or tick "Host a coordination server" in the app. Servers register with the directory, which verifies they are reachable.                                                                                                                                                                                                                                                                                                                                                         |
| Servers hold accounts and metadata, shared across a mesh              | Accounts are key pairs. Profiles, friend lists, spaces, invites and memberships are **records signed by their author**; each record is stored by a few owner servers (all of them in a small network), and every server and client re-verifies them, so no server has to be trusted for integrity. Friend lists are sealed so that only their owner's devices can read them, and friend requests travel as sealed notes that don't name their sender (only the sender's own server sees whom they wrote to).            |
| Lowest-latency server, runner-up as backup                            | Clients fetch the directory (addresses listed obfuscated and signed by each server), probe `/health` round-trip times, connect to the best and fail over to the standby instantly.                                                                                                                                                                                                                                                                                                                                      |
| Every install can be server and client                                | The coordinator and relay are libraries; the desktop app runs them in Electron utility processes.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Hassle-free install                                                   | One-click per-user installers (NSIS/DMG/AppImage/deb/rpm), no accounts, passwords or emails: onboarding is "pick a name".                                                                                                                                                                                                                                                                                                                                                                                               |
| Best peer hosts groups, runner-up is backup, server re-connects peers | Per-session host election on the coordination server with a standby backup and failover on disconnect or member reports.                                                                                                                                                                                                                                                                                                                                                                                                |
| Discord/TeamSpeak-style UX                                            | Familiar model (spaces, text channels, voice rooms, friends, DMs, calls) with its own look: space tabs, floating panels, rooms as live cards, a call dock, a command palette, light and dark themes.                                                                                                                                                                                                                                                                                                                    |

## 3. Identity and signed records

- A user identity is a 32-byte seed. It yields an Ed25519 signing key and an
  X25519 encryption key. `userId = base32(sha256(signing public key))[:26]`,
  so ids are self-certifying: a server cannot substitute someone's key.
- The seed is the account. It is shown once as a **recovery key**
  (base32 + checksum) and kept encrypted with a key from the OS keychain
  (Electron `safeStorage`), like all local data.
- **Devices.** Each install has a device id and publishes a signed `device`
  record with a name and a **prekey bundle** (X25519 + ML-KEM-768) that
  rotates weekly. The peer id used in sessions is `<userId>.<deviceId>`, so
  one person can be in a call from one device while chatting on another.
  A new device is linked by typing a short code shown on it into a signed-in
  device and comparing a 6-digit security code on both; the account seed is
  then sent in a hybrid-encrypted, signed box. Removing a device publishes
  a permanent revocation.
- `name#1234` tags are a display aid derived from the user id.
- **Safety numbers** let two users compare keys out of band.

Metadata lives in signed records (`packages/protocol/src/records.ts`):

| Record  | Key                         | Who may write it                                                              |
| ------- | --------------------------- | ----------------------------------------------------------------------------- |
| profile | `profile:<userId>`          | the user (name, avatar, bio, X25519 key)                                      |
| friends | `friends:<userId>`          | the user; sealed, readable only by the user's devices (see below)             |
| space   | `space:<spaceId>`           | the owner; `spaceId = hash(owner key, nonce)` binds ownership without history |
| invite  | `invite:<code>`             | the space owner                                                               |
| member  | `member:<spaceId>:<userId>` | the user, referencing a valid invite                                          |
| device  | `device:<userId>:<device>`  | the user (name, platform, current prekeys, revoked flag)                      |
| note    | `note:<userId>:<noteId>`    | anyone, once, with a one-time key; only the recipient may delete it           |

Validation (`crypto/src/records.ts`) checks the signature, authority, and
last-writer-wins versioning, identically on servers and clients.

**Friends without telling the servers.** A friendship exists when both people
list each other; listing someone who doesn't list you back is a request. No
server learns who lists whom:

- Each user's list (whom they list or block, and whether each of those lists
  them back) is one `friends` record, AES-256-GCM-encrypted under a key that
  only the account's own devices derive from the account seed, and padded.
  Servers replicate it but see only its owner, its rough size and when it
  changes. Entries merge field by field, so two devices editing at once
  don't lose each other's changes (`client-core/src/friend-list.ts`).
- The other side hears about a change in a **note**: "I list you" or "I don't
  any more", sealed to each of their devices like a sealed box, but with the
  sender's identity and signature inside the encryption (an _anonymous box_).
  The note record is signed by a key made for that note alone, so servers can
  check it and the note itself doesn't say who sent it. The one server the
  sender hands it to does know whom it is from and for, since the sender is
  signed in there; the servers it is replicated to don't. Servers keep notes until the
  recipient's app has read them and replaces them with a deletion marker, and
  at most 30 days; only the recipient can list or fetch their notes, and each
  account holds at most 200 unread ones.
- A note also says whether its sender thinks the recipient lists them, so if
  a note gets lost, the other side notices and sends its state again.
- **Blocks** are enforced by the blocking user's apps (they ignore the
  blocked user's invitations, messages and mail), since no server knows
  about them. The blocked user is only told that they are no longer listed.
- Apps that predate sealed lists wrote them in the open. Servers still accept
  such lists, and updated apps read them and move their own into the sealed
  form on first connection, telling everyone they list in a note.

What this does not hide: while you are connected, your server sees whose
presence you follow, whom you send a friend request or answer to, and whom
you start a direct message or call with (it doesn't keep or replicate who
sent a note; hiding even that would need an anonymising relay), and
the servers holding a space's records, and any server a member connects
through, see its memberships (they use them to admit members to the space's
sessions). See [docs/ROADMAP.md](docs/ROADMAP.md).

## 4. Coordination servers and the mesh

A coordinator (`packages/coordinator`) offers a WebSocket JSON-RPC API:

1. Server sends a signed `hello` with a challenge and a fresh hybrid
   key-exchange offer (X25519 + ML-KEM-768). A second signature covers the
   rest of the hello (the STUN servers apps use, the operator's contact),
   which apps ignore when it is missing. The client checks the signatures
   against the key in the directory listing, answers the key exchange and
   signs the transcript. From then on every frame is AES-256-GCM encrypted
   and padded, so metadata is confidential even over plain `ws://` to a
   home server. Server-to-server mesh links use the same handshake.
2. The client can put and get records, subscribe to prefixes, search users,
   watch presence and voice-channel occupancy, join or leave sessions, and
   send signalling messages to other session members.

**Mesh.** Servers learn about each other from the directory, gossip and
signed beacons that every server floods through the overlay; a server is live
while it is linked or its beacon is recent. Links are mutually authenticated
WebSocket connections. In a small network every server links to every other;
in a larger one each keeps a few **overlay** links (ring neighbours and
fingers) and opens **direct** links to the servers it needs, closing them when
idle. Each record lives on its **owners**: the first few servers on a
consistent-hash ring for each of its shards (a user, a space, an invite code,
a name), plus servers that keep a full copy (`--store-all`). A server answers
from its store for shards it owns and asks their owners otherwise; it asks
owners to push changes its clients follow. Owners copy writes to each other,
catch up by per-peer sequence cursors when a link comes up, hand records to
new owners when servers join or leave, and drop copies they no longer own.
Presence, voice-room occupancy and mailbox and device-link queries are
flooded. See [docs/MESH.md](docs/MESH.md).

**Sessions.** Each session (a space's text mesh, a voice channel, a DM) is
owned by one server chosen by rendezvous hashing over the live servers, so every
server independently agrees on the owner. Member servers keep a registry of
their local members and forward operations to the owner. When the mesh changes
and ownership moves, member servers re-submit their joins with a hint of the
last known host, so the new owner rebuilds the same state without interrupting
the call.

**Storage.** SQLite (`node:sqlite`) with secondary indexes, or a
JSON-snapshotted memory store where SQLite is unavailable.

**STUN and the opt-in relay.** Each coordinator answers STUN (RFC 5389) on
its UDP port, and on a second port (`--stun-alt-port`, the next one by
default), so the ecosystem does not depend on third-party STUN. Apps compare
the public port both report: the same port means a cone NAT (good for
hosting), different ports a symmetric one. The main port can act as a TURN relay (RFC 5766) for users who turned on "Relay through
a coordination server" and whose direct connection failed. Grants use
short-lived credentials in windows of at most an hour. The app renews a grant
shortly before it ends only while its connection still goes through the
relay; if ICE found a direct path after all, it lets the grant lapse without
touching the connection. The TURN server honours a renewed grant for
allocations made under the old credentials, so a relayed call carries on.
Grants are capped per server (`--relay-max-users`, 25 by default, 10 in the
desktop app) and rate-limited per allocation; a user's newest allocation
replaces their oldest past eight, so allocations left behind by dropped
connections can't lock them out. The relayed packets are the
same DTLS-SRTP-wrapped, end-to-end encrypted frames: the server sees only
ciphertext, sizes and timing.

Each relayed connection gets its own UDP port on the server, from
`--relay-ports` when set (49160-49259 in the Docker image), which the
operator opens along with the STUN ports.

**Telling people when to use the relay.** On connecting, the app checks its
network against the server's two STUN ports: direct connections work (open
or cone NAT), are limited (symmetric NAT) or are blocked (no STUN answer).
When they are limited or blocked and the relay is off, it says so and
offers to turn the relay on. When connecting to a session's host fails twice
with the relay off, it names the person it couldn't reach and offers the
relay for that connection. Once connected, the selected ICE candidate pair
shows how the connection travels: same network, direct, or relayed.

**Seeing where a connection fails.** Each connection to a host goes through
four steps: the offer goes out through the coordination server, the host
answers, ICE finds a network path, the encrypted channel opens. The app
records each attempt's steps and, for a failure, the stage it stopped at
(no answer, no path, no channel, lost later, host left, bad signature). A
connection that stays "disconnected" for 8 s counts as lost, as on the host,
instead of waiting for WebRTC's 30 s. The chat header and call dock open
these details; Settings → Debug shows every session live with its WebRTC
numbers, the network check as a checklist, and the client log.

## 5. Host election and failover

Members report `HostCaps` when joining: whether they can and may host (desktop
only, user setting), NAT type (detected by comparing the mappings the server's two STUN ports report), uplink,
CPU cores, battery, RTT. `coordinator/src/election.ts` scores members:

- Open or cone NAT scores highest and symmetric NAT lowest; web and mobile
  clients never host.
- The current host is kept while it is healthy (no flapping when a slightly
  better peer joins), except that a host behind a symmetric NAT hands over to
  the best member whose NAT isn't symmetric (open, cone, or not fully tested). Whoever calls or opens a channel first
  is elected while alone, and others often can't reach a symmetric-NAT host
  while it can reach them. A device whose UDP is blocked reports itself as
  symmetric.
- The backup is the best other candidate, kept stable unless clearly beaten.

Failover triggers:

1. The host's coordinator connection drops, so it leaves the session and the
   backup is promoted (epoch + 1).
2. Members fail to connect to the host twice, or once with no network path
   at all from a member whose own network isn't symmetric, and report it.
   Once half of them agree, the host is penalised for 60 s and the backup promoted.
3. The owner server dies. Ownership moves (see above) and the host is kept.

Every host change bumps the **epoch**; signals carry it, so stale offers and
answers are ignored.

## 6. The host relay (SFU inside a peer)

The elected host runs `HostRelay` (werift) in an Electron utility process.
Every member, including the host's own client over loopback, opens one
`RTCPeerConnection` to it:

- 1 upstream audio m-line (the microphone),
- `N` downstream audio m-lines, the **speaker slots** (default 5),
- one ordered data channel for control and E2E envelopes.

The relay assigns whoever is talking to each listener's slots ("last-N"),
using the unencrypted RFC 6464 audio-level header, and rewrites
sequence/timestamps so each slot stays a continuous stream. SDP never needs
renegotiation as people join or leave, and per-listener bandwidth is bounded
regardless of room size.

Offers and answers are signed with identity keys over (session, epoch, both
ids, SDP including the DTLS fingerprint), so a coordination server cannot
splice itself into the WebRTC transport.

## 7. End-to-end encryption

Goal: the strongest protection that costs no noticeable CPU, latency or user
effort. Everything below is automatic.

- **Hybrid post-quantum key exchange.** Pairwise secrets (sender-key
  distribution, history sync, device linking, server channels) combine X25519
  with ML-KEM-768 (FIPS 203) through HKDF-SHA256, so recorded traffic stays
  safe even against a future quantum computer. Sealed boxes to a device use
  its current **prekey**; prekey secrets are deleted after rotation plus a
  grace period, giving forward secrecy even for keys delivered to offline
  devices. Every box is signed by the sender's Ed25519 key.
- **Ratcheting sender keys.** Each member has a sender key per session with
  two HKDF hash chains: the text chain advances after every message
  (per-message forward secrecy); the audio chain advances every 30 s. Keys are
  replaced with fresh randomness every 30 minutes and whenever someone leaves
  (post-compromise healing), and are only ever sent to devices whose
  membership the client verified itself from signed records.
- **Voice.** An Encoded Transform worker encrypts every Opus frame with
  AES-256-GCM before packetisation:
  `ciphertext ‖ tag ‖ kid ‖ gen ‖ counter ‖ 0xC8`, the trailer authenticated
  as AAD. Frames that cannot be encrypted are dropped, never sent in the
  clear. Opus runs at a **constant bitrate** so packet sizes do not reveal
  what is said.
- **Text.** Messages are signed by their author (so history can be re-shared
  verifiably), padded (Padmé) to hide their exact length and encrypted with
  the text chain.
- **At rest.** Identity, prekeys and message history are encrypted in local
  storage with a key protected by the OS keychain.
- **Transport.** DTLS-SRTP and SCTP-over-DTLS underneath, as in all WebRTC;
  SDP is identity-signed so nobody can splice into the connection.

## 8. Text history and offline delivery without servers

Messages live only on members' devices (encrypted IndexedDB). Three
mechanisms get them everywhere they belong:

1. **Live.** Group-encrypted to everyone connected to the session.
2. **Outbox.** Every device keeps a queue of the messages it wrote that no
   other person has confirmed yet (`client-core/src/outbox.ts`). Whenever a
   peer who should have them appears — the other side of a DM, or the host
   or backup of a space — the queue is handed over, sealed to that device,
   and the receiver answers with an acknowledgement that clears it. This
   works no matter who was online when, or whose clock is ahead. Messages
   show a small clock until confirmed. A DM with undelivered messages
   re-invites the friend as soon as they come online.
3. **History sync.** On connecting, a member asks the host and backup (or the
   DM partner) for everything newer than the newest message it did not write
   offline itself. Replies are sealed to the requester and every message is
   signature-checked.

**Mailbox (opt-in, DMs).** If the user turns on "Hold my messages on a server
until they're back", DM messages still unconfirmed after a few seconds are
also deposited with the coordination server: one hybrid post-quantum box per
recipient device (and per own other device), sealed to that device's prekey.
The server keeps them at most `--mailbox-days` (≤ 7), enforces quotas per
sender and recipient, and pushes them when the device connects to any server
in the mesh (`mail_query`/`mail_ack` between servers). The recipient confirms
with `mail.ack`, which deletes the item everywhere. Prekey secrets are deleted
only two days after the device itself replaced them, so mail sealed to a
device that was away for weeks can still be opened when it returns. Servers
operated from the desktop app keep mail only if their operator enables it,
with small quotas.

## 9. Client structure

`CrocodileClient` (`client-core/src/client.ts`) exposes one observable state
object plus methods (create space, send message, join voice, …).
`GroupSession` follows a session's state: it hosts the relay when elected,
connects to the host otherwise, runs the E2E layer, reconnects on
failover and, if the user allowed it, falls back to a coordinator relay. Platform specifics come in through a `PlatformAdapter` (storage,
relay runner, WebRTC, capabilities), so the same core serves desktop, web
(which never hosts) and mobile.

## 10. Technology choices

| Choice                    | Why                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript everywhere** | One language for client, relay, coordinator and directory, so protocol and crypto code is shared, not re-implemented.                                                                                                                                   |
| **WebRTC (Chromium)**     | Industry standard for real-time voice: Opus, AEC3 echo cancellation, noise suppression, ICE NAT traversal, DTLS-SRTP, and Encoded Transforms for E2EE. The previous Rust/QUIC prototype had to rebuild all of this by hand.                             |
| **Electron**              | Ships the same Chromium WebRTC stack on Windows, macOS and Linux, so voice behaves identically everywhere (Tauri's system webviews differ, and WebKitGTK's WebRTC support is limited). Discord, Signal Desktop, Slack and Element make the same choice. |
| **werift for the relay**  | Pure-TypeScript WebRTC, so no native build per platform. It forwards encrypted RTP without decoding.                                                                                                                                                    |
| **@noble crypto**         | Audited, dependency-free, runs in Node, browsers, workers and React Native.                                                                                                                                                                             |
| **Fastify + ws, SQLite**  | Small, fast, zero-ops servers that anyone can run on a small VPS or a home PC.                                                                                                                                                                          |
| **React + Tailwind**      | Mainstream, fast to iterate, and reusable for a web client.                                                                                                                                                                                             |
| **electron-builder**      | One-click installers and auto-update from GitHub Releases.                                                                                                                                                                                              |

## 11. Known limitations and next steps

See [docs/ROADMAP.md](docs/ROADMAP.md). The main ones:

- **Offline delivery.** Without the opt-in mailbox, a message reaches someone
  who was offline once a member who has it is online at the same time. The
  mailbox covers DMs for up to 7 days; spaces rely on their members (usually
  someone is online).
- **Sender keys, not MLS.** Ratchets and periodic rekeying give forward
  secrecy and post-compromise healing within 30 minutes; MLS (RFC 9420) would
  make rekeying very large groups cheaper.
- **Devices share the account key.** Linked devices hold the same identity
  seed. Removing a device stops new keys from reaching it, but a stolen device
  could still sign as you. Per-device signing keys certified by the identity
  are planned.
- **The relay is UDP only.** Networks that block all UDP cannot use it yet
  (TURN over TCP/TLS is planned).
- **Mesh trust.** Servers cannot forge records or read content. A malicious
  server could still lie about presence or drop signalling; clients verify
  membership themselves before sharing keys.
- **Metadata on servers.** Friend lists are sealed, but the server you're
  connected to sees whose presence you follow and whom you befriend, message
  or call while you do, and a space's memberships are visible to the servers
  holding its records and those its members connect through.
- **Every server hears every beacon and presence change.** Fine for
  thousands of servers; presence would move to the owners of each user's
  shard for much more than that.
- **Global push-to-talk** needs X11 on Linux (not Wayland) and the
  Accessibility permission on macOS; otherwise it works while the app is
  focused.
- **Mobile apps** are not built yet.
