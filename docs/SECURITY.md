# Security model

## What we protect

| Asset                            | Who can read it                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| Voice                            | Only the members of the call.                                                                 |
| Text messages (channels and DMs) | Only the members of the space or DM, now and later (via peer-to-peer history sync).           |
| Files                            | Only the members of the space or DM it was posted in, fetched straight from another member.   |
| Your identity key                | Only your linked devices (encrypted with the OS keychain) and whoever holds the recovery key. |

## What servers see

Coordination servers see **metadata**: public profiles, space names, channel
lists, memberships, device names, who is online, who is in which voice room,
and when people connect. They do **not** see whom you list as a friend or
block: each person's list is encrypted so that only their own devices can
read it, and friend requests and their answers travel as notes sealed to the
recipient's devices, with the sender's identity inside the encryption. A
server sees that someone sent a note to a user, when, and its size. The
server you are connected to does see whose presence you follow, whom you
send a friend request or answer to, and whom you start a direct message or
call with, while you do; it doesn't record who sent a note, and nothing of
that is replicated to other servers or kept after you disconnect. Blocks are
enforced by your own apps. They pass on signalling (SDP and
ICE candidates), which includes IP addresses. They never receive message or
voice content, except that a user who turned on the **opt-in relay** sends
their already end-to-end encrypted media through one; that server then also
sees packet sizes and timing, in windows of up to an hour that the app
renews only while the connection still needs the relay. Users who turn
on the **mailbox** let their server hold direct messages for offline friends
as boxes sealed to the friend's devices; the server sees sender, recipient,
size and time, keeps them at most 7 days, and cannot read them.

**Deleting an account** (Settings → Profile) deletes the spaces the user
owns, leaves the others, and replaces the profile with a signed "deleted"
marker. Every server that receives the marker erases the account's devices,
friends list, memberships, notes and mailbox items, signs out its devices and
refuses anything the identity signs afterwards, so stale copies elsewhere in
the mesh can't bring it back. The marker itself stays: the user id, the
public keys and the words "Deleted user". Messages already delivered to other
people's devices stay there.

Connections to coordination servers and between servers are encrypted with
a per-connection hybrid key exchange (X25519 + ML-KEM-768) and AES-256-GCM,
independent of TLS, so metadata is not exposed to the network even when a
home-hosted server uses plain `ws://`.

The directory only sees coordination servers. Its public listing shows each
server's address obfuscated rather than in plain text (decodable by the app,
so not secret) and apps verify each entry's signature before using it.

**Files** never reach a server at all, not even through the opt-in relay:
they travel over direct connections between members (STUN only). The member
a file is fetched from, and the one fetching it, see each other's IP address
and the transfer's size and timing. Pictures and videos are fetched by
themselves only from friends and in DMs unless the user widens or turns off
that setting, and then only from the friend who posted it (or another
friend), so a stranger in a big space can't learn your IP address by posting
a picture or by fetching a friend's picture first and offering it.

