# Quality assurance

How Crocodile is tested, and how to test it by hand before a release.

## Layers

| Layer                | What it covers                                                                                                                                    | Where                                              | Runs             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------- |
| Static checks        | Types, lint (incl. React hooks rules), formatting                                                                                                 | `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | every PR         |
| Unit tests           | Crypto (seal, ratchets, prekeys, padding), records, election, TURN, store                                                                         | `packages/*/test`                                  | every PR         |
| Integration tests    | Real coordinators (single and mesh), clients with a fake relay network: chat, DMs, failover, devices, relay grants, outbox, mailbox, abuse limits | `tests/*.test.ts`                                  | every PR         |
| Real-browser E2E     | Chromium WebRTC to the werift host relay with encoded-transform E2EE; Chromium through our TURN server                                            | `tests/browser.test.ts`                            | every PR         |
| Electron E2E (smoke) | The **packaged** app: onboarding, spaces, invites, chat, voice, friends, settings, diagnostics, device linking, no-server start                   | `tests/electron/smoke.ts`                          | every PR (Linux) |
| Packaging            | Unpacked builds for Windows, macOS, Linux; server bundles and Docker images                                                                       | CI `desktop`, `servers` jobs                       | every PR         |
| Manual QA            | Real networks, real audio, several machines and OSes                                                                                              | this document                                      | before a release |

Coverage is reported on every CI run (job summary and `coverage` artifact).
The thresholds in `vitest.config.ts` are a ratchet: raise them when coverage
grows, never lower them to get a PR green.

## Commands

```sh
pnpm check                 # everything CI's test job runs: typecheck, lint, format, tests
pnpm test                  # tests only (browser tests run when Chromium is available)
pnpm test:coverage         # tests + coverage report in coverage/index.html
pnpm vitest run tests/offline.test.ts -t mailbox   # one file / one test

pnpm qa:env                # local network: directory + 3 meshed coordinators
pnpm qa:app alice bob      # app instances with their own profiles (~/.crocodile-qa/<name>)
pnpm qa:app carol --reset --no-directory   # fresh profile, no server list (first-run path)
xvfb-run -a pnpm qa:smoke /tmp/shots        # the Electron smoke test (Linux; drop xvfb-run on a desktop)
xvfb-run -a -s '-screen 0 3000x2000x24' pnpm qa:showcase /tmp/showcase  # website and store screenshots
```

`pnpm qa:env` enables the relay and mailbox and allows the relay to reach
loopback addresses (everything runs on one machine). Other machines on your
network can join by adding `http://<your LAN IP>:7443` under Settings →
Network → Preferred servers.

Set `DBG=1` to print client logs in integration tests.

## Writing tests

- A bug fix comes with a test that fails without the fix.
- Protocol, crypto and server behaviour: integration tests in `tests/` with
  real coordinators (`startCoordinator`) and clients (`CrocodileClient` with
  `FakeRelayNetwork`), not mocks of our own code.
- UI flows: extend `tests/electron/smoke.ts`; select elements by role, label
  or visible text (what a user sees), not by CSS classes.
- Timing: wait for conditions (`waitFor`), never fixed sleeps, except to
  prove that something does _not_ happen.
- Never skip, disable or loosen a failing test to get green. A flaky test is
  a bug in the test or the code.

## Manual test matrix (before each release)

Use at least two machines on **different networks** (e.g. home Wi-Fi and a
phone hotspot) and one on the same network. Record results in the release
issue.

| #   | Scenario                                                                                  | Win | macOS | Linux |
| --- | ----------------------------------------------------------------------------------------- | --- | ----- | ----- |
| 1   | Fresh install, first launch, create account, save recovery key                            |     |       |       |
| 2   | Install over the previous version; data and account kept                                  |     |       |       |
| 3   | Add a friend by `name#tag`, accept, DM both ways                                          |     |       |       |
| 4   | DM while the friend is offline; delivered when both are online                            |     |       |       |
| 5   | Same with the mailbox on: delivered while the sender is offline                           |     |       |       |
| 6   | Create a space, invite by link, join from another machine                                 |     |       |       |
| 7   | Voice room with 3+ people on different networks; audio both ways                          |     |       |       |
| 8   | Host leaves the room; others keep talking within a few seconds                            |     |       |       |
| 9   | DM call: ring, accept, hang up; decline                                                   |     |       |       |
| 10  | Push-to-talk with another app focused; mouse side button                                  |     |       |       |
| 11  | Mute, deafen, device switching, output volume                                             |     |       |       |
| 12  | Link a second device; messages and spaces appear on both                                  |     |       |       |
| 13  | Remove a device; it stops receiving                                                       |     |       |       |
| 14  | Restore an account from the recovery key                                                  |     |       |       |
| 15  | Host a server from Settings; a friend connects by address                                 |     |       |       |
| 16  | Strict network (UDP blocked except the relay): relay opt-in works, 1-hour prompt appears  |     |       |       |
| 17  | Laptop sleep / Wi-Fi off and on: reconnects, messages catch up                            |     |       |       |
| 18  | Light/dark theme, accent, compact messages; window resizing                               |     |       |       |
| 19  | Unsigned-build warnings match docs/DISTRIBUTION.md                                        |     |       |       |
| 20  | From the previous release: Update appears, downloads, Restart to update opens the new one |     |       |       |

Useful network conditions to try: two NATs (home + mobile), a VPN, IPv6-only
hotspot, a captive/office network that blocks UDP, and packet loss
(`sudo tc qdisc add dev <if> root netem loss 5% delay 80ms` on Linux).

## Release checklist

1. `main` is green (CI, including the Electron E2E job).
2. Manual matrix above done on the release candidate (an unpublished draft
   release, or a `pnpm dist` build).
3. `docs/releases/<tag>.md` written (what changed, known issues) and merged
   before tagging, or rely on `docs/releases/default.md`. The notes come from
   the tagged commit.
4. Tag the latest `main` and push the tag: `beta-vX.Y.Z` during the beta,
   `vX.Y.Z` after it. Tag `origin/main` explicitly, so the tag can't land on
   whatever branch is checked out (tags can't be moved or deleted):
   `git fetch origin && git tag beta-vX.Y.Z origin/main && git push origin beta-vX.Y.Z`.
   The Release workflow creates a draft with the notes from step 3, uploads
   every platform's files and publishes it once all are in. (Publishing a release
   with a new tag in the GitHub UI works too.) It must be a normal release,
   not a pre-release: the apps' updater, the website and the install scripts
   only look at the latest release. Only repository admins can create
   release tags. Watch the workflow and
   check every platform's files are attached, including the `latest*.yml`
   files the updater reads.
5. Install from the release page on each OS once more (smoke: sign in, send a
   message, join voice).
6. Update the main server (`deploy/main`: `git pull && docker compose up -d --build`).

## Bug reports

Testers use the issue form (Bug report). The most useful attachment is
Settings → About → **Copy diagnostics**: versions, connection and session
state and the last 300 client log lines, without message content or keys.
Triage labels: `bug`, area (voice, chat, offline, devices, network,
install), and `release-blocker` for anything in the manual matrix.
