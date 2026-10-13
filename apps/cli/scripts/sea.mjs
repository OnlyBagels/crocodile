// Builds a standalone executable for this machine's system and processor:
// Node's single executable applications with the bundled tool inside, so
// people can run it without installing Node. Run after scripts/build.mjs.
// Writes dist/crocodile-cli-<os>-<arch>[.exe].
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
if (!os) throw new Error(`no standalone build for ${process.platform}`);
const exe = join(dist, `crocodile-cli-${os}-${process.arch}${os === 'windows' ? '.exe' : ''}`);
const blob = join(dist, 'sea-prep.blob');
const config = join(dist, 'sea-config.json');

writeFileSync(
  config,
  JSON.stringify({
    main: join(dist, 'crocodile.cjs'),
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);
// The copied binary is signed; a signature over different contents is worse than none.
if (os === 'macos') execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });

const postject = createRequire(join(root, 'package.json')).resolve('postject/dist/cli.js');
execFileSync(
  process.execPath,
  [
    postject,
    exe,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(os === 'macos' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit' },
);
// macOS refuses to run unsigned arm64 code: an ad-hoc signature is enough to run.
if (os === 'macos') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
rmSync(blob);
rmSync(config);
console.log(`built ${exe}`);
