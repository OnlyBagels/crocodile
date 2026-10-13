import { z } from 'zod';

/**
 * File transfers (ARCHITECTURE.md §8a).
 *
 * A file is posted as a chat message carrying a manifest: what the file is,
 * the random key its blocks are encrypted with and a hash that commits to
 * every encrypted block. The manifest travels like any message (signed by its
 * author, end-to-end encrypted, kept only on members' devices). The bytes
 * travel separately, over a direct connection between a member who wants the
 * file and one who has it; nothing about them passes through a server.
 */

/** Plaintext bytes per block. Each block is encrypted and hashed on its own. */
export const FILE_BLOCK_SIZE = 1024 * 1024;
/** AES-GCM tag appended to every encrypted block. */
export const FILE_TAG_SIZE = 16;
/** Bytes of block data per data channel message: under werift's 64 KiB limit. */
export const FILE_FRAME_SIZE = 48 * 1024;
/** Media up to this size is fetched by itself, under the auto-download setting. */
export const FILE_AUTO_DOWNLOAD_MAX = 10 * 1024 * 1024;
/** Largest file size a manifest may state (1 TiB, a million blocks). */
export const FILE_MAX_SIZE = 2 ** 40;
/** Data channel label for file links. */
export const FILE_CHANNEL_LABEL = 'croc-file';

const b64u = (bytes: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`));

export const FileId = b64u(16);

/**
 * A small preview the sender makes of a picture or video, shown blurred until
 * the file itself arrives. Only still-image data URLs are accepted.
 */
export const FileThumb = z
  .string()
  .max(4000)
  .regex(/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/);

export const FileManifest = z.object({
  id: FileId,
  /** Shown to people and offered when saving; never used as a path as is. */
  name: z.string().min(1).max(255),
  /** Up to 1 TiB: a size beyond what anyone sends would only waste memory. */
  size: z.number().int().min(0).max(FILE_MAX_SIZE),
  /** MIME type as the sender's system reported it; only a hint. */
  type: z.string().max(127),
  /** Key the blocks are encrypted with (32 bytes). */
  key: b64u(32),
  /** SHA-256 over the SHA-256 hashes of every encrypted block, in order. */
  root: b64u(32),
  thumb: FileThumb.optional(),
  /** Pixel size of a picture or video. */
  w: z.number().int().min(1).max(100_000).optional(),
  h: z.number().int().min(1).max(100_000).optional(),
  /** Length of a video or recording, in seconds. */
  dur: z.number().min(0).max(1e7).optional(),
});
export type FileManifest = z.infer<typeof FileManifest>;

export function fileBlockCount(size: number) {
  return Math.max(1, Math.ceil(size / FILE_BLOCK_SIZE));
}

/** Plaintext length of block `index`. An empty file has one empty block. */
export function fileBlockPlainSize(size: number, index: number) {
  return Math.min(FILE_BLOCK_SIZE, size - index * FILE_BLOCK_SIZE);
}

export function fileBlockCipherSize(size: number, index: number) {
  return fileBlockPlainSize(size, index) + FILE_TAG_SIZE;
}

/** Whether a file is a picture or a video the apps can preview. */
export function fileMediaKind(type: string): 'image' | 'video' | null {
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(type)) return 'image';
  if (/^video\/(mp4|webm|ogg|quicktime)$/.test(type)) return 'video';
  return null;
}

/**
 * Control messages on a file link (JSON strings). Block data and hash lists
 * follow as binary frames: a 9-byte header (kind, block index, byte offset;
 * big-endian) and up to FILE_FRAME_SIZE bytes.
 */
export const FileLinkRequest = z.discriminatedUnion('t', [
  /** The list of block hashes the manifest's root commits to. */
  z.object({ t: z.literal('hashes') }),
  /** Blocks `from` to `to` (inclusive), in order. */
  z.object({
    t: z.literal('get'),
    from: z.number().int().min(0),
    to: z.number().int().min(0),
  }),
]);
export type FileLinkRequest = z.infer<typeof FileLinkRequest>;

export const FileLinkReply = z.discriminatedUnion('t', [
  z.object({ t: z.literal('error'), reason: z.string().max(200) }),
]);
export type FileLinkReply = z.infer<typeof FileLinkReply>;

export const FILE_FRAME = { hashes: 1, block: 2 } as const;
export const FILE_FRAME_HEADER = 9;
