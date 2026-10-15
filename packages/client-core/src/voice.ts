import { Emitter } from './emitter';
import type { FrameKeys, GroupKeyring } from './keyring';
import type { FrameCryptoHooks } from './relay-link';

export interface VoiceSettings {
  inputDeviceId?: string;
  outputDeviceId?: string;
  /** Voice activity detection or push-to-talk. */
  mode: 'vad' | 'ptt';
  /** Gate threshold for VAD in dBFS (-100 .. 0). */
  vadThresholdDb: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** Master output volume 0..2. */
  outputVolume: number;
  /** Per-user volume 0..2. */
  userVolumes: Record<string, number>;
}

export const defaultVoiceSettings: VoiceSettings = {
  mode: 'vad',
  vadThresholdDb: -55,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  outputVolume: 1,
  userVolumes: {},
};

/** How a shared screen should look: sharp text and slides, or smooth motion. */
export type ScreenQuality = 'text' | 'motion';

export interface ScreenRequest {
  /** The screen or window to share, from the platform's picker. */
  sourceId?: string;
  quality: ScreenQuality;
  /** Share the computer's sound too (where the system allows it). */
  audio: boolean;
}

export interface VoicePlatform {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices?(): Promise<MediaDeviceInfo[]>;
  /** Creates the frame encryption worker (see frame-worker.ts). */
  createFrameWorker(): Worker;
  /** Captures a screen or window (absent: this device can't share its screen). */
  getDisplayMedia?(request: ScreenRequest): Promise<MediaStream>;
}

/** What this device shows in its call besides its voice. */
export interface OutgoingVideo {
  camera: MediaStreamTrack | null;
  screen: {
    video: MediaStreamTrack;
    audio: MediaStreamTrack | null;
    quality: ScreenQuality;
  } | null;
}

export type VoiceEvents = {
  level: { db: number; gateOpen: boolean };
  error: { message: string };
  /** The microphone track changed (device switch); sessions must swap it in. */
  track: MediaStreamTrack | null;
  /** The camera or the shared screen started or stopped. */
  video: OutgoingVideo;
};

/** What a camera captures. */
export const CAMERA_CONSTRAINTS = { width: 1280, height: 720, frameRate: 30 } as const;
/** What a shared screen captures, by quality. */
export const SCREEN_CONSTRAINTS = {
  text: { width: 1920, height: 1080, frameRate: 5 },
  motion: { width: 1280, height: 720, frameRate: 30 },
} as const;

type WorkerMessage =
  | { type: 'keys'; scope: string; keys: FrameKeys }
  | {
      type: 'stream';
      scope: string;
      role: FrameRole;
      readable: ReadableStream;
      writable: WritableStream;
    }
  | { type: 'drop'; scope: string };

type FrameRole = 'encrypt' | 'decrypt' | 'encrypt-video' | 'decrypt-video';

declare const RTCRtpScriptTransform:
  | {
      new (worker: Worker, options?: unknown, transfer?: unknown[]): unknown;
    }
  | undefined;

/**
 * Microphone capture with Chromium's echo cancellation / noise suppression,
 * a VAD or push-to-talk gate, playback of the relay's speaker slots, and the
 * end-to-end frame encryption worker (Encoded Transforms / SFrame-style).
 * Voice refuses to run where frame encryption is unavailable.
 */
export class VoiceEngine extends Emitter<VoiceEvents> {
  settings: VoiceSettings;
  private stream?: MediaStream;
  private track?: MediaStreamTrack;
  private meterTrack?: MediaStreamTrack;
  private ctx?: AudioContext;
  private meterTimer?: ReturnType<typeof setInterval>;
  private gateOpen = false;
  private gateUntil = 0;
  private muted = false;
  private deafened = false;
  private pttDown = false;
  private worker?: Worker;
  private scopes = new Map<string, () => void>();
  private players = new Map<
    string,
    { el: HTMLAudioElement; owner: () => string | null; timer: ReturnType<typeof setInterval> }
  >();
  private camera: MediaStreamTrack | null = null;
  private screen: OutgoingVideo['screen'] = null;

