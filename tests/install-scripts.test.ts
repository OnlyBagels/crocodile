import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The release's Windows installers, in the order the GitHub API lists them.
const WINDOWS_ASSETS = [
  'Crocodile-0.2.0-win-arm64.exe',
  'Crocodile-0.2.0-win-arm64.exe.blockmap',
  'Crocodile-0.2.0-win-x64.exe',
  'Crocodile-0.2.0-win-x64.exe.blockmap',
  'Crocodile-0.2.0-win.exe',
  'Crocodile-0.2.0-win.exe.blockmap',
  'latest.yml',
];

function hasPwsh() {
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Runs scripts/install.ps1 with the network and installer calls replaced, and
// returns the file it downloaded. GitHub's runners have PowerShell, so CI
// always runs these; elsewhere they need pwsh installed.
function installWindows(assets: string[], env: Record<string, string>) {
  const temp = mkdtempSync(join(tmpdir(), 'croc-install-'));
  temps.push(temp);
  const release = JSON.stringify({
    assets: assets.map((name) => ({ name, browser_download_url: `https://example.test/${name}` })),
  });
  const stubs = `
    function Invoke-RestMethod { param($Uri) '${release}' | ConvertFrom-Json }
    function Invoke-WebRequest { param($Uri, $OutFile) Write-Output "downloaded $Uri" }
    function Start-Process { }
    function Write-Host { }
  `;
  const out = execFileSync(
    'pwsh',
    ['-NoProfile', '-Command', `${stubs}; . '${resolve('scripts/install.ps1')}'`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEMP: temp,
        PROCESSOR_ARCHITECTURE: '',
        PROCESSOR_ARCHITEW6432: '',
        ...env,
      },
    },
  );
  return /downloaded https:\/\/example\.test\/(\S+)/.exec(out)?.[1];
}

describe.skipIf(!process.env.CI && !hasPwsh())('install.ps1', () => {
  it('installs the x64 build on an x64 PC', () => {
    expect(installWindows(WINDOWS_ASSETS, { PROCESSOR_ARCHITECTURE: 'AMD64' })).toBe(
      'Crocodile-0.2.0-win-x64.exe',
    );
  });

  it('installs the ARM build on an ARM PC, also from 32-bit PowerShell', () => {
    expect(installWindows(WINDOWS_ASSETS, { PROCESSOR_ARCHITECTURE: 'ARM64' })).toBe(
      'Crocodile-0.2.0-win-arm64.exe',
    );
    expect(
      installWindows(WINDOWS_ASSETS, {
        PROCESSOR_ARCHITECTURE: 'x86',
        PROCESSOR_ARCHITEW6432: 'ARM64',
      }),
    ).toBe('Crocodile-0.2.0-win-arm64.exe');
  });

  it('falls back to the installer with both builds', () => {
    expect(
      installWindows(['Crocodile-0.2.0-win.exe', 'Crocodile-0.2.0-win.exe.blockmap'], {
        PROCESSOR_ARCHITECTURE: 'AMD64',
      }),
    ).toBe('Crocodile-0.2.0-win.exe');
  });
});

/**
 * Runs scripts/install.sh with `curl` and `uname` replaced: the release lists
 * `assets`, and every download is a tarball holding a fake program.
 */
function installUnix(args: string[], system: { os: string; arch: string }, assets: string[]) {
  const temp = mkdtempSync(join(tmpdir(), 'croc-install-sh-'));
  temps.push(temp);
  const bin = join(temp, 'bin');
  const home = join(temp, 'home');
  const fixture = join(temp, 'fixture');
  for (const d of [bin, home, fixture]) mkdirSync(d);
  for (const a of assets.filter((n) => n.endsWith('.tar.gz'))) {
    const program = join(fixture, a.replace(/\.tar\.gz$/, ''));
    writeFileSync(program, `#!/bin/sh\necho ${a}\n`);
    chmodSync(program, 0o755);
  }
  const listing = assets
    .map((n) => `"browser_download_url": "https://example.test/${n}"`)
    .join('\n');
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
if [ -z "$out" ]; then printf '%s\\n' '${listing}'; exit 0; fi
name=$(basename "$url" .tar.gz)
tar -czf "$out" -C "${fixture}" "$name"
`,
  );
  writeFileSync(
    join(bin, 'uname'),
    `#!/bin/sh\ncase "$1" in -s) echo ${system.os} ;; -m) echo ${system.arch} ;; esac\n`,
  );
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'uname'), 0o755);
  const out = execFileSync('sh', [resolve('scripts/install.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
  });
  const installed = join(home, '.local/bin/crocodile');
  return { out, program: execFileSync(installed, { encoding: 'utf8' }).trim(), installed };
}

const CLI_ASSETS = [
  'Crocodile-0.7.0-linux-x86_64.AppImage',
  'crocodile-cli-linux-arm64.tar.gz',
  'crocodile-cli-linux-x64.tar.gz',
  'crocodile-cli-macos-arm64.tar.gz',
  'crocodile-cli-windows-x64.zip',
];

describe.skipIf(process.platform === 'win32')('install.sh --cli', () => {
  it('installs the command line tool for this system and processor', () => {
    const linux = installUnix(['--cli'], { os: 'Linux', arch: 'x86_64' }, CLI_ASSETS);
    expect(linux.program).toBe('crocodile-cli-linux-x64.tar.gz');
    expect(linux.out).toMatch(/Add ~\/.local\/bin to your PATH/);
    const arm = installUnix(['--cli'], { os: 'Linux', arch: 'aarch64' }, CLI_ASSETS);
    expect(arm.program).toBe('crocodile-cli-linux-arm64.tar.gz');
    const mac = installUnix(['--cli'], { os: 'Darwin', arch: 'arm64' }, CLI_ASSETS);
    expect(mac.program).toBe('crocodile-cli-macos-arm64.tar.gz');
    expect(readFileSync(mac.installed, 'utf8')).toMatch(/^#!\/bin\/sh/);
  });

  it('points to npm when there is no build for the processor', () => {
    expect(() => installUnix(['--cli'], { os: 'Darwin', arch: 'x86_64' }, CLI_ASSETS)).toThrow(
      /npm install -g crocodile-cli/,
    );
  });
});
