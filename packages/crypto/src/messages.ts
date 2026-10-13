import {
  SIG_DOMAIN,
  peerIds,
  type ChatMessage,
  type FileManifest,
  type SignalData,
} from '@crocodile/protocol';
import { verifyPayload } from './primitives';
import { keyMatchesUserId, sign, timeId, type Identity } from './identity';

export function createChatMessage(
  identity: Identity,
  fields: {
    ch: string;
    body: string;
    replyTo?: string;
    edits?: string;
    deleted?: boolean;
    file?: FileManifest;
  },
  now = Date.now(),
): ChatMessage {
  const unsigned = {
    id: timeId(now),
    ch: fields.ch,
    author: identity.userId,
    key: identity.publicKey,
    ts: now,
    body: fields.body,
    ...(fields.replyTo ? { replyTo: fields.replyTo } : {}),
    ...(fields.edits ? { edits: fields.edits } : {}),
    ...(fields.deleted ? { deleted: true } : {}),
    ...(fields.file ? { file: fields.file } : {}),
  };
  return { ...unsigned, sig: sign(identity, SIG_DOMAIN.message, unsigned) };
}

export function verifyChatMessage(message: ChatMessage): boolean {
  if (!keyMatchesUserId(message.key, message.author)) return false;
  const { sig, ...unsigned } = message;
  return verifyPayload(message.key, SIG_DOMAIN.message, unsigned, sig);
}

type SdpSignal = Extract<SignalData, { type: 'offer' | 'answer' }>;

/**
 * Offers and answers are signed over the session, epoch, both user ids and
 * the SDP (which carries the DTLS fingerprint), binding the WebRTC transport
 * to the identities.
 */
export function signSdp(
  identity: Identity,
  type: 'offer' | 'answer',
  ctx: { sessionId: string; epoch: number; from: string; to: string },
  sdp: string,
): SdpSignal {
  const payload = {
    type,
    sessionId: ctx.sessionId,
    epoch: ctx.epoch,
    from: ctx.from,
    to: ctx.to,
    sdp,
  };
  return {
    type,
    epoch: ctx.epoch,
    sdp,
    key: identity.publicKey,
    sig: sign(identity, SIG_DOMAIN.signal, payload),
  };
}

/** `from` and `to` are peer ids; the key must belong to the sending user. */
export function verifySdp(
  signal: SdpSignal,
  ctx: { sessionId: string; from: string; to: string },
): boolean {
  if (!keyMatchesUserId(signal.key, peerIds.user(ctx.from))) return false;
  const payload = {
    type: signal.type,
    sessionId: ctx.sessionId,
    epoch: signal.epoch,
    from: ctx.from,
    to: ctx.to,
    sdp: signal.sdp,
  };
  return verifyPayload(signal.key, SIG_DOMAIN.signal, payload, signal.sig);
}
