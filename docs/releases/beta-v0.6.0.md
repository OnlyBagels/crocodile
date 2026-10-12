A beta release of Crocodile: peer-to-peer, end-to-end encrypted voice and
text chat. It works, but expect rough edges, and note that it hasn't had an
independent security audit yet.

## What's new in 0.6.0

**Calls**

- Hanging up ends the call for both of you. Before, the other side stayed in
  the call, with its timer running.
- The call timer and the green dot show only while a call is actually live.
  Otherwise the call says what it's doing: _Ringing…_, _Connecting…_,
  _Waiting for Bob to join_, _Reconnecting…_. A call also ends by itself if
  the other side leaves it, or stays gone for 20 seconds.
- Calls with a friend look like voice rooms: both of you on a stage above the
  chat, with mute, deafen and hang-up buttons, and _Join call_ if they're
  already in it.
- Live latency: every call member shows their round trip to the host's
  device (green, amber or red), and the call bar shows yours.

**Chat**

- Links work, including `www.` addresses and plain domains such as
  `example.com/page`. They open in your browser.
- Invite links become a card with the space's name and a **Join** button.
- **@mentions:** type `@` to pick someone. A message that mentions you
  stands out, and its notification says so.
- **Emoji:** a picker next to the send button, suggestions as you type
  `:name`, and `:shortcode:` turns into the emoji.
- Right-click menus: reply, copy, edit or delete a message, cut, copy and
  paste in text fields, spelling suggestions, and copy links.

**Sounds**

Ringing, people joining and leaving calls, hanging up, new messages and
mentions. Turn them off or set their volume under _Settings → Privacy &
alerts_. They're quiet while you're busy.

Everyone in a call should update. With an older version on the other end,
calls still work, but the live state and latency show only partly.

## Download

| System                  | File                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| Windows (x64 and ARM)   | the `.exe` installer                                                     |
| macOS (Intel and Apple) | the `.dmg` (universal)                                                   |
| Linux                   | `.AppImage`, `.deb` (Debian/Ubuntu), `.rpm` (Fedora/openSUSE), `.tar.gz` |

Or install with one line in a terminal, which avoids the warnings below; see
the [README](https://github.com/pwalda/crocodile#install).

These builds are not code-signed yet:

- **Windows:** SmartScreen says "Windows protected your PC" → _More info_ →
  _Run anyway_.
- **macOS:** open the app once, then _System Settings → Privacy & Security →
  Open Anyway_.

The app tells you when a new version is out: click **Update** in the top bar,
then **Restart to update** once it has downloaded. Two exceptions: the Linux
`.tar.gz` can't update itself, so **Download update** opens this page; and a
Mac app that can't replace itself (still on the disk image, or in a folder you
can't write to) downloads the new `.dmg` and shows **Install update**, which
opens it so you can drag Crocodile into Applications.

## Getting started

Open Crocodile, pick a name and save your recovery key. The app finds a
coordination server by itself. Add friends under _Home → Add someone_
(`name#1234`), create a space, share the invite, and talk.

Want to run your own server instead, for example on a home network? Turn on
_Settings → Host a server_ and share the address it shows; others add it
under _Settings → Network → Preferred servers_. See the
[self-hosting guide](https://github.com/pwalda/crocodile/blob/main/docs/SELF_HOSTING.md).

## What to try

- Text chat in a space and in DMs; send a DM while your friend is offline and
  see it arrive when they're back.
- Voice rooms with three or more people; leave as the host (the crown / radio
  icon) and check the others stay connected.
- Push-to-talk while another app is focused (Settings → Voice).
- Link a second computer (account menu → _Link another device_).
- Light/dark theme and accent colours (Settings → Appearance).

Found a problem? Open an
[issue](https://github.com/pwalda/crocodile/issues/new/choose) and attach
_Settings → About → Copy diagnostics_ (it contains no messages). Report
security problems
[privately](https://github.com/pwalda/crocodile/security/advisories/new).
