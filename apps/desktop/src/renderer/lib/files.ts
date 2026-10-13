import type { FileSource } from '@crocodile/client-core';
import { FileThumb, fileMediaKind, type FileManifest } from '@crocodile/protocol';
import { getClient } from '../croc';
import { desktop } from '../platform';

/** Pictures and videos up to this size are shown in the chat itself. */
export const INLINE_MAX = 300 * 1024 * 1024;

export function sourceOf(file: File): FileSource {
  return {
    name: file.name || 'file',
    size: file.size,
    type: file.type,
    read: async (offset, length) =>
      new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Longest side of the blurred preview that travels in the message. */
const THUMB_SIDE = 24;

function thumbOf(source: CanvasImageSource, w: number, h: number): string | undefined {
  const scale = THUMB_SIDE / Math.max(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const [type, q] of [
    ['image/webp', 0.6],
    ['image/jpeg', 0.5],
  ] as const) {
    const url = canvas.toDataURL(type, q);
    if (FileThumb.safeParse(url).success) return url;
  }
  return undefined;
}

export interface Preview {
  thumb?: string;
  w?: number;
  h?: number;
  dur?: number;
}

/** A tiny blurred preview, size and length of a picture or video. */
export async function previewOf(file: File): Promise<Preview | undefined> {
  const kind = fileMediaKind(file.type);
  try {
    if (kind === 'image') {
      const bmp = await createImageBitmap(file);
      const p = { thumb: thumbOf(bmp, bmp.width, bmp.height), w: bmp.width, h: bmp.height };
      bmp.close();
      return p;
    }
    if (kind === 'video') return await videoPreview(file);
  } catch {
    /* not something the browser can decode: send it without a preview */
  }
  return undefined;
}

function videoPreview(file: File): Promise<Preview | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const done = (p?: Preview) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      resolve(p);
    };
    const timer = setTimeout(() => done(), 5000);
    v.muted = true;
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(1, (v.duration || 0) / 3);
    };
    v.onseeked = () =>
      done({
        thumb: v.videoWidth ? thumbOf(v, v.videoWidth, v.videoHeight) : undefined,
        ...(v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : {}),
        ...(Number.isFinite(v.duration) ? { dur: v.duration } : {}),
      });
    v.onerror = () => done();
    v.src = url;
  });
}

/** Object URLs of decrypted files shown in the chat, kept while the app runs. */
const urls = new Map<string, Promise<string>>();

export function objectUrlOf(file: FileManifest): Promise<string> {
  let url = urls.get(file.id);
  if (!url) {
    url = (async () => {
      const parts: BlobPart[] = [];
      await getClient().readFile(file.id, (p) => void parts.push(new Uint8Array(p)));
      return URL.createObjectURL(
        new Blob(parts, { type: fileMediaKind(file.type) ? file.type : '' }),
      );
    })();
    url.catch(() => urls.delete(file.id));
    urls.set(file.id, url);
  }
  return url;
}

/** Forget the decrypted copy of a file (it was deleted). */
export function dropObjectUrl(id: string) {
  const url = urls.get(id);
  urls.delete(id);
  void url?.then((u) => URL.revokeObjectURL(u)).catch(() => {});
}

/**
 * Decrypts a file into a place on disk: one the user picks (save), or a
 * private temporary file the system then opens with its own app.
 */
export async function exportFile(file: FileManifest, how: 'save' | 'open') {
  const api = desktop?.files;
  if (!api) throw new Error('Saving files needs the desktop app');
  const token = how === 'save' ? await api.saveBegin(file.name) : await api.openBegin(file.name);
  if (!token) return;
  try {
    await getClient().readFile(file.id, (p) => api.chunk(token, p));
  } catch (err) {
    await api.abort(token);
    throw err;
  }
  await api.end(token, how === 'save' ? 'reveal' : 'open');
}