A conversation started by someone you don't know (not a friend, not someone you
asked to be friends with, not one you already have) does not connect: the app
keeps it as a **request** and joins nothing, so the sender learns nothing about
you and none of their messages are kept, until you accept it. Declining drops
it (they can ask again); blocking the sender stops that and hides their requests. Mail they left for you is
dropped, not kept (it would crowd out friends' mail on the server); their app
still holds the messages and delivers them once you accept and both are
online. At most 50 requests are kept, the newest first, so a flood can push a
real one out. The command line `get --from <name>` takes up
that person's request while it runs, because naming them is asking to receive;
without `--from` it only says who is waiting.

The **host peer** of a session sees the IP addresses of its members and the
size and timing of their encrypted frames, plus who is speaking (from the
RFC 6464 audio-level header). It holds the same keys as every other member
(it is one), but its relay component only forwards ciphertext.

**Video** (cameras and screens) takes the same path as voice, end-to-end
encrypted between members, and never goes through a server, not even the
opt-in relay: calls that need it are voice only. For video the host peer
also sees who has a camera on or shares a screen, which streams each member
watches, frame sizes and timing (video has no constant bitrate, so these
reveal roughly how much moves), and the first bytes of each VP8 frame, left
readable so it can find key frames: the frame type and, on key frames, the
picture size.

## Adversaries

| Adversary                          | Can                                                                                    | Cannot                                                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network observer                   | See that you talk to certain IPs, and traffic volume.                                  | Read content or metadata (WebRTC DTLS plus E2E; encrypted server channels). Infer speech from packet sizes (constant-bitrate Opus).                                          |
| Harvest-now, decrypt-later         | Record traffic today.                                                                  | Decrypt it with a future quantum computer: every key exchange is hybrid with ML-KEM-768.                                                                                     |
| Malicious coordination server      | Lie about presence, drop or delay signalling, refuse service, log metadata.            | Forge profiles, spaces, invites, memberships or devices (all signed); substitute a user's key (user ids are key hashes); MITM WebRTC (SDP is identity-signed); read content. |
| Malicious mesh peer server         | Same as above; as a device it claims, be made host and see members' IPs.               | Same as above; clients re-verify every record. Speak for another server.                                                                                                     |
| Mailbox operator (opt-in mailbox)  | See who left how many messages for whom, and when; drop them.                          | Read, alter or forge them (sealed to the recipient's device, signed by the sender).                                                                                          |
| Relay operator (opt-in relay)      | See relayed packet sizes and timing while the relay is in use.                         | Read or alter content.                                                                                                                                                       |
| Non-member who learns a session id | Nothing: members only share keys with devices whose membership they verify themselves. |                                                                                                                                                                              |
| Member sharing a file with you     | See your IP address while you fetch it; send you a harmful file.                       | Pass off altered blocks (each is checked against hashes its author signed); get a file posted where they aren't, even by learning its id; take another's file id.            |
| Former member                      | Keep what they already saw.                                                            | Decrypt anything after they left: sender keys are replaced on leave.                                                                                                         |
| Someone who steals a key later     | Decrypt at most the current 30-minute key period of a session.                         | Decrypt earlier messages (hash ratchets, deleted prekeys) or later ones (periodic fresh keys).                                                                               |
| Removed device                     | Keep what it already had.                                                              | Receive new keys or messages. (It still knows the account seed; see below.)                                                                                                  |
| Stolen, unlocked device            | Everything on it. Use OS disk encryption and remove the device from another one.       |                                                                                                                                                                              |

## Cryptography

- Ed25519 signatures, X25519 and ML-KEM-768 (`@noble/curves`,
  `@noble/post-quantum`), HKDF-SHA256, AES-256-GCM (`@noble/hashes`,
  `@noble/ciphers`). All audited, pure-TypeScript implementations.
- Sealed boxes to a device: X25519 and ML-KEM-768 against the device's
  current prekey (rotated weekly, secret deleted after a grace period), HKDF,
  AES-GCM; signed by the sender, and the sender's key and device and the
  recipient's prekey go into the key derivation, so whoever carries a box
  can't put their own signature on it.
- Sender keys with a per-message text ratchet and a 30-second audio ratchet,
  replaced every 30 minutes and on leave. A key is sealed with its
  recipient device and the time; a member takes it only if it is for them,
  within ten minutes of their clock, not older than the newest key from
  that sender and not one the sender has since replaced.
- Voice: per-frame AES-GCM with an authenticated SFrame-style trailer
  `(kid, generation, counter)`; constant-bitrate Opus.
  A listener takes each counter once per key (a window of the last 1024), so
  a frame it took can't be played again, not even by cutting its connection
  first. The counters are forgotten 45 seconds after the last connection that
  had the key ends; coming back later, a listener starts from the sender's
  key as last sent, so frames recorded in the minutes after that can be
  played once. A host can still hold back frames, and deliver one late.
- Video: per-frame AES-GCM with keys from the audio chain under a separate
  label; the VP8 payload header (3 bytes, 10 on key frames) stays readable
  and is authenticated with the trailer.
- Text: author-signed, Padmé-padded, encrypted with the text chain.
- Files: a random key per file, and an id that is a hash of the author and
  that key (a message with any other id is refused); 1 MiB blocks encrypted
  with AES-256-GCM (index as nonce; file id, index and a last-block flag as
  associated data);
  the hash of the encrypted blocks' SHA-256 list is in the author-signed
  manifest. Stored encrypted as received.
- Device linking: short one-time code plus a 6-digit security code compared
  on both screens, then a hybrid-encrypted, signed transfer. The code covers
  the new device's signing key and the encryption key the account is sent
  to, so a server that swaps either makes the codes differ.
- Every signature is domain-separated (`SIG_DOMAIN` in `protocol/constants.ts`).
- Local data (identity, prekeys, history) is encrypted at rest with a key
  kept in the OS keychain (Electron `safeStorage`). The desktop window is
  confined to the app's own pages, so a file dropped or opened into it cannot
  navigate the window elsewhere and read the identity seed over the IPC bridge.

## Known gaps

- Space admins: a removed admin's change made just before the removal
  reaches a server can stay on that server until the owner's next change
  (versions are last-writer-wins, and a record may be dated up to 5 minutes
  ahead). Servers that already hold the removal refuse it.
- Text channel ids are only unique within a space. A device gives an id to
  the space it joined first (leaving and rejoining counts as joining again),
  so a space that reuses another's channel id and is joined first hides the
  later space's channel on that device (messages are accepted and served only
  in the space they were written in).
- Messages written before they named their space carry only a channel id.
  They are accepted from history another member passes on, not live, and an
  updated device does not serve them (it can't tell which space they belong
  to). A member of two spaces can therefore still be shown such an old message
  in the other space's channel if it reuses the id, and a member can replay
  one into the other space's history. Updated peers don't write these, and
  old peers' new messages are refused until they update.
- Storage limits are per account, and accounts are free. A connection can only
  write its own account's records (plus notes, which are signed by one-time
  keys), but opening many connections gives many accounts, each with a
  profile of up to about 360 KB, and the mailbox quotas are per user id too.
  Servers cap connections per address, which slows this down but does not
  stop it. Anyone can also send notes, so a user's quota of unread notes can
  be filled by others, and their friend requests then wait. Copies of notes
  from other owners are let in up to twice the per-account quota, so owners
  can end up holding different notes beyond it (the servers then keep
  trying to reconcile them, which costs bandwidth until the notes expire).
