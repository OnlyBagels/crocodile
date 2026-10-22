import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import {
  SIG_DOMAIN,
  concatBytes,
  fromB64u,
  peerIds,
  toB64u,
  utf8,
  type AnonBox,
  type LinkBox,
  type PrekeyBundle,
  type SealedBox,
} from '@crocodile/protocol';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdfSha256,
  randomBytes,
  verifyPayload,
  x25519,
} from './primitives';
import { decodeEncKey, keyMatchesUserId, sign, type Identity } from './identity';
import { pad, unpad } from './padding';
import { prekeySecrets, type PrekeySecret } from './prekeys';

/**
 * Hybrid post-quantum sealed box to one device:
 *
 *   ss = X25519(ephemeral, prekey.x25519) ‖ ML-KEM-768.encaps(prekey.mlkem)
 *   key, nonce = HKDF-SHA256(ss, salt = epk ‖ kem ‖ prekey ids)
 *   ct = AES-256-GCM(key, nonce, pad(plaintext))
 *   sig = Ed25519(sender, everything above + recipient)
 *
 * Breaking it needs both X25519 and ML-KEM broken ("harvest now, decrypt
 * later" resistant); prekeys rotate weekly and their secrets are deleted, so
 * old boxes stay sealed even if a device is later compromised.
 */
function boxKey(
  ssX: Uint8Array,
  ssKem: Uint8Array,
  epk: Uint8Array,
  kem: Uint8Array,
  to: string,
  pk: number,
  info: string = SIG_DOMAIN.sealed,
) {
  const salt = concatBytes(epk, kem, new TextEncoder().encode(`${to}|${pk}`));
  const okm = hkdfSha256(concatBytes(ssX, ssKem), salt, info, 44);
  return { key: okm.slice(0, 32), nonce: okm.slice(32, 44) };
}

function signedPart(box: Omit<SealedBox, 'sig'>, recipientX25519: string) {
  return {
    v: box.v,
    to: box.to,
    pk: box.pk,
    epk: box.epk,
    kem: box.kem,
    ct: box.ct,
    from: box.from,
    fromDevice: box.fromDevice,
    rx: recipientX25519,
  };
}

export function sealToDevice(
  sender: Identity,
  senderDevice: string,
  recipient: { peer: string; prekey: PrekeyBundle },
  plaintext: Uint8Array,
): SealedBox {
  const ephSecret = randomBytes(32);
  const epk = x25519.getPublicKey(ephSecret);
  const ssX = x25519.getSharedSecret(ephSecret, fromB64u(recipient.prekey.x25519));
  const { cipherText: kem, sharedSecret: ssKem } = ml_kem768.encapsulate(
    fromB64u(recipient.prekey.mlkem),
  );
  const { key, nonce } = boxKey(ssX, ssKem, epk, kem, recipient.peer, recipient.prekey.id);
  const ct = aesGcmEncrypt(key, nonce, pad(plaintext));
  const unsigned = {
    v: 2 as const,
    to: recipient.peer,
    pk: recipient.prekey.id,
    epk: toB64u(epk),
    kem: toB64u(kem),
    ct: toB64u(ct),
    from: sender.publicKey,
    fromDevice: senderDevice,
  };
  return {
    ...unsigned,
    sig: sign(sender, SIG_DOMAIN.sealed, signedPart(unsigned, recipient.prekey.x25519)),
  };
}

export interface OpenedBox {
  /** Verified sender peer id. */
  from: string;
  fromUser: string;
  fromKey: string;
  plaintext: Uint8Array;
}

