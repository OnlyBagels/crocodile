# Distribution and code signing

Operating systems warn about apps from developers they can't identify. The
fix is code signing: a Developer ID from Apple for macOS, Azure Artifact
Signing for Windows. The release workflow signs as soon as the secrets in
[Setting up code signing](#setting-up-code-signing) exist; until then builds
are unsigned, and these are the ways around the warnings.

## Summary

| Platform | What users get today                                                                                  | Friction-free path without a certificate         | Proper fix                                                               |
| -------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| Windows  | Unsigned per-user installer. Downloaded from a browser, SmartScreen says "Windows protected your PC". | `install.ps1` one-liner, winget, Microsoft Store | Azure Artifact Signing (about 10 USD/month, as an organization)          |
| macOS    | Ad-hoc signed universal app. Downloaded from a browser, Gatekeeper blocks the first launch.           | `install.sh` one-liner                           | Apple Developer Program ($99/year) → Developer ID signing + notarization |
| Linux    | AppImage, .deb, .rpm, .tar.gz. No signing warnings.                                                   | `install.sh` one-liner                           | Flathub listing (nice to have)                                           |

## One-line installers (work today)

```sh
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.ps1 | iex
```

Files fetched by `curl` or PowerShell are not tagged as "downloaded from the
internet" (no quarantine attribute on macOS, no Mark-of-the-Web on Windows),
so Gatekeeper and SmartScreen do not interrupt. The scripts only download the
official release assets from GitHub over HTTPS. The website offers them next
to the regular download buttons.

## Windows

- **Browser download (unsigned):** SmartScreen shows "Windows protected your
  PC" → _More info_ → _Run anyway_. The warning fades as a file builds
  reputation, but every new version starts from zero.
- **winget:** submit a manifest to `microsoft/winget-pkgs` pointing at the
  release installer (`wingetcreate new <url>`). Users run
  `winget install Crocodile.Crocodile`. winget installs do not go through the
  browser SmartScreen prompt. Automate updates with `wingetcreate update` in
  the release workflow.
- **Microsoft Store:** individual developer accounts are free. Build an MSIX
  (`appx` target in electron-builder) and submit it; the Store signs the
  package. Note: Store builds should disable the built-in auto-updater (the
  Store updates them).
- **Azure Artifact Signing** (formerly Trusted Signing): about 10 USD a
  month, no hardware token, and electron-builder signs with it directly. This
  is the chosen fix; see [Setting up code signing](#setting-up-code-signing).
  Individuals can only use it in the US and Canada; organizations (a Polish
  JDG counts) in the EU and a few other countries. The publisher Windows
  shows is the validated business name.
- Not chosen: the **SignPath Foundation** (free for open source) excludes
  projects that also sell commercial licences, which Crocodile does
  ([COMMERCIAL.md](../COMMERCIAL.md)), and would show "SignPath Foundation" as
  the publisher. A **Certum Open Source** certificate (about 50 EUR a year,
  for individuals) works too, but its cloud key needs a phone app to unlock,
  which is awkward to automate.
- Signing doesn't silence SmartScreen on day one (not even EV certificates
  do, since 2024): the warning fades as signed downloads build the
  certificate's reputation, and unlike unsigned builds it doesn't start over
  with every version.

## macOS

- Builds are **ad-hoc signed** (`identity: '-'` in
  `apps/desktop/electron-builder.config.cjs`). That is required for Apple
  Silicon to launch the app at all, but it does not satisfy Gatekeeper.
- **Browser download:** the first launch is blocked. On macOS 15 and later:
  try to open the app once, then _System Settings → Privacy & Security →
  Open Anyway_. After that it opens normally.
- **`install.sh`:** no prompt at all (see above).
- **Updates:** Squirrel.Mac refuses updates that are not signed with a
  Developer ID, so ad-hoc builds update themselves another way (see
  [Updates from within the app](#updates-from-within-the-app)). The build
  records whether it was properly signed (`crocSigned` in the packaged
  `package.json`).
- **Homebrew:** a tap (`pwalda/homebrew-crocodile`) with a cask is easy to
  maintain, but Homebrew is phasing out casks that fail Gatekeeper, so treat
  it as a convenience for signed builds rather than a workaround.
- **Proper fix:** the Apple Developer Program (99 USD/year) gives a Developer
  ID certificate; the release workflow then signs, enables the hardened
  runtime and notarizes automatically (see
  [Setting up code signing](#setting-up-code-signing)). This is the one
  platform with no free equivalent.

## Setting up code signing

Both are optional and independent: each platform is signed once its secrets
exist (Settings → Secrets and variables → Actions), and stays unsigned
otherwise. Signing happens only in the Release workflow.

### macOS: Developer ID

1. Join the [Apple Developer Program](https://developer.apple.com/programs/)
   (99 USD/year). A sole proprietor enrolls as an individual; the publisher
   shown is then your own name.
2. Create a **Developer ID Application** certificate (Xcode → Settings →
   Accounts → Manage Certificates, or a certificate request from Keychain
   Access uploaded at developer.apple.com) and export it with its private key
   as a password-protected `.p12`.
3. Make an app-specific password for your Apple ID at
   [account.apple.com](https://account.apple.com) (Sign-In and Security), and
   note your Team ID (developer.apple.com → Membership).
4. Repository **secrets**:

   | Secret                        | Value                                                     |
   | ----------------------------- | --------------------------------------------------------- |
   | `CSC_LINK`                    | the `.p12`, base64-encoded (`base64 -i developer-id.p12`) |
   | `CSC_KEY_PASSWORD`            | the `.p12`'s password                                     |
   | `APPLE_ID`                    | your Apple ID email                                       |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password                                 |
   | `APPLE_TEAM_ID`               | the Team ID                                               |

The certificate is used for the macOS build only. Signed builds update
through Squirrel.Mac and keep the Accessibility permission across updates.

### Windows: Azure Artifact Signing

1. In the [Azure portal](https://portal.azure.com), create an **Artifact
   Signing account** (a region near you, e.g. West Europe; the Basic plan is
   enough). Its overview shows the **endpoint** (for West Europe
   `https://weu.codesigning.azure.net`).
2. In the account, request **identity validation** as an **Organization**
   with the business's registered details (for a JDG: as in CEIDG, with the
   NIP). Microsoft may ask for a recent document, such as a CEIDG extract.
   Validation takes from hours to days.
3. Once validated, create a **certificate profile** of type **Public Trust**
   for that identity. Its certificate's subject name (the validated business
   name) is the **publisher name**.
4. In Microsoft Entra ID, register an application (e.g. "crocodile-release"),
   create a **client secret** for it, and in the signing account's **Access
   control (IAM)** give it the **Certificate Profile Signer** role.
5. Repository **variables** (not secret) and **secrets**:

   | Name                   | Kind     | Value                                             |
   | ---------------------- | -------- | ------------------------------------------------- |
   | `AZURE_SIGN_ENDPOINT`  | variable | the account's endpoint                            |
   | `AZURE_SIGN_ACCOUNT`   | variable | the signing account's name                        |
   | `AZURE_SIGN_PROFILE`   | variable | the certificate profile's name                    |
   | `AZURE_SIGN_PUBLISHER` | variable | the publisher name, exactly as in the certificate |
   | `AZURE_TENANT_ID`      | secret   | the app registration's tenant (directory) ID      |
   | `AZURE_CLIENT_ID`      | secret   | the app registration's client ID                  |
   | `AZURE_CLIENT_SECRET`  | secret   | the client secret's value                         |

The client secret expires (at most two years): renew it in Entra ID and
update `AZURE_CLIENT_SECRET` before it does, or Windows builds come out
unsigned with a warning in the workflow run. The publisher name also goes
into the app, so the updater only installs versions signed by the same
publisher; installs from unsigned versions update normally.

## Linux

- No signing prompts. `install.sh` uses the `.deb` with apt, the `.rpm` with
  dnf/zypper, and falls back to an AppImage in `~/.local/bin` (AppImages need
  `libfuse2`, missing by default on some recent distributions).
- The `.deb` and `.rpm` configure Chromium's sandbox helper correctly, which
  matters on distributions that restrict unprivileged user namespaces
  (Ubuntu 24.04+). Prefer them over the tarball.
- **Flathub** would give Crocodile a place in GNOME Software and KDE
  Discover. It needs a Flatpak manifest (`org.electronjs.Electron2.BaseApp`)
  and the portals for global shortcuts (Wayland) — worth doing together with
  Wayland push-to-talk support.

## Updates from within the app

The app looks for a new release 15 seconds after it starts and every 6 hours
after that, and says so with a notification and an **Update** button in the
top bar (also in Settings → About). Nothing is downloaded until the user
clicks it; then the button shows the progress and turns into **Restart to
update**. If a call is going on, the app asks first. Code:
`apps/desktop/src/main/updates.ts` and `update-engines.ts`.

How the update is applied depends on the install:

| Install                         | How                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows installer               | electron-updater runs the new installer silently and restarts the app.                                                                                                                        |
| macOS, Developer ID signed      | electron-updater (Squirrel.Mac).                                                                                                                                                              |
| macOS, ad-hoc signed (today)    | The app downloads the release `.zip`, checks its SHA-512 against `latest-mac.yml` and the bundle's version, and after it quits a small script swaps the new `Crocodile.app` in and starts it. |
| macOS, app can't replace itself | Run from the disk image, translocated, or a folder the user can't write: the `.dmg` is downloaded (checked the same way) and opened, and the user drags Crocodile into Applications.          |
| Linux AppImage                  | electron-updater replaces the AppImage file.                                                                                                                                                  |
| Linux `.deb` / `.rpm`           | electron-updater installs the new package with `dpkg`/`rpm`, which asks for the administrator password (pkexec or sudo).                                                                      |
| Linux `.tar.gz`                 | Can't update itself: the button opens the release page.                                                                                                                                       |

Updates come only from this repository's latest GitHub release over HTTPS,
and every file is checked against the SHA-512 in that release's `latest*.yml`.
That protects against a broken download, not against someone who can publish
releases here; code signing is what would add that (see above). Because the
updater reads the latest release, publish releases as normal releases, not
pre-releases (docs/QA.md, release checklist).

To try the UI without a release, start a development build with
`CROC_FAKE_UPDATE=9.9.0` (optionally `CROC_UPDATE_FIRST_CHECK_MS=500`): it
offers a pretend version 9.9.0 whose "restart" only logs. The Electron smoke
test does this.

## Global push-to-talk permissions

- **macOS:** the first time push-to-talk is enabled, macOS asks for the
  Accessibility permission (System Settings → Privacy & Security →
  Accessibility). Without it, push-to-talk works while Crocodile is focused.
  Ad-hoc signed builds lose this permission on every update because their
  signature changes; Developer ID builds keep it.
- **Linux:** needs X11 (or XWayland focus). Pure Wayland sessions fall back to
  in-window push-to-talk until the XDG GlobalShortcuts portal is supported.
- **Windows:** works without any prompt.
