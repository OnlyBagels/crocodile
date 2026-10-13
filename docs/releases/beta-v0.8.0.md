A beta release of Crocodile: peer-to-peer, end-to-end encrypted voice, video
and text chat. It works, but expect rough edges, and note that it hasn't had an
independent security audit yet.

## What's new in 0.8.0

- **Video calls.** Turn your camera on in a DM call or a voice room with the
  camera button. You see yourself first, pick a camera, then turn it on.
  Everyone in the call sees it as a tile; people without a camera on show as
  their picture.
- **Screen sharing.** Share a whole screen or one window. Choose **Text and
  slides** (sharp, up to 1080p, a few frames a second) or **Motion** (smooth,
  720p, 30 frames a second). Others see that you're sharing and click
  **Watch** if they want to; nobody gets a screen they didn't ask for. Watch
  it large, full screen, or in a pop-out window that stays on top while you
  do something else.
- **Share your computer's sound** with a screen, on Windows. On macOS and
  Linux, screens are shared without sound for now.
- **End-to-end encrypted, like voice.** Video goes from your computer to the
  people in the call through the device of the member who hosts it, which
  forwards it without being able to see it. It never goes through a server,
  not even the optional relay: if your connection needs the relay, the call
  stays voice only and the app tells you why.
- **Shared fairly.** The host's upload decides how much video a call can
  carry. If it's full, the streams that don't fit pause (you see that they
  are paused) and resume when there's room; cameras you already see are kept
  first.
- On macOS, Crocodile asks for access to the camera, and to screen recording
  the first time you share (_System Settings → Privacy & Security → Screen
  Recording_).
- Video needs 0.8.0 on everyone's computer, the host's in particular: with
  an older host the call stays voice only and the app says so.

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
- Turn your camera on in a call and in a voice room; share a screen in both
  qualities and watch someone else's, full screen and in a pop-out window.
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
