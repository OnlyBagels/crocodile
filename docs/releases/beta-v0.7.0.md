A beta release of Crocodile: peer-to-peer, end-to-end encrypted voice and
text chat. It works, but expect rough edges, and note that it hasn't had an
independent security audit yet.

## What's new in 0.7.0

- **Send files.** Attach files with the paperclip, drag them onto a
  conversation or paste them, in DMs and in space channels, any size. They
  go straight from your computer to the people you send them to, end-to-end
  encrypted, and never through a server, not even the optional relay.
- **Pictures and videos in the chat.** They show as a blurred preview until
  they arrive, then as the picture (click to enlarge) or a player. Up to
  10 MB they arrive by themselves from friends and in DMs; anything else
  waits for your click. Change that under _Settings → Files_.
- **Files stay available.** Anyone who downloaded a file can pass it on to
  others in the same space or DM while their app is open, so it doesn't
  disappear when the sender goes offline. A download that drops resumes
  where it stopped, and every piece is checked against what the sender
  signed. You can turn sharing off, and see and free the space files take,
  under _Settings → Files_.
- Everyone needs 0.7.0 to see files: older versions skip those messages.

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
- Send a picture, a video and a big file; close the sender's app once
  someone has downloaded it and fetch it on a third computer.
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