  constructor(
    private readonly platform: VoicePlatform,
    settings: Partial<VoiceSettings> = {},
  ) {
    super();
    this.settings = { ...defaultVoiceSettings, ...settings };
  }

  static supportsE2EE(): boolean {
    const hasScript = typeof RTCRtpScriptTransform !== 'undefined';
    const hasLegacy =
      typeof RTCRtpSender !== 'undefined' &&
      'createEncodedStreams' in (RTCRtpSender.prototype as object);
    return hasScript || hasLegacy;
  }

  get active() {
    return !!this.track;
  }

  micTrack(): MediaStreamTrack | null {
    return this.track ?? null;
  }

  async start() {
    if (!VoiceEngine.supportsE2EE()) {
      throw new Error('This device cannot encrypt voice end-to-end, so voice is disabled.');
    }
    if (this.track) return;
    await this.acquire();
  }

  private async acquire() {
    const s = this.settings;
    let stream: MediaStream;
    try {
      stream = await this.platform.getUserMedia({
        audio: {
          ...(s.inputDeviceId ? { deviceId: { exact: s.inputDeviceId } } : {}),
          echoCancellation: s.echoCancellation,
          noiseSuppression: s.noiseSuppression,
          autoGainControl: s.autoGainControl,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      const message =
        name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow it in your system settings to talk.'
          : name === 'NotFoundError'
            ? 'No microphone found.'
            : `Could not open the microphone: ${(err as Error).message}`;
      this.emit('error', { message });
      throw new Error(message);
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.track = stream.getAudioTracks()[0];
    this.applyGate();
    // Meter a clone: the gated track itself goes silent while disabled.
    this.meterTrack?.stop();
    this.meterTrack = this.track?.clone();
    // Clones inherit `enabled`; the meter must always hear the microphone.
    if (this.meterTrack) this.meterTrack.enabled = true;
    this.startMeter(new MediaStream(this.meterTrack ? [this.meterTrack] : []));
    this.emit('track', this.track ?? null);
  }

  private startMeter(stream: MediaStream) {
    clearInterval(this.meterTimer);
    void this.ctx?.close().catch(() => {});
    if (typeof AudioContext === 'undefined') {
      this.gateOpen = true;
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    if (ctx.state !== 'running') {
      void ctx.resume().catch(() => {});
      // Without a running context we cannot measure; fail open rather than mute.
      setTimeout(() => {
        if (this.ctx === ctx && ctx.state !== 'running' && this.settings.mode === 'vad') {
          this.gateOpen = true;
          this.applyGate();
        }
      }, 500);
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    // Chromium only pulls audio through graphs that reach the destination.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    analyser.connect(sink).connect(ctx.destination);
    const buf = new Float32Array(analyser.fftSize);
    this.meterTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const db = 10 * Math.log10(sum / buf.length + 1e-12);
      const now = Date.now();
      if (db > this.settings.vadThresholdDb) this.gateUntil = now + 350;
      const open = this.settings.mode === 'ptt' ? this.pttDown : now < this.gateUntil;
      if (open !== this.gateOpen) {
        this.gateOpen = open;
        this.applyGate();
      }
      this.emit('level', { db, gateOpen: open && !this.muted });
    }, 50);
  }

  private applyGate() {
    // A disabled track sends silence (Opus DTX), so the relay sees no speech.
    if (this.track) this.track.enabled = !this.muted && this.gateOpen;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyGate();
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened;
    for (const p of this.players.values()) p.el.muted = deafened;
  }

  /** Push-to-talk key state. */
  setPushToTalk(down: boolean) {
    this.pttDown = down;
    if (this.settings.mode === 'ptt') {
      this.gateOpen = down;
      this.applyGate();
    }
  }

  async updateSettings(patch: Partial<VoiceSettings>) {
    const prev = this.settings;
    this.settings = { ...prev, ...patch };
    const needsNewMic =
      this.track &&
      ((patch.inputDeviceId !== undefined && patch.inputDeviceId !== prev.inputDeviceId) ||
        ['echoCancellation', 'noiseSuppression', 'autoGainControl'].some(
          (k) => k in patch && patch[k as keyof VoiceSettings] !== prev[k as keyof VoiceSettings],
        ));
    if (needsNewMic) await this.acquire();
    if (patch.outputDeviceId !== undefined)
      for (const p of this.players.values()) void this.setSink(p.el);
    if (patch.mode) {
      this.gateOpen = patch.mode === 'vad';
      this.applyGate();
    }
  }

  async devices(): Promise<{
    inputs: MediaDeviceInfo[];
    outputs: MediaDeviceInfo[];
    cameras: MediaDeviceInfo[];
  }> {
    const all = (await this.platform.enumerateDevices?.()) ?? [];
    return {
      inputs: all.filter((d) => d.kind === 'audioinput'),
      outputs: all.filter((d) => d.kind === 'audiooutput'),
      cameras: all.filter((d) => d.kind === 'videoinput'),
    };
  }

  // -------------------------------------------------------------------------
  // Camera and screen
  // -------------------------------------------------------------------------

  get canShareScreen() {
    return !!this.platform.getDisplayMedia;
  }

  outgoing(): OutgoingVideo {
    return { camera: this.camera, screen: this.screen };
  }

  private emitVideo() {
    this.emit('video', this.outgoing());
  }

  /**
   * Turns the camera on. Resolves false if it was turned off (or on again)
   * while the camera was still opening: that late camera is closed, not shown.
   */
  async startCamera(deviceId?: string): Promise<boolean> {
    if (!VoiceEngine.supportsE2EE())
      throw new Error('This device cannot encrypt video end-to-end, so video is disabled.');
    const attempt = ++this.cameraAttempt;
    let stream: MediaStream;
    try {
      stream = await this.platform.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: CAMERA_CONSTRAINTS.width },
          height: { ideal: CAMERA_CONSTRAINTS.height },
          frameRate: { ideal: CAMERA_CONSTRAINTS.frameRate },
        },
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      throw new Error(
        name === 'NotAllowedError'
          ? 'Camera access was denied. Allow it in your system settings to show your video.'
          : name === 'NotFoundError'
            ? 'No camera found.'
            : name === 'NotReadableError'
              ? 'The camera is in use by another app.'
              : `Could not open the camera: ${(err as Error).message}`,
      );
    }
    if (attempt !== this.cameraAttempt) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.camera?.stop();
    const track = stream.getVideoTracks()[0] ?? null;
    if (track) {
      track.contentHint = 'motion';
      track.addEventListener('ended', () => {
        if (this.camera === track) this.stopCamera();
      });
    }
    this.camera = track;
    this.emitVideo();
    return true;
  }

  /** Counts camera requests, so turning it off also cancels one still opening. */
  private cameraAttempt = 0;
  private screenAttempt = 0;

  stopCamera() {
    this.cameraAttempt++;
    if (!this.camera) return;
    this.camera.stop();
    this.camera = null;
    this.emitVideo();
  }

  /** Shares a screen; resolves false if sharing was stopped while it was being picked. */
  async startScreen(request: ScreenRequest): Promise<boolean> {
    if (!this.platform.getDisplayMedia) throw new Error('This device cannot share its screen.');
    if (!VoiceEngine.supportsE2EE())
      throw new Error('This device cannot encrypt video end-to-end, so video is disabled.');
    const attempt = ++this.screenAttempt;
    const stream = await this.platform.getDisplayMedia(request);
    const video = stream.getVideoTracks()[0];
    if (!video) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Nothing to share was chosen.');
    }
    const c = SCREEN_CONSTRAINTS[request.quality];
    video.contentHint = request.quality === 'text' ? 'text' : 'motion';
    await video
      .applyConstraints({
        width: { max: c.width },
        height: { max: c.height },
        frameRate: { max: c.frameRate },
      })
      .catch(() => {});
    if (attempt !== this.screenAttempt) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    const audio = request.audio ? (stream.getAudioTracks()[0] ?? null) : null;
    for (const t of stream.getAudioTracks()) if (t !== audio) t.stop();
    this.releaseScreen();
    this.screen = { video, audio, quality: request.quality };
    // Stopped from the system's own controls ("Stop sharing").
    video.addEventListener('ended', () => {
      if (this.screen?.video === video) this.stopScreen();
    });
    this.emitVideo();
    return true;
  }

  stopScreen() {
    this.screenAttempt++;
    if (this.releaseScreen()) this.emitVideo();
  }

  private releaseScreen() {
    if (!this.screen) return false;
    this.screen.video.stop();
    this.screen.audio?.stop();
    this.screen = null;
    return true;
  }

  frameCrypto(keyring: GroupKeyring): FrameCryptoHooks {
    const worker = (this.worker ??= this.platform.createFrameWorker());
    const scope = Math.random().toString(36).slice(2);
    const post = (msg: WorkerMessage, transfer: Transferable[] = []) =>
      worker.postMessage(msg, transfer);
    // A new connection may get a new frame sender (the previous one dropped,
    // or a new worker); it must not encrypt under a key an earlier sender
    // used, or their frame counters could reuse a nonce. Moving our audio
    // chain on first makes the key fresh; receivers follow a few steps ahead.
    keyring.advanceAudio();
    post({ type: 'keys', scope, keys: keyring.frameKeys() });
    const off = keyring.on('changed', (keys) => post({ type: 'keys', scope, keys }));
    this.scopes.set(scope, () => {
      off();
      post({ type: 'drop', scope });
    });
    const useScript = typeof RTCRtpScriptTransform !== 'undefined';
    const install = (target: RTCRtpSender | RTCRtpReceiver, role: FrameRole) => {
      if (useScript) {
        (target as unknown as { transform: unknown }).transform = new RTCRtpScriptTransform!(
          worker,
          { role, scope },
        );
      } else {
        const { readable, writable } = (
          target as unknown as {
            createEncodedStreams(): { readable: ReadableStream; writable: WritableStream };
          }
        ).createEncodedStreams();
        post({ type: 'stream', scope, role, readable, writable }, [
          readable as unknown as Transferable,
          writable as unknown as Transferable,
        ]);
      }
    };
    return {
      rtcConfig: useScript ? undefined : { encodedInsertableStreams: true },
      protectSender: (sender) => install(sender, 'encrypt'),
      protectReceiver: (receiver) => install(receiver, 'decrypt'),
      protectVideoSender: (sender) => install(sender, 'encrypt-video'),
      protectVideoReceiver: (receiver) => install(receiver, 'decrypt-video'),
    };
  }

  /** Plays a speaker slot (a number) or a shared screen's sound (`screen<n>`). */
  playSlot(
    sessionId: string,
    slot: number | string,
    track: MediaStreamTrack,
    owner: () => string | null,
  ) {
    if (typeof Audio === 'undefined') return;
    const key = `${sessionId}:${slot}`;
    let player = this.players.get(key);
    if (!player) {
      const el = new Audio();
      el.autoplay = true;
      const p = {
        el,
        owner,
        timer: setInterval(() => {
          const who = p.owner();
          const v = (who ? (this.settings.userVolumes[who] ?? 1) : 1) * this.settings.outputVolume;
          el.volume = Math.max(0, Math.min(1, v));
        }, 250),
      };
      player = p;
      this.players.set(key, p);
    }
    player.owner = owner;
    player.el.srcObject = new MediaStream([track]);
    player.el.muted = this.deafened;
    void this.setSink(player.el);
    void player.el.play().catch(() => {});
  }

  private async setSink(el: HTMLAudioElement) {
    const id = this.settings.outputDeviceId;
    const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (id && withSink.setSinkId) await withSink.setSinkId(id).catch(() => {});
  }

  stopSession(sessionId: string) {
    for (const [key, p] of this.players) {
      if (key.startsWith(`${sessionId}:`)) {
        clearInterval(p.timer);
        p.el.srcObject = null;
        this.players.delete(key);
      }
    }
    for (const drop of this.scopes.values()) drop();
    this.scopes.clear();
  }

  stop() {
    this.stopCamera();
    this.stopScreen();
    clearInterval(this.meterTimer);
    void this.ctx?.close().catch(() => {});
    this.ctx = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.meterTrack?.stop();
    this.meterTrack = undefined;
    this.stream = undefined;
    this.track = undefined;
    this.emit('track', null);
  }
}
