import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { concatBytes, fromB64u, toB64u, utf8 } from '@crocodile/protocol';
import { aesGcmDecrypt, aesGcmEncrypt, hkdfSha256, randomBytes, x25519 } from './primitives';
import { pad, unpad } from './padding';

/**
 * Encrypted, length-padded frames over an existing WebSocket. Used between
 * clients and coordination servers and between servers in the mesh, so
 * metadata stays confidential even over plain ws:// to home-hosted servers.
 *
 * Key agreement is hybrid (X25519 + ML-KEM-768) with fresh keys per
 * connection on both sides (forward secret); the handshake messages are
 * signed with the parties' identity keys by the caller.
 */
export interface ChannelKeys {
  x25519Secret: Uint8Array;
  mlkemSecret: Uint8Array;
  offer: { x25519: string; mlkem: string };
}

export function createChannelKeys(): ChannelKeys {
  const xs = randomBytes(32);
  const kem = ml_kem768.keygen(randomBytes(64));
  return {
    x25519Secret: xs,
    mlkemSecret: kem.secretKey,
    offer: { x25519: toB64u(x25519.getPublicKey(xs)), mlkem: toB64u(kem.publicKey) },
  };
}

/** Responder side: answer an offer with an ephemeral X25519 key and a KEM ciphertext. */
export function answerChannel(offer: { x25519: string; mlkem: string }) {
  const eph = randomBytes(32);
  const epk = x25519.getPublicKey(eph);
  const ssX = x25519.getSharedSecret(eph, fromB64u(offer.x25519));
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(fromB64u(offer.mlkem));
  return {
    answer: { epk: toB64u(epk), kem: toB64u(cipherText) },
    secret: concatBytes(ssX, sharedSecret),
  };
}

/** Offer side: recover the shared secret from an answer. */
export function acceptChannel(keys: ChannelKeys, answer: { epk: string; kem: string }): Uint8Array {
  const ssX = x25519.getSharedSecret(keys.x25519Secret, fromB64u(answer.epk));
  const ssKem = ml_kem768.decapsulate(fromB64u(answer.kem), keys.mlkemSecret);
  return concatBytes(ssX, ssKem);
}

/**
 * What the channel that carries a client's sign-in is bound to. It is apart from the channel for
 * the rest of the connection, which also names the client (known only once the sign-in is open).
 */
export const signInChannelContext = (challenge: string, serverId: string) =>
  `${challenge}|${serverId}|auth`;

export class SecureChannel {
  private sendN = 0;
  private recvN = -1;
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;

  /**
   * @param secret shared secret from the handshake
   * @param context transcript binding (e.g. challenge and both ids)
   * @param initiator which direction's key we send with
   */
  constructor(secret: Uint8Array, context: string, initiator: boolean) {
    const okm = hkdfSha256(secret, utf8.encode(context), 'croc/v1/channel', 64);
    const a = okm.slice(0, 32);
    const b = okm.slice(32, 64);
    this.sendKey = initiator ? a : b;
    this.recvKey = initiator ? b : a;
  }

  private static nonce(n: number) {
    const nonce = new Uint8Array(12);
    const v = new DataView(nonce.buffer);
    v.setUint32(4, Math.floor(n / 2 ** 32));
    v.setUint32(8, n >>> 0);
    return nonce;
  }

  seal(value: unknown): { t: 'x'; n: number; c: string } {
    const n = this.sendN++;
    const ct = aesGcmEncrypt(
      this.sendKey,
      SecureChannel.nonce(n),
      pad(utf8.encode(JSON.stringify(value))),
    );
    return { t: 'x', n, c: toB64u(ct) };
  }

  /** Returns the decoded value, or undefined for forged/replayed frames. */
  open(frame: { n: number; c: string }): unknown {
    if (!Number.isSafeInteger(frame.n) || frame.n <= this.recvN) return undefined;
    let bytes: Uint8Array | null;
    try {
      bytes = aesGcmDecrypt(this.recvKey, SecureChannel.nonce(frame.n), fromB64u(frame.c));
    } catch {
      return undefined;
    }
    const plain = bytes && unpad(bytes);
    if (!plain) return undefined;
    this.recvN = frame.n;
    try {
      return JSON.parse(utf8.decode(plain));
    } catch {
      return undefined;
    }
  }
}
