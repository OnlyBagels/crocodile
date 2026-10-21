import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The part of Electron's safeStorage this uses (an OS keychain). */
export interface Keychain {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Thrown when a value is stored but the keychain can't open it right now. */
export const KEYCHAIN_LOCKED = 'KEYCHAIN_LOCKED';

/**
 * Small secrets (the identity seed, prekeys, the local data key) in a JSON
 * file, each encrypted with the OS keychain.
 *
 * A value that is stored but can't be decrypted (the keychain is locked or
 * not running yet, common on Linux at login) is an error, never "missing":
 * the app would otherwise make a new data key over the old one, losing every
 * stored message, and offer to create a new account over the existing seed.
 */
export class SecureStore {
  constructor(
    private readonly path: string,
    private readonly keychain: Keychain,
  ) {}

  get(key: string): string | undefined {
    const stored = this.read()[key];
    if (stored === undefined) return undefined;
    if (stored.startsWith('raw:')) return stored.slice(4);
    if (!stored.startsWith('enc:')) return undefined;
    try {
      if (!this.keychain.isEncryptionAvailable()) throw new Error('keychain unavailable');
      return this.keychain.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch (err) {
      throw new Error(
        `${KEYCHAIN_LOCKED}: can't read "${key}" from the keychain (${String(err)})`,
        { cause: err },
      );
    }
  }

  set(key: string, value: string) {
    const data = this.read();
    data[key] = this.keychain.isEncryptionAvailable()
      ? `enc:${this.keychain.encryptString(value).toString('base64')}`
      : `raw:${value}`;
    this.write(data);
  }

  delete(key: string) {
    const data = this.read();
    delete data[key];
    this.write(data);
  }

  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(data: Record<string, string>) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(data), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
