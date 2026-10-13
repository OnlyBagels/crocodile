/// <reference lib="webworker" />
/**
 * Voice and video frame encryption worker. Runs inside Chromium's encoded-
 * transform pipeline: every Opus frame leaving the microphone (or a shared
 * screen's sound) and every VP8 frame leaving the camera or screen is
 * encrypted with our ratcheting sender key before packetisation, and every
 * frame arriving on a slot is decrypted with the sending member's key. The host relay
 * only ever sees ciphertext. Frames we cannot encrypt or authenticate are
 * dropped, never passed through in the clear.
 */
import { peekFrameKid } from '@crocodile/crypto';
import { FrameScopes, vp8ClearBytes } from './frame-scopes';
import type { FrameKeys } from './keyring';

const scopes = new FrameScopes();

interface EncodedFrame {
  data: ArrayBuffer;
  /** Video frames: 'key' or 'delta'. */
  type?: string;
}

function pipe(
  readable: ReadableStream<EncodedFrame>,
  writable: WritableStream<EncodedFrame>,
  role: string,
  scopeId: string,
) {
  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    transform(frame, controller) {
      const s = scopes.get(scopeId);
      const data = new Uint8Array(frame.data);
      if (role === 'encrypt') {
        if (!s?.sender) return;
        frame.data = s.sender.encrypt(data).slice().buffer;
        controller.enqueue(frame);
        return;
      }
      if (role === 'encrypt-video') {
        if (!s?.video) return;
        const clear = vp8ClearBytes(frame.type === 'key');
        frame.data = s.video.encrypt(data, clear).slice().buffer;
        controller.enqueue(frame);
        return;
      }
      const kid = peekFrameKid(data);
      const receiver =
        kid === null
          ? undefined
          : role === 'decrypt-video'
            ? s?.videoReceivers.get(kid)
            : s?.receivers.get(kid);
      const plain = receiver?.decrypt(data);
      if (!plain) return;
      frame.data = plain.slice().buffer;
      controller.enqueue(frame);
    },
  });
  readable
    .pipeThrough(transform)
    .pipeTo(writable)
    .catch(() => {});
}

const ctx = self as unknown as DedicatedWorkerGlobalScope & {
  onrtctransform?: (ev: {
    transformer: {
      readable: ReadableStream;
      writable: WritableStream;
      options: { role: string; scope: string };
    };
  }) => void;
};

ctx.onmessage = (ev: MessageEvent) => {
  const m = ev.data as
    | { type: 'keys'; scope: string; keys: FrameKeys }
    | {
        type: 'stream';
        scope: string;
        role: string;
        readable: ReadableStream;
        writable: WritableStream;
      }
    | { type: 'drop'; scope: string };
  if (m.type === 'keys') scopes.update(m.scope, m.keys);
  else if (m.type === 'stream') pipe(m.readable, m.writable, m.role, m.scope);
  else if (m.type === 'drop') scopes.drop(m.scope);
};

ctx.onrtctransform = (ev) => {
  const t = ev.transformer;
  pipe(t.readable, t.writable, t.options.role, t.options.scope);
};
