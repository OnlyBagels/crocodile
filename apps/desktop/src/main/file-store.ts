import { mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, open, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_BLOCK_SIZE, FILE_TAG_SIZE } from '@crocodile/protocol';

/**
 * Files on disk, for the UI (which can't touch the file system):
 *
 * - Encrypted blocks, one file per id under `<userData>/files`, each block at
 *   its fixed offset. They are stored exactly as they travel, so they need
 *   no other protection at rest; the keys live in the encrypted app store.
 * - Saving and opening: the UI decrypts and streams the plaintext here, to a
 *   path the user picked in a save dialog or to a private temporary folder.
 *   The UI never names a path itself.
 */

const ID = /^[A-Za-z0-9_-]{22}$/;
const SLOT = FILE_BLOCK_SIZE + FILE_TAG_SIZE;

function check(id: unknown, index: unknown) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('bad file id');
  if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > 2 ** 32)
    throw new Error('bad block index');
}

export class FileStore {
  constructor(private readonly dir: string) {}

  private path(id: string) {
    return join(this.dir, id);
  }

  async write(id: string, index: number, block: Uint8Array) {
    check(id, index);
    if (!(block instanceof Uint8Array) || block.length > SLOT || block.length < FILE_TAG_SIZE)
      throw new Error('bad block');
    mkdirSync(this.dir, { recursive: true });
    let f: FileHandle;
    try {
      f = await open(this.path(id), 'r+');
    } catch {
      f = await open(this.path(id), 'w+');
    }
    try {
      await f.write(block, 0, block.length, index * SLOT);
    } finally {
      await f.close();
    }
  }

  async read(id: string, index: number, length: number): Promise<Uint8Array | null> {
    check(id, index);
    if (!Number.isSafeInteger(length) || length < FILE_TAG_SIZE || length > SLOT) return null;
    let f: FileHandle;
    try {
      f = await open(this.path(id), 'r');
    } catch {
      return null;
    }
    try {
      const out = new Uint8Array(length);
      const { bytesRead } = await f.read(out, 0, length, index * SLOT);
      return bytesRead === length ? out : null;
    } finally {
      await f.close();
    }
  }

  async delete(id: string) {
    check(id, 0);
    await rm(this.path(id), { force: true });
  }

  async usage() {
    let total = 0;
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (!ID.test(name)) continue;
      // Blocks not received yet are holes, not bytes on disk.
      const s = await stat(join(this.dir, name)).catch(() => null);
      if (s) total += Math.min(s.size, s.blocks ? s.blocks * 512 : s.size);
    }
    return total;
  }
}

/** A file being written out for the user: to a picked path or a temporary one. */
interface Export {
  path: string;
  handle: FileHandle;
  temp: boolean;
}

export class FileExports {
  private open = new Map<string, Export>();
  private seq = 0;
  private tempRoot?: string;

  async begin(path: string, temp: boolean) {
    const handle = await open(path, 'w');
    const token = `x${++this.seq}`;
    this.open.set(token, { path, handle, temp });
    return token;
  }

  /** A private folder for files opened from the app; removed when the app quits. */
  async tempPath(name: string) {
    this.tempRoot ??= await mkdtemp(join(tmpdir(), 'crocodile-'));
    const dir = await mkdtemp(join(this.tempRoot, 'f'));
    return join(dir, name);
  }

  async chunk(token: string, data: Uint8Array) {
    const x = this.open.get(token);
    if (!x || !(data instanceof Uint8Array)) throw new Error('not saving');
    await x.handle.write(data);
  }

  /** Finishes the file and returns where it is. */
  async end(token: string) {
    const x = this.open.get(token);
    if (!x) throw new Error('not saving');
    this.open.delete(token);
    await x.handle.close();
    return x.path;
  }

  async abort(token: string) {
    const x = this.open.get(token);
    if (!x) return;
    this.open.delete(token);
    await x.handle.close().catch(() => {});
    await rm(x.path, { force: true });
  }

  cleanup() {
    if (this.tempRoot) rmSync(this.tempRoot, { recursive: true, force: true });
  }
}

/** Kinds of files that can run code when opened (web pages included): the app asks first. */
export const RISKY_EXTENSIONS = new Set(
  (
    'exe com scr bat cmd msi msix msp ps1 psm1 vbs vbe js jse wsf wsh hta cpl lnk url reg ' +
    'jar app pkg dmg command sh bash zsh run bin appimage deb rpm py pl rb php scpt ' +
    'docm xlsm pptm iso img html htm xhtml svg ' +
    'msc pif chm hlp inf ins isp scf sct shb ws wsc gadget application appref-ms appx ' +
    'appxbundle msixbundle settingcontent-ms library-ms search-ms searchconnector-ms diagcab ' +
    'website mht mhtml xbap jnlp vhd vhdx dll ocx sys cpl xll xlam dotm xltm potm ppsm sldm ' +
    'one pyw pyz desktop terminal webloc inetloc fileloc workflow action'
  ).split(' '),
);

/**
 * A file name the UI suggests, made safe to create and to judge by its
 * extension: no folders, no control, direction or reserved characters (":"
 * would name an NTFS stream), no dots or spaces at the ends (Windows drops
 * trailing ones, so "evil.exe." would look extensionless and still run), and
 * not a Windows device name ("nul.txt" would open the device, not a file).
 */
export function safeFileName(name: unknown): string {
  const base = typeof name === 'string' ? name.split(/[\\/]/).pop()! : '';
  const clean = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*‎‏‪-‮⁦-⁩]/g, '_')
    .slice(0, 255);
  let start = 0;
  let end = clean.length;
  while (start < end && (clean[start] === '.' || /\s/.test(clean[start]!))) start++;
  while (end > start && (clean[end - 1] === '.' || /\s/.test(clean[end - 1]!))) end--;
  const safe = clean.slice(start, end) || 'file';
  return WINDOWS_DEVICE.test(safe) ? `_${safe}` : safe;
}

/** CON, NUL, COM1 and the like are devices on Windows with or without an extension ("nul.txt"). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i;