- Invites: a server leaves invites out of the lists and subscriptions it gives
  clients and out of the list and term answers it gives other servers, so a
  code has to be asked for by name. That stops a client sweeping a server for
  codes; it is not a boundary against servers, which replicate invites among
  themselves and can read the ones they store.
- Linked devices share the account seed; per-device signing keys certified by
  the identity (so a removed device can no longer sign) are planned.
- Sender keys rather than MLS: good forward secrecy and 30-minute healing,
  but rekeying cost grows with group size.
- Safety-number verification is manual.
- The host peer and relay operators see traffic metadata (sizes, timing,
  speaking activity); for video the host also sees frame sizes, key frames and
  picture sizes.
- The command line tool keeps the account's keys in a file only its user can
  read (mode 600), not in an OS keychain; anyone with that user's access, or
  root, can use the account. Remove the device in the app if a machine is
  lost.
- Files are checked for integrity, not for safety: the app never opens one by
  itself, sanitises the names it suggests (no folders, and no reserved or
  trailing-dot names that would hide the real extension), and warns before
  opening programs and scripts (a wide list of executable types), but a file a
  member sends can still be harmful.

Please report vulnerabilities privately through
[GitHub's private reporting](https://github.com/pwalda/crocodile/security/advisories/new)
rather than in public issues.