export function openSealed(
  me: { peer: string },
  prekeys: (id: number) => PrekeySecret | undefined,
  box: SealedBox,
  fromUserId: (key: string) => string,
): OpenedBox | null {
  if (box.to !== me.peer) return null;
  const pk = prekeys(box.pk);
  if (!pk) return null;
  if (!verifyPayload(box.from, SIG_DOMAIN.sealed, signedPart(box, pk.bundle.x25519), box.sig))
    return null;
  try {
    const secrets = prekeySecrets(pk);
    const epk = fromB64u(box.epk);
    const kem = fromB64u(box.kem);
    const ssX = x25519.getSharedSecret(secrets.x25519, epk);
    const ssKem = ml_kem768.decapsulate(kem, secrets.mlkem);
    const { key, nonce } = boxKey(ssX, ssKem, epk, kem, box.to, box.pk);
    const padded = aesGcmDecrypt(key, nonce, fromB64u(box.ct));
    const plaintext = padded && unpad(padded);
    if (!plaintext) return null;
    const fromUser = fromUserId(box.from);
    return { from: peerIds.make(fromUser, box.fromDevice), fromUser, fromKey: box.from, plaintext };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Anonymous boxes: like sealToDevice, but the sender's identity and signature
// travel inside the encryption, so whoever stores or forwards the box sees
// only the recipient device.
//
//   inner = { from, fromDevice, sig, p }
//   sig = Ed25519(sender, { v, to, pk, epk, kem, rx, from, fromDevice, p })
//   ct = AES-256-GCM(key, nonce, json(inner) padded to 256-byte blocks)
//
// The signature binds the recipient device and this encapsulation, so the
// recipient can't pass the box on to someone else as if it were sent to them.
// ---------------------------------------------------------------------------

/**
 * Padded to whole 256-byte blocks: the small payloads these carry (a friend
 * request or its answer) all look the same size. unpad() reverses it.
 */
function padBlocks(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil((data.length + 1) / 256) * 256);
  out.set(data, 0);
  out[data.length] = 0x80;
  return out;
}

export function sealAnonymous(
  sender: Identity,
  senderDevice: string,
  recipient: { peer: string; prekey: PrekeyBundle },
  plaintext: Uint8Array,
): AnonBox {
  const ephSecret = randomBytes(32);
  const epk = x25519.getPublicKey(ephSecret);
  const ssX = x25519.getSharedSecret(ephSecret, fromB64u(recipient.prekey.x25519));
  const { cipherText: kem, sharedSecret: ssKem } = ml_kem768.encapsulate(
    fromB64u(recipient.prekey.mlkem),
  );
  const { key, nonce } = boxKey(
    ssX,
    ssKem,
    epk,
    kem,
    recipient.peer,
    recipient.prekey.id,
    SIG_DOMAIN.anon,
  );
  const head = {
    v: 3 as const,
    to: recipient.peer,
    pk: recipient.prekey.id,
    epk: toB64u(epk),
    kem: toB64u(kem),
  };
  const inner = { from: sender.publicKey, fromDevice: senderDevice, p: toB64u(plaintext) };
  const sig = sign(sender, SIG_DOMAIN.anon, { ...head, rx: recipient.prekey.x25519, ...inner });
  const ct = aesGcmEncrypt(key, nonce, padBlocks(utf8.encode(JSON.stringify({ ...inner, sig }))));
  return { ...head, ct: toB64u(ct) };
}

export function openAnonymous(
  me: { peer: string },
  prekeys: (id: number) => PrekeySecret | undefined,
  box: AnonBox,
  fromUserId: (key: string) => string,
): OpenedBox | null {
  if (box.to !== me.peer) return null;
  const pk = prekeys(box.pk);
  if (!pk) return null;
  try {
    const secrets = prekeySecrets(pk);
    const epk = fromB64u(box.epk);
    const kem = fromB64u(box.kem);
    const ssX = x25519.getSharedSecret(secrets.x25519, epk);
    const ssKem = ml_kem768.decapsulate(kem, secrets.mlkem);
    const { key, nonce } = boxKey(ssX, ssKem, epk, kem, box.to, box.pk, SIG_DOMAIN.anon);
    const padded = aesGcmDecrypt(key, nonce, fromB64u(box.ct));
    const json = padded && unpad(padded);
    if (!json) return null;
    const inner = JSON.parse(utf8.decode(json)) as Record<string, unknown>;
    const { from, fromDevice, p, sig } = inner;
    if (
      typeof from !== 'string' ||
      typeof fromDevice !== 'string' ||
      typeof p !== 'string' ||
      typeof sig !== 'string' ||
      !/^[a-z2-7]{8,32}$/.test(fromDevice)
    )
      return null;
    const head = { v: box.v, to: box.to, pk: box.pk, epk: box.epk, kem: box.kem };
    const signed = { ...head, rx: pk.bundle.x25519, from, fromDevice, p };
    if (!verifyPayload(from, SIG_DOMAIN.anon, signed, sig)) return null;
    const fromUser = fromUserId(from);
    return {
      from: peerIds.make(fromUser, fromDevice),
      fromUser,
      fromKey: from,
      plaintext: fromB64u(p),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data for the account's own devices only (e.g. the friends list): AES-256-GCM
// under a key derived from the account seed, padded to hide its exact size.
// ---------------------------------------------------------------------------

function selfKey(identity: Identity, purpose: string) {
  return hkdfSha256(identity.seed, utf8.encode(identity.userId), `croc/v1/self/${purpose}`, 32);
}

/** Returns base64url(nonce ‖ ciphertext). `aad` binds it to where it is stored. */
export function sealForSelf(
  identity: Identity,
  purpose: string,
  plaintext: Uint8Array,
  aad: string,
): string {
  const nonce = randomBytes(12);
  const ct = aesGcmEncrypt(selfKey(identity, purpose), nonce, pad(plaintext), utf8.encode(aad));
  return toB64u(concatBytes(nonce, ct));
}

export function openForSelf(
  identity: Identity,
  purpose: string,
  sealed: string,
  aad: string,
): Uint8Array | null {
  try {
    const bytes = fromB64u(sealed);
    if (bytes.length < 12 + 16) return null;
    const padded = aesGcmDecrypt(
      selfKey(identity, purpose),
      bytes.subarray(0, 12),
      bytes.subarray(12),
      utf8.encode(aad),
    );
    return padded && unpad(padded);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Device linking: the account seed sealed to a new device's temporary keys,
// hybrid like sealToDevice (X25519 ‖ ML-KEM-768 through HKDF), signed by the
// account key. The seed is the account, so a recording of this one box must
// not open with a future quantum computer either.
// ---------------------------------------------------------------------------

/** The new device's temporary ML-KEM-768 key for receiving the account. */
export interface LinkKem {
  /** Encapsulation key, base64url (1184 bytes). */
  publicKey: string;
  secretKey: Uint8Array;
}

export function createLinkKem(): LinkKem {
  const kem = ml_kem768.keygen(randomBytes(64));
  return { publicKey: toB64u(kem.publicKey), secretKey: kem.secretKey };
}

const LINK_DOMAIN = 'croc/v2/link';

function linkKey(
  ssX: Uint8Array,
  ssKem: Uint8Array,
  epk: Uint8Array,
  rx: Uint8Array,
  kem: Uint8Array,
) {
  const okm = hkdfSha256(concatBytes(ssX, ssKem), concatBytes(epk, rx, kem), LINK_DOMAIN, 44);
  return { key: okm.slice(0, 32), nonce: okm.slice(32, 44) };
}

function linkSignedPart(box: Omit<LinkBox, 'sig'>, to: string, toKem: string) {
  return { epk: box.epk, kem: box.kem, ct: box.ct, from: box.from, to, toKem };
}

export function sealLink(
  sender: Identity,
  recipient: { encKey: string; kemKey: string },
  plaintext: Uint8Array,
): LinkBox {
  const rx = decodeEncKey(recipient.encKey);
  const eph = randomBytes(32);
  const epk = x25519.getPublicKey(eph);
  const { cipherText: kem, sharedSecret: ssKem } = ml_kem768.encapsulate(
    fromB64u(recipient.kemKey),
  );
  const { key, nonce } = linkKey(x25519.getSharedSecret(eph, rx), ssKem, epk, rx, kem);
  const unsigned = {
    epk: toB64u(epk),
    kem: toB64u(kem),
    ct: toB64u(aesGcmEncrypt(key, nonce, plaintext)),
    from: sender.publicKey,
  };
  return {
    ...unsigned,
    sig: sign(sender, LINK_DOMAIN, linkSignedPart(unsigned, recipient.encKey, recipient.kemKey)),
  };
}

export function openLink(
  recipient: Identity,
  kem: LinkKem,
  box: LinkBox,
  expectedUserId: string,
): Uint8Array | null {
  if (!keyMatchesUserId(box.from, expectedUserId)) return null;
  const signed = linkSignedPart(box, recipient.encPublicKey, kem.publicKey);
  if (!verifyPayload(box.from, LINK_DOMAIN, signed, box.sig)) return null;
  try {
    const epk = fromB64u(box.epk);
    const kemCt = fromB64u(box.kem);
    const ssX = x25519.getSharedSecret(recipient.encSecret, epk);
    const ssKem = ml_kem768.decapsulate(kemCt, kem.secretKey);
    const rx = decodeEncKey(recipient.encPublicKey);
    const { key, nonce } = linkKey(ssX, ssKem, epk, rx, kemCt);
    return aesGcmDecrypt(key, nonce, fromB64u(box.ct));
  } catch {
    return null;
  }
}
