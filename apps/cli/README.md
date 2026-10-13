# crocodile

[Crocodile](https://crocodilechat.com) on the command line: send and receive
files peer-to-peer, end-to-end encrypted. Files go straight from one computer
to the other, never through a server, and arrive in the Crocodile app like any
file someone sends you.

```sh
crocodile send holiday.mp4 --to alice#1234
crocodile get --from bob#5678
```

## Install

With Node.js 22 or newer:

```sh
npm install -g crocodile-cli
```

Or a standalone program, no Node.js needed (Linux and macOS on ARM, Linux and
Windows on x64):

```sh
curl -fsSL https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.sh | sh -s -- --cli
```

```powershell
$env:CROC_INSTALL='cli'; irm https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.ps1 | iex
```

## Set up

Once per computer, either:

- `crocodile link`: use your own account. It shows a code; in the Crocodile app
  on a computer where you're signed in, open the account menu, choose **Link
  another device** and type it, then check both show the same security code.
- `crocodile init <name>`: make a separate account for this computer, for
  example for a server or a script. It prints a recovery key; keep it if you
  want to restore the account elsewhere.

`crocodile whoami` shows which account the computer uses.

## Send and receive

```sh
crocodile send report.pdf photos.zip --to alice#1234 -m "the files from today"
```

Sends the files in your direct conversation with alice#1234, who gets them in
the app (or with `crocodile get`). The files are read from where they are, not
copied, and go from this computer to hers, so the command keeps running until
she has downloaded every one. If she's offline, they wait until she's back.

```sh
crocodile get                       # the next file anyone sends you
crocodile get --from bob#5678 -d ~/Downloads --keep
```

Waits for a file sent to you in a direct conversation, downloads it straight
from the sender, checks it and saves it, then prints the path (so scripts can
use it). `--keep` goes on receiving until you stop it.

Run `crocodile help <command>` for details. Other options: `--profile <name>`
for a separate account on the same computer, `--server <url>` to use a
particular coordination server, `-v` to see what's happening underneath.

## How it works

The tool is a small Crocodile client: the same code as the desktop app, run in
Node.js with [werift](https://github.com/shinyoshiaki/werift-webrtc) for WebRTC.
A file is posted as an end-to-end encrypted message carrying its key and the
hashes of its encrypted 1 MiB blocks; the receiver connects to the sender
directly (never through a relay), fetches the blocks, and checks each against
what the sender signed. See
[ARCHITECTURE.md](https://github.com/pwalda/crocodile/blob/main/ARCHITECTURE.md#8a-files).

Your account's keys are kept in `~/.config/crocodile-cli` (Linux),
`~/Library/Application Support/crocodile-cli` (macOS) or
`%APPDATA%\crocodile-cli` (Windows), readable only by you; set
`CROCODILE_HOME` to keep them elsewhere. Anyone who can read that folder can
use the account, so remove the device in the app if a computer is lost.

## License

AGPL-3.0-only. Report security problems
[privately](https://github.com/pwalda/crocodile/security/advisories/new).
