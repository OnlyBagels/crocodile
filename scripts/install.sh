#!/bin/sh
# Crocodile installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.sh | sh
#
# Downloads the latest release from GitHub and installs it:
#   macOS  -> /Applications/Crocodile.app (or ~/Applications)
#   Linux  -> the .deb/.rpm through your package manager, or an AppImage
#             in ~/.local/bin when neither apt nor dnf/zypper is available.
#
# The command line tool instead (to ~/.local/bin/crocodile):
#
#   curl -fsSL https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.sh | sh -s -- --cli
# Files fetched with curl are not quarantined, so macOS does not show the
# "unidentified developer" warning for builds without an Apple Developer ID.
set -eu

REPO="${CROC_REPO:-pwalda/crocodile}"
API="https://api.github.com/repos/$REPO/releases/latest"
WHAT="${CROC_INSTALL:-app}"
for a in "$@"; do
  case "$a" in
    --cli) WHAT=cli ;;
  esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

need curl
os=$(uname -s)
arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch_re='(x64|x86_64|amd64)' ;;
  arm64 | aarch64) arch_re='(arm64|aarch64)' ;;
  *) die "unsupported CPU architecture: $arch" ;;
esac

say "Looking up the latest Crocodile release"
assets=$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$assets" ] || die "could not read the release list from GitHub"

pick() { printf '%s\n' "$assets" | grep -E -e "$1" | grep -v '\.blockmap$' | head -n 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ "$WHAT" = cli ]; then
  case "$os" in
    Darwin) cli_os=macos ;;
    Linux) cli_os=linux ;;
    *) die "unsupported system: $os (on Windows use install.ps1)" ;;
  esac
  case "$arch" in
    x86_64 | amd64) cli_arch=x64 ;;
    *) cli_arch=arm64 ;;
  esac
  name="crocodile-cli-$cli_os-$cli_arch"
  url=$(pick "/$name\.tar\.gz$")
  [ -n "$url" ] || die "no command line build for $cli_os $cli_arch; with Node.js 22 or newer: npm install -g crocodile-cli"
  say "Downloading $(basename "$url")"
  curl -fL --progress-bar "$url" -o "$tmp/cli.tar.gz"
  tar -xzf "$tmp/cli.tar.gz" -C "$tmp"
  mkdir -p "$HOME/.local/bin"
  cp "$tmp/$name" "$HOME/.local/bin/crocodile"
  chmod 755 "$HOME/.local/bin/crocodile"
  say "Installed ~/.local/bin/crocodile"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) say "Add ~/.local/bin to your PATH to run it as crocodile" ;;
  esac
  say "Done. Start with: crocodile help"
  exit 0
fi

case "$os" in
  Darwin)
    url=$(pick '-mac-(universal|'"${arch_re#(}"'\.zip$')
    [ -n "$url" ] || die "no macOS download found"
    say "Downloading $(basename "$url")"
    curl -fL --progress-bar "$url" -o "$tmp/croc.zip"
    dest=/Applications
    [ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
    rm -rf "$dest/Crocodile.app"
    ditto -x -k "$tmp/croc.zip" "$dest"
    say "Installed to $dest/Crocodile.app"
    open "$dest/Crocodile.app"
    ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1 && url=$(pick "$arch_re"'\.deb$') && [ -n "$url" ]; then
      say "Downloading $(basename "$url")"
      curl -fL --progress-bar "$url" -o "$tmp/crocodile.deb"
      say "Installing (you may be asked for your password)"
      sudo apt-get install -y "$tmp/crocodile.deb"
    elif { command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; } &&
      url=$(pick "$arch_re"'\.rpm$') && [ -n "$url" ]; then
      say "Downloading $(basename "$url")"
      curl -fL --progress-bar "$url" -o "$tmp/crocodile.rpm"
      say "Installing (you may be asked for your password)"
      if command -v dnf >/dev/null 2>&1; then sudo dnf install -y "$tmp/crocodile.rpm"; else sudo zypper --non-interactive install --allow-unsigned-rpm "$tmp/crocodile.rpm"; fi
    else
      url=$(pick "$arch_re"'\.AppImage$')
      [ -n "$url" ] || die "no Linux download found for $arch"
      mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
      say "Downloading $(basename "$url")"
      curl -fL --progress-bar "$url" -o "$HOME/.local/bin/Crocodile.AppImage"
      chmod +x "$HOME/.local/bin/Crocodile.AppImage"
      cat >"$HOME/.local/share/applications/crocodile.desktop" <<DESKTOP
[Desktop Entry]
Name=Crocodile
Comment=Peer-to-peer, end-to-end encrypted voice and text chat
Exec=$HOME/.local/bin/Crocodile.AppImage %U
Terminal=false
Type=Application
Categories=Network;Chat;InstantMessaging;
MimeType=x-scheme-handler/croc;
StartupWMClass=Crocodile
DESKTOP
      command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" || true
      say "Installed to ~/.local/bin/Crocodile.AppImage (AppImages need libfuse2)"
    fi
    say "Done. Open Crocodile from your applications menu."
    ;;
  *) die "unsupported system: $os (on Windows use install.ps1)" ;;
esac
