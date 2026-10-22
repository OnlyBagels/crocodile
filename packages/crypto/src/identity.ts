import {
  bytesEqual,
  fromB32,
  fromB64u,
  mailProofPayload,
  SIG_DOMAIN,
  toB32,
  toB64u,
  utf8,
  type MailProof,
} from '@crocodile/protocol';
import {
  ed25519,
  hkdfSha256,
  randomBytes,
  sha256,
  signPayload,
  verifyPayload,
  x25519,
} from './primitives';

/**
 * A user's (or a server's) identity. Everything derives from one 32-byte seed,
 * so the recovery key is all a user needs to move to another device.
 *
 *  - signing key: Ed25519, the seed itself
 *  - encryption key: X25519, HKDF(seed, "croc/v1/enc")
 *  - userId: base32(sha256(signing public key))[:26] (130 bits), self-certifying
 */
export interface Identity {
  seed: Uint8Array;
  signSecret: Uint8Array;
  /** Ed25519 public key, base64url. */
  publicKey: string;
  encSecret: Uint8Array;
  /** X25519 public key, base64url. */
  encPublicKey: string;
  userId: string;
}

export const USER_ID_LENGTH = 26;

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new Error('identity seed must be 32 bytes');
  const signSecret = seed.slice();
  const publicKey = toB64u(ed25519.getPublicKey(signSecret));
  const encSecret = hkdfSha256(seed, new Uint8Array(0), 'croc/v1/enc', 32);
  const encPublicKey = toB64u(x25519.getPublicKey(encSecret));
  return {
    seed: seed.slice(),
    signSecret,
    publicKey,
    encSecret,
    encPublicKey,
    userId: userIdFromKey(publicKey),
  };
}

export function createIdentity(): Identity {
  return identityFromSeed(randomBytes(32));
}

export function userIdFromKey(publicKeyB64u: string): string {
  return toB32(sha256(fromB64u(publicKeyB64u))).slice(0, USER_ID_LENGTH);
}

export function keyMatchesUserId(publicKeyB64u: string, userId: string): boolean {
  try {
    return userIdFromKey(publicKeyB64u) === userId;
  } catch {
    return false;
  }
}

/** Four-digit discriminator shown as name#1234. Not unique; a display aid. */
export function userTag(userId: string): string {
  const h = sha256(utf8.encode(`croc/v1/tag\n${userId}`));
  const n = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  return String(n % 10_000).padStart(4, '0');
}

export function sign(
  identity: Pick<Identity, 'signSecret'>,
  domain: string,
  payload: unknown,
): string {
  return signPayload(identity.signSecret, domain, payload);
}

// ---------------------------------------------------------------------------
// Recovery key: base32(seed || sha256(seed)[:3]) in groups of 4, uppercase.
// ---------------------------------------------------------------------------

export function encodeRecoveryKey(seed: Uint8Array): string {
  const check = sha256(seed).slice(0, 3);
  const all = new Uint8Array(35);
  all.set(seed, 0);
  all.set(check, 32);
  const text = toB32(all).toUpperCase();
  return text.match(/.{1,4}/g)!.join('-');
}

export function decodeRecoveryKey(text: string): Uint8Array {
  const bytes = fromB32(text.replace(/[\s-]/g, ''));
  if (bytes.length !== 35) throw new Error('Recovery key has the wrong length');
  const seed = bytes.slice(0, 32);
  if (!bytesEqual(sha256(seed).slice(0, 3), bytes.slice(32))) {
    throw new Error('Recovery key is mistyped (checksum mismatch)');
  }
  return seed;
}

// ---------------------------------------------------------------------------
// Safety numbers: compare out of band to rule out a key substitution.
// ---------------------------------------------------------------------------

export function safetyNumber(publicKeyA: string, publicKeyB: string): string {
  const [first, second] = [publicKeyA, publicKeyB].sort();
  const digest = sha256(utf8.encode(`croc/v1/safety\n${first}\n${second}`));
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const n = ((digest[i * 2]! << 8) | digest[i * 2 + 1]!) % 100_000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups.join(' ');
}

export function randomId(bytes = 10): string {
  return toB32(randomBytes(bytes));
}

/** Time-sortable id: 48-bit ms timestamp + 80 random bits, base32 (26 chars). */
export function timeId(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes.set(randomBytes(10), 6);
  return toB32(bytes);
}

