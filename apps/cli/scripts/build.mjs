// Bundles the command line tool into one file with no dependencies: what npm
// installs, and what the standalone binaries embed (scripts/sea.mjs).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version =
  process.env.CROC_CLI_VERSION ??
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

await build({
  entryPoints: [join(root, 'src/bin.ts')],
  outfile: join(root, 'dist/crocodile.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  legalComments: 'linked',
  banner: { js: '#!/usr/bin/env node' },
  define: { 'process.env.CROC_CLI_VERSION': JSON.stringify(version) },
  logLevel: 'warning',
});
console.log(`built dist/crocodile.cjs (${version})`);
