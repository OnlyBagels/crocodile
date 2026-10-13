import { describe, expect, it } from 'vitest';
import {
  FILE_BLOCK_SIZE,
  FileManifest,
  fileBlockCount,
  fileBlockPlainSize,
  fromB64u,
  toB64u,
} from '@crocodile/protocol';
import {
  blockHashAt,
  checkHashList,
  encryptFile,
  fileCipher,
  newFileId,
  newFileKey,
  sha256Async,
} from '../src';

function data(size: number) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

async function encrypt(plain: Uint8Array) {
  const id = newFileId();
  const key = newFileKey();
  const blocks: Uint8Array[] = [];
  const { hashes, root } = await encryptFile(
    { id, key, size: plain.length, read: async (o, l) => plain.slice(o, o + l) },
    async (i, b) => void (blocks[i] = b),
  );
  return { id, key, blocks, hashes, root };
}

describe('file encryption', () => {
  it('round-trips a file of several blocks, the last one short', async () => {
    const plain = data(2 * FILE_BLOCK_SIZE + 1234);
    const f = await encrypt(plain);
    expect(f.blocks).toHaveLength(3);
    expect(await checkHashList(f.hashes, plain.length, f.root)).toBe(true);
    const c = await fileCipher(f.id, f.key, plain.length);
    const out: Uint8Array[] = [];
    for (let i = 0; i < 3; i++) out.push((await c.decryptBlock(i, f.blocks[i]!))!);
    expect(Buffer.concat(out)).toEqual(Buffer.from(plain));
  });

  it('encrypts a block the same way every time, so a holder can make it again', async () => {
    const plain = data(5000);
    const f = await encrypt(plain);
    const c = await fileCipher(f.id, f.key, plain.length);
    expect(await c.encryptBlock(0, plain)).toEqual(f.blocks[0]);
  });

  it('refuses tampered, moved, truncated and foreign blocks', async () => {
    const plain = data(2 * FILE_BLOCK_SIZE + 10);
    const f = await encrypt(plain);
    const c = await fileCipher(f.id, f.key, plain.length);
    const flipped = f.blocks[0]!.slice();
    flipped[5]! ^= 1;
    expect(await c.decryptBlock(0, flipped)).toBeNull();
    // Block 1 offered as block 0 (same length).
    expect(await c.decryptBlock(0, f.blocks[1]!)).toBeNull();
    // The file cut short: block 1 passed off as the last block.
    const short = await fileCipher(f.id, f.key, 2 * FILE_BLOCK_SIZE);
    expect(await short.decryptBlock(1, f.blocks[1]!)).toBeNull();
    // Same key, another file id.
    const other = await fileCipher(newFileId(), f.key, plain.length);
    expect(await other.decryptBlock(0, f.blocks[0]!)).toBeNull();
    // Another key.
    const otherKey = await fileCipher(f.id, newFileKey(), plain.length);
    expect(await otherKey.decryptBlock(0, f.blocks[0]!)).toBeNull();
  });

  it('a hash list must match the root and the file size', async () => {
    const plain = data(FILE_BLOCK_SIZE + 1);
    const f = await encrypt(plain);
    const bad = f.hashes.slice();
    bad[0]! ^= 1;
    expect(await checkHashList(bad, plain.length, f.root)).toBe(false);
    expect(await checkHashList(f.hashes, 3 * FILE_BLOCK_SIZE, f.root)).toBe(false);
    expect(await checkHashList(f.hashes.subarray(0, 32), plain.length, f.root)).toBe(false);
    expect(blockHashAt(f.hashes, 1)).toEqual(await sha256Async(f.blocks[1]!));
  });

  it('notices a file that changes while it is read', async () => {
    const plain = data(FILE_BLOCK_SIZE + 5);
    await expect(
      encryptFile(
        {
          id: newFileId(),
          key: newFileKey(),
          size: plain.length,
          read: async (o, l) => plain.slice(o, o + l - 1),
        },
        async () => {},
      ),
    ).rejects.toThrow(/changed/);
  });

  it('handles an empty file as one empty block', async () => {
    const f = await encrypt(new Uint8Array(0));
    expect(fileBlockCount(0)).toBe(1);
    expect(fileBlockPlainSize(0, 0)).toBe(0);
    expect(f.blocks[0]).toHaveLength(16);
    const c = await fileCipher(f.id, f.key, 0);
    expect(await c.decryptBlock(0, f.blocks[0]!)).toEqual(new Uint8Array(0));
  });
});

describe('file manifests', () => {
  const base = {
    id: newFileId(),
    name: 'a.png',
    size: 10,
    type: 'image/png',
    key: newFileKey(),
    root: toB64u(new Uint8Array(32)),
  };
  it('accepts still-image thumbnails only', () => {
    expect(FileManifest.safeParse({ ...base, thumb: 'data:image/webp;base64,AAAA' }).success).toBe(
      true,
    );
    for (const thumb of [
      'data:image/svg+xml;base64,PHN2Zz4=',
      'javascript:alert(1)',
      'data:text/html;base64,PGI+',
      `data:image/png;base64,${'A'.repeat(5000)}`,
    ])
      expect(FileManifest.safeParse({ ...base, thumb }).success).toBe(false);
  });
  it('refuses sizes nobody sends, which would only make receivers allocate memory', () => {
    expect(FileManifest.safeParse({ ...base, size: 2 ** 40 }).success).toBe(true);
    expect(FileManifest.safeParse({ ...base, size: 2 ** 40 + 1 }).success).toBe(false);
    expect(FileManifest.safeParse({ ...base, size: Number.MAX_SAFE_INTEGER }).success).toBe(false);
  });
  it('wants keys and hashes of the right length', () => {
    expect(FileManifest.safeParse({ ...base, key: toB64u(new Uint8Array(16)) }).success).toBe(
      false,
    );
    expect(FileManifest.safeParse({ ...base, id: 'short' }).success).toBe(false);
    expect(fromB64u(base.key)).toHaveLength(32);
  });
});