export function decodeEncKey(encPublicKey: string): Uint8Array {
  const k = fromB64u(encPublicKey);
  if (k.length !== 32) throw new Error('bad X25519 key');
  return k;
}

// ---------------------------------------------------------------------------
// Device linking security code (commit, then reveal).
//
//   1. new device: picks nonce nN, sends commit = H(newKey, newEncKey, newKemKey, nN)
//   2. existing device: receives the keys and the commit, then picks nonce nE
//   3. new device: receives nE, then reveals nN
//   4. existing device: checks nN against the commit
//   both show SAS = H(newKey, newEncKey, newKemKey, accountKey, nN, nE)
//
// Both keys the account is sealed to go in: sealLink is hybrid, so a server
// that swapped only the ML-KEM key would read the seed as soon as it could
// break X25519.
//
// A six-digit code alone is 20 bits: a server that sees the new device's keys
// before choosing its own can try a million key pairs until the codes match.
// Here the server must fix its keys (by the commit) before it learns nE, and
// must pass nE on before it learns nN, so each attempt matches with
// probability 1e-6 and costs a visible failed link.
// ---------------------------------------------------------------------------

export function linkNonce(): string {
  return toB64u(randomBytes(32));
}

/** The new device's binding to its keys and nonce, sent before it sees the other nonce. */
export function linkCommitment(
  newDeviceKey: string,
  newDeviceEncKey: string,
  newDeviceKemKey: string,
  nonce: string,
): string {
  return toB64u(
    sha256(
      utf8.encode(
        `croc/v3/link-commit\n${newDeviceKey}\n${newDeviceEncKey}\n${newDeviceKemKey}\n${nonce}`,
      ),
    ),
  );
}

export function linkCommitmentValid(
  newDeviceKey: string,
  newDeviceEncKey: string,
  newDeviceKemKey: string,
  nonce: string,
  commitment: string,
): boolean {
  try {
    if (fromB64u(nonce).length !== 32) return false;
    return bytesEqual(
      fromB64u(linkCommitment(newDeviceKey, newDeviceEncKey, newDeviceKemKey, nonce)),
      fromB64u(commitment),
    );
  } catch {
    return false;
  }
}

/**
 * Six-digit code both devices show while linking. If they match, nobody
 * (including the coordination server) swapped the new device's signing key
 * or either encryption key the account is sent to. Only meaningful when the
 * existing device checked `newNonce` against the commitment it got before
 * sending `existingNonce`.
 */
export function linkSecurityCode(
  newDeviceKey: string,
  newDeviceEncKey: string,
  newDeviceKemKey: string,
  accountKey: string,
  newNonce: string,
  existingNonce: string,
): string {
  const d = sha256(
    utf8.encode(
      `croc/v3/link-sas\n${newDeviceKey}\n${newDeviceEncKey}\n${newDeviceKemKey}\n${accountKey}\n${newNonce}\n${existingNonce}`,
    ),
  );
  const n = ((d[0]! << 16) | (d[1]! << 8) | d[2]!) % 1_000_000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

export function randomDeviceId(): string {
  return toB32(randomBytes(10));
}

// ---------------------------------------------------------------------------
// Mailbox proofs: a device's signature on a mailbox request, so servers other
// than its own act on it only for that device (MailProof).
// ---------------------------------------------------------------------------

export function signMailProof(
  identity: Pick<Identity, 'signSecret' | 'publicKey'>,
  req: Parameters<typeof mailProofPayload>[0],
  at = Date.now(),
): MailProof {
  return {
    key: identity.publicKey,
    at,
    sig: sign(identity, SIG_DOMAIN.mail, mailProofPayload(req, at)),
  };
}

/** Whether `proof` is a recent signature by `peer`'s account on `req`. */
export function verifyMailProof(
  peer: string,
  req: Parameters<typeof mailProofPayload>[0],
  proof: MailProof | undefined,
  now = Date.now(),
  maxAgeMs = 5 * 60_000,
): boolean {
  if (!proof || Math.abs(now - proof.at) > maxAgeMs) return false;
  if (!keyMatchesUserId(proof.key, peer.split('.')[0]!)) return false;
  return verifyPayload(proof.key, SIG_DOMAIN.mail, mailProofPayload(req, proof.at), proof.sig);
}
