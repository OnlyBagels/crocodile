# Contributing to Crocodile

Thanks for helping! A few things to know before you open a pull request.

## Contributor License Agreement

Every contributor signs the [CLA](CLA.md) once. When you open your first pull
request, a bot asks you to comment:

> I have read the CLA Document and I hereby sign the CLA

That's all. The CLA lets the project stay open source while keeping the
option to offer commercial licenses, and it guarantees your contribution
stays available under an open-source license.

## Licenses

| Part                                                                                           | License       |
| ---------------------------------------------------------------------------------------------- | ------------- |
| `packages/protocol`, `packages/crypto`                                                         | Apache-2.0    |
| everything else (client core, call host, desktop app, coordination server, directory, scripts) | AGPL-3.0-only |

The wire formats and crypto building blocks are permissive so anyone can
build compatible clients and bots. Everything else is AGPL so improvements,
including ones run as a service, come back to everyone. The maintainer also
offers commercial licences; see [COMMERCIAL.md](COMMERCIAL.md).

The [NOTICE](NOTICE) files (at the root and in `packages/protocol` and
`packages/crypto`) carry the copyright and attribution that, under the Apache
licence, must travel with every copy of the protocol and crypto code.

## Development

See the [README](README.md#development). Before pushing, run what CI runs:

```sh
pnpm check   # typecheck, lint, format and all tests
```

- Every bug fix comes with a test that fails without it.
- UI changes: run the Electron smoke test (`xvfb-run -a pnpm qa:smoke
/tmp/shots`, without `xvfb-run` on a desktop) and look at the screenshots.
- Protocol or crypto changes: read [ARCHITECTURE.md](ARCHITECTURE.md) and the
  [threat model](docs/SECURITY.md) first, and explain compatibility with older
  clients and servers in the PR.

## Security

Please report vulnerabilities privately, not in public issues: see the
[security policy](.github/SECURITY.md). The design and its threat model are
in [docs/SECURITY.md](docs/SECURITY.md).

Workflows use read-only tokens unless a job needs more, and every action is
pinned to a commit (Dependabot keeps the pins current). The repository's
GitHub settings (rulesets, secret scanning, Actions permissions) are applied
by [`.github/repo-settings.sh`](.github/repo-settings.sh), run by a repository
admin.
