import {
  FILE_BLOCK_SIZE,
  concatBytes,
  bytesEqual,
  fileBlockCount,
  fileBlockPlainSize,
  fromB64u,
  toB64u,
  utf8,
} from '@crocodile/protocol';
import { hkdfSha256, randomBytes, sha256 } from './primitives';

/**
 * Encryption of file contents (ARCHITECTURE.md §8a).
 *
 * Every file gets a random 32-byte key. Its 1 MiB blocks are encrypted with
 * AES-256-GCM under a key derived from it, with the block index as nonce and
 * the file id, index and a last-block flag as associated data, so blocks can't
 * be swapped, moved or cut off. The SHA-256 hashes of the encrypted blocks are
 * listed in order, and the hash of that list (the root) goes into the signed
 * manifest: anyone holding a block can check it against the author's root
 * without trusting whoever sent it.
 *
 * Bulk work uses the platform's WebCrypto (hardware AES in Electron, Node and
 * browsers); a block is encrypted the same way every time, so a holder can
 * re-create it from the plaintext.
 */

const subtle = () => globalThis.crypto.subtle;
const AAD_PREFIX = utf8.encode('croc/v1/file-block');

/** A random id. Not for posting a file: its id must be `fileIdFor` (messages with another are refused). */
export function newFileId() {
  return toB64u(randomBytes(16));
}

/**
 * The id of a file its author posts: a hash of the author and the file's key.
 * Authors can't pass off their file under someone else's id, because the id
 * would not be the one their own key gives them.
 */
export function fileIdFor(author: string, key: string) {
  return toB64u(sha256(utf8.encode(`croc/v1/file-id\n${author}\n${key}`)).slice(0, 16));
}

export function newFileKey() {
  return toB64u(randomBytes(32));
}

function u64(n: number) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

export interface FileCipher {
  encryptBlock(index: number, plaintext: Uint8Array): Promise<Uint8Array>;
  /** Null when the block was tampered with or belongs elsewhere. */
  decryptBlock(index: number, ciphertext: Uint8Array): Promise<Uint8Array | null>;
}

export async function fileCipher(fileId: string, key: string, size: number): Promise<FileCipher> {
  const id = fromB64u(fileId);
  const raw = hkdfSha256(fromB64u(key), id, 'croc/v1/file-block', 32);
  const k = await subtle().importKey('raw', new Uint8Array(raw), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const last = fileBlockCount(size) - 1;
  const params = (index: number) => ({
    name: 'AES-GCM',
    iv: new Uint8Array(concatBytes(new Uint8Array(4), u64(index))),
    additionalData: new Uint8Array(
      concatBytes(AAD_PREFIX, id, u64(index), Uint8Array.of(index === last ? 1 : 0)),
    ),
  });
  return {
    async encryptBlock(index, plaintext) {
      if (index > last || plaintext.length !== fileBlockPlainSize(size, index))
        throw new Error('block does not belong to this file');
      return new Uint8Array(await subtle().encrypt(params(index), k, new Uint8Array(plaintext)));
    },
    async decryptBlock(index, ciphertext) {
      if (index > last) return null;
      try {
        const plain = new Uint8Array(
          await subtle().decrypt(params(index), k, new Uint8Array(ciphertext)),
        );
        return plain.length === fileBlockPlainSize(size, index) ? plain : null;
      } catch {
        return null;
      }
    },
  };
}

export async function sha256Async(bytes: Uint8Array) {
  return new Uint8Array(await subtle().digest('SHA-256', new Uint8Array(bytes)));
}

/** The root a manifest carries for a list of block hashes (32 bytes each). */
export async function fileRoot(hashList: Uint8Array) {
  return toB64u(await sha256Async(hashList));
}

/** Whether a hash list fits the file and matches the manifest's root. */
export async function checkHashList(hashList: Uint8Array, size: number, root: string) {
  if (hashList.length !== fileBlockCount(size) * 32) return false;
  return bytesEqual(fromB64u(await fileRoot(hashList)), fromB64u(root));
}

export function blockHashAt(hashList: Uint8Array, index: number) {
  return hashList.subarray(index * 32, index * 32 + 32);
}

/** Reads a file's plaintext block by block. */
export type PlainReader = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * Encrypts a whole file, handing each encrypted block to `sink` in order,
 * and returns the hash list and root for its manifest.
 */
export async function encryptFile(
  opts: { id: string; key: string; size: number; read: PlainReader },
  sink: (index: number, block: Uint8Array) => Promise<void>,
  onProgress?: (done: number) => void,
) {
  const cipher = await fileCipher(opts.id, opts.key, opts.size);
  const n = fileBlockCount(opts.size);
  const hashes = new Uint8Array(n * 32);
  for (let i = 0; i < n; i++) {
    const plain = await opts.read(i * FILE_BLOCK_SIZE, fileBlockPlainSize(opts.size, i));
    if (plain.length !== fileBlockPlainSize(opts.size, i))
      throw new Error('the file changed while it was being read');
    const block = await cipher.encryptBlock(i, plain);
    hashes.set(await sha256Async(block), i * 32);
    await sink(i, block);
    onProgress?.(Math.min(opts.size, (i + 1) * FILE_BLOCK_SIZE));
  }
  return { hashes, root: await fileRoot(hashes) };
}
