import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_BLOCK_SIZE } from '@crocodile/protocol';
import { newFileId } from '@crocodile/crypto';
import { FileExports, FileStore, RISKY_EXTENSIONS } from '../apps/desktop/src/main/file-store';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'croc-files-'));
  dirs.push(d);
  return d;
}

const block = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe('desktop file store', () => {
  it('keeps each block at its place, whatever order they arrive in', async () => {
    const store = new FileStore(tempDir());
    const id = newFileId();
    const full = FILE_BLOCK_SIZE + 16;
    await store.write(id, 2, block(100, 3));
    await store.write(id, 0, block(full, 1));
    await store.write(id, 1, block(full, 2));
    expect(await store.read(id, 0, full)).toEqual(block(full, 1));
    expect(await store.read(id, 1, full)).toEqual(block(full, 2));
    expect(await store.read(id, 2, 100)).toEqual(block(100, 3));
    // Past the end, or a file that isn't there.
    expect(await store.read(id, 3, 100)).toBeNull();
    expect(await store.read(newFileId(), 0, 100)).toBeNull();
    await store.delete(id);
    expect(await store.read(id, 0, full)).toBeNull();
  });

  it('refuses ids that could name other files, and odd blocks', async () => {
    const store = new FileStore(tempDir());
    for (const id of ['../secure.json', 'a/b', '', 'x'.repeat(22) + '/'])
      await expect(store.write(id, 0, block(32, 1))).rejects.toThrow(/bad file id/);
    await expect(store.write(newFileId(), -1, block(32, 1))).rejects.toThrow(/index/);
    await expect(store.write(newFileId(), 0, block(FILE_BLOCK_SIZE + 17, 1))).rejects.toThrow();
    await expect(store.delete('../../etc')).rejects.toThrow(/bad file id/);
  });

  it('counts the space blocks take, not the holes of a partial download', async () => {
    const store = new FileStore(tempDir());
    const id = newFileId();
    await store.write(id, 9, block(1000, 7));
    expect(await store.usage()).toBeLessThan(64 * 1024);
  });
});

describe('saving files', () => {
  it('writes what it is given to the chosen path, or nothing when stopped', async () => {
    const x = new FileExports();
    const path = join(tempDir(), 'out.txt');
    const t = await x.begin(path, false);
    await x.chunk(t, new TextEncoder().encode('hello '));
    await x.chunk(t, new TextEncoder().encode('world'));
    expect(await x.end(t)).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('hello world');
    const other = join(tempDir(), 'stopped.txt');
    const t2 = await x.begin(other, false);
    await x.chunk(t2, new Uint8Array(5));
    await x.abort(t2);
    expect(() => readFileSync(other)).toThrow();
    await expect(x.chunk('nope', new Uint8Array(1))).rejects.toThrow();
  });

  it('opens files in a private temporary folder, cleared at quit', async () => {
    const x = new FileExports();
    const p = await x.tempPath('report.pdf');
    expect(p.endsWith('report.pdf')).toBe(true);
    expect(p.startsWith(tmpdir())).toBe(true);
    const t = await x.begin(p, true);
    await x.end(t);
    x.cleanup();
    expect(() => readFileSync(p)).toThrow();
  });

  it('asks before opening programs and scripts', () => {
    for (const ext of ['exe', 'bat', 'ps1', 'sh', 'app', 'jar', 'lnk', 'docm'])
      expect(RISKY_EXTENSIONS.has(ext)).toBe(true);
    for (const ext of ['pdf', 'png', 'txt', 'mp4', 'zip'])
      expect(RISKY_EXTENSIONS.has(ext)).toBe(false);
  });
});
