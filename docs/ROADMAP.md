# Roadmap

What Crocodile does today and what comes next. Priorities change as testers
report what matters most; issues and discussions are welcome.

## Done

- Identity without passwords (recovery key), profiles, friends, blocking.
- Spaces with text channels and voice rooms, invites, bans, owner settings.
- E2E group text with peer-to-peer history sync; DMs including delivery after
  the friend was offline.
- E2E voice through the elected host's relay with speaker slots, speaking
  indicators, mute/deafen, voice activity and push-to-talk (system-wide on
  Windows, macOS and X11, including mouse side buttons), device selection.
- DM calls with ringing.
- Host election with a backup, failover on disconnect or member reports.
- Coordination server mesh (replication, presence, routing, session
  ownership), directory with reachability checks, built-in STUN.
- Hybrid post-quantum key exchange everywhere, ratcheting sender keys,
  prekeys with forward secrecy, padding, constant-bitrate voice, encrypted
  client↔server and server↔server channels, encryption at rest.
- Multiple devices per account: linking with a code and security check,
  per-device keys for message delivery, renaming and removal.
- Opt-in relay through coordination servers for networks that block direct
  connections (hour-long windows renewed while still needed, capped users
  per server).
- Offline delivery: a per-device outbox exchanged peer-to-peer with
  acknowledgements, and an opt-in server mailbox for DMs (sealed per device,
  up to 7 days, works across the server mesh).
- Account deletion: erased from every server in the mesh, other devices
  signed out; per-account record quotas on servers.
- Friend lists hidden from servers: each list is encrypted for its owner's
  devices, and requests and answers travel as sealed notes that don't name
  their sender.
- Main server deployment: directory, install scripts, a first coordinator
  and a placeholder page (`deploy/main`).
- Desktop app for Windows, macOS and Linux with its own design (light and
  dark themes, accents), installers, auto-update, one-line install scripts
  and an embedded coordination server.

## Next

1. **Per-device signing keys** certified by the identity, so removing a
   device fully revokes it.
2. **Better reachability.** UPnP / NAT-PMP / PCP port mapping on hosts, IPv6
   preference, TURN over TCP/TLS for UDP-blocked networks, pre-warming the
   backup host for sub-second failover.
3. **MLS (RFC 9420)** for very large spaces.
4. **Roles and permissions**: moderators with delegated signing certificates,
   channel permissions, kicking from voice.
5. **Rich content**: attachments sent P2P (chunked over data channels),
   reactions, mentions, on-device search.
6. **Screen share, then video and remote control.** Screen sharing first,
   one sharer per voice room; then 1:1 and group video; remote control last,
   view-only by default and only between friends who allow it each time.
7. **Wayland global shortcuts** (XDG GlobalShortcuts portal) and Flathub.
8. **Less metadata on servers**: private space memberships, and keeping the
   connected server from seeing whose presence an app follows and whom it
   befriends or messages (for example presence exchanged between friends directly).
9. **A mesh that scales**: keep each record on a few servers chosen by
   rendezvous hashing instead of on all of them, with a sparse, always
   connected overlay that routes requests, instead of every server linking
   to every other.
10. **Server-side hardening**: abuse reporting for public directories
    (per-IP connection limits and per-account record quotas are done).
11. **Store and signing path** (see [DISTRIBUTION.md](DISTRIBUTION.md)):
    Microsoft Store listing (MSIX, signed by the Store, with the built-in
    updater disabled) plus winget; Apple Developer Program for Developer ID
    signing, notarization and updates that keep macOS permissions (unsigned
    builds update in place but lose the Accessibility permission); Azure
    Artifact Signing for the direct Windows download. The release workflow is
    ready for both; they start once the accounts exist. Until then: the
    one-line installers.

## Paused

- **Mobile (iOS/Android) and a web client.** Assessed and paused. Both first
  need a way to hold calls when nobody in them is on the
  desktop app: direct calls for DMs and small groups, or a cloud call host.
  A wrapped web build (Capacitor) is the likely route for mobile, since it
  keeps the browser's frame encryption for voice.

## Open questions

- Mailbox for spaces (today DMs only): sealing to every member's devices is
  costly for big spaces; a per-space rotating mailbox key is one option.
