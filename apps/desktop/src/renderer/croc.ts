import { useRef, useSyncExternalStore } from 'react';
import {
  CrocodileClient,
  VoiceEngine,
  defaultVoiceSettings,
  type ClientState,
  type VoiceSettings,
} from '@crocodile/client-core';
import { StateStore } from '@crocodile/client-core';
import { createPlatform, desktop, kv } from './platform';
import FrameWorker from '@crocodile/client-core/frame-worker?worker';
import type { UpdateStatus } from '../main/ipc-types';

export type View =
  | { kind: 'friends' }
  | { kind: 'dm'; userId: string }
  | { kind: 'space'; spaceId: string; channelId: string | null };

export type ModalState =
  | { kind: 'add-space' }
  | { kind: 'invite'; spaceId: string }
  | { kind: 'create-channel'; spaceId: string }
  | { kind: 'space-settings'; spaceId: string }
  | { kind: 'settings'; tab?: string }
  | { kind: 'profile'; userId: string }
  | { kind: 'new-dm' }
  | { kind: 'link-device' }
  /** How a session's connection stands, step by step. */
  | { kind: 'connection'; sessionId: string }
  | {
      kind: 'confirm';
      title: string;
      body: string;
      action: string;
      danger?: boolean;
      /** The user must type this text to enable the action. */
      confirmText?: string;
      onConfirm: () => void | Promise<void>;
    };

export interface Appearance {
  theme: 'system' | 'dark' | 'light';
  accent: string;
  /** Chat layout: speech bubbles or a compact list. */
  density: 'bubbles' | 'compact';
}

export const ACCENTS = ['#34c77b', '#2cc5b8', '#5b9cf5', '#a27bf0', '#f07bb3', '#f5a33d'];

export interface UiState {
  view: View;
  modal: ModalState | null;
  palette: boolean;
  appearance: Appearance;
  /** System-wide push-to-talk hook state. */
  pttStatus: 'active' | 'unavailable' | 'needs-permission' | 'off';
  showMembers: boolean;
  voiceSettings: VoiceSettings;
  pttKey: string;
  micLevel: number;
  appVersion: string;
  /** In-app updates (the desktop main process does the work). */
  update: UpdateStatus;
}

export const ui = new StateStore<UiState>({
  view: { kind: 'friends' },
  modal: null,
  palette: false,
  appearance: { theme: 'system', accent: ACCENTS[0]!, density: 'bubbles' },
  pttStatus: 'off',
  showMembers: true,
  voiceSettings: defaultVoiceSettings,
  pttKey: 'Backquote',
  micLevel: -100,
  appVersion: '',
  update: { state: 'unsupported' },
});

let client: CrocodileClient;
/** Server directories this app instance uses (shown in diagnostics). */
let directoriesInUse: string[] = [];

export async function bootClient(): Promise<CrocodileClient> {
  const info = (await desktop?.app.info()) ?? {
    version: '0.1.0-web',
    platform: 'web',
    directories: [],
    cpuCores: navigator.hardwareConcurrency,
  };
  // The desktop main process already resolves overrides and the built-in
  // list; an empty list from it means "no directory" (e.g. a test override).
  const directories = desktop
    ? info.directories
    : ((process.env.CROC_DIRECTORIES as string | undefined)?.split(',').filter(Boolean) ?? []);
  directoriesInUse = directories;
  const platform = createPlatform({
    version: info.version,
    cpuCores: info.cpuCores,
    stun: () => client?.stunUrls ?? [],
  });

  // A locally running coordination server (if the user enabled one) is preferred.
  const local = await desktop?.coordinator.get();
  const preferred = local?.settings.enabled ? [`http://127.0.0.1:${local.settings.port}`] : [];

  client = new CrocodileClient(platform, {
    directories,
    preferredServers: preferred,
    log: (m, e) => {
      console.debug(`[croc] ${m}`, e ?? '');
      remember(m, e);
    },
  });

  const saved = (await kv.get<Partial<VoiceSettings>>('voice-settings')) ?? {};
  const pttKey = (await kv.get<string>('ptt-key')) ?? 'Backquote';
  const appearance = {
    ...ui.get().appearance,
    ...((await kv.get<Partial<Appearance>>('appearance')) ?? {}),
  };
  ui.set({ appearance });
  applyAppearance(appearance);
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => applyAppearance(ui.get().appearance));
  const voiceSettings = { ...defaultVoiceSettings, ...saved };
  const engine = new VoiceEngine(
    {
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
      createFrameWorker: () => new FrameWorker(),
    },
    voiceSettings,
  );
  engine.on('level', ({ db }) => ui.set({ micLevel: db }));
  engine.on('error', ({ message }) => client.reportError(message));
  engine.on('track', (track) => {
    const id = client.state.voiceSession;
    if (id) void client.sessionFor(id)?.setMicTrack(track);
  });
  client.voiceEngine = engine;
  // A coordination server hosted on this computer is used as soon as it runs.
  desktop?.coordinator.onStatus((st) => {
    client.setExtraServers(st.state === 'running' ? [st.url] : []);
  });
  ui.set({ voiceSettings, pttKey, appVersion: info.version });
  if (desktop) {
    desktop.updates.onStatus((update) => ui.set({ update }));
    void desktop.updates.status().then((update) => ui.set({ update }));
  }
  desktop?.ptt.onState((down) => engine.setPushToTalk(down));
  void syncGlobalPtt();
  await client.init();
  return client;
}

export function getClient() {
  return client;
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/** Downloads the release on offer, or opens its download page when it can't be installed here. */
export function downloadUpdate() {
  void desktop?.updates.download();
}

/** Restarts into the downloaded update, after asking if that would end a call. */
export function installUpdate() {
  const restart = () => void desktop?.updates.install();
  const s = ui.get().update;
  if (s.state !== 'ready') return;
  if (!client?.state.voiceSession) return restart();
  openModal({
    kind: 'confirm',
    title: s.after === 'open' ? 'Quit and install?' : 'Restart to update?',
    body:
      s.after === 'open'
        ? `Crocodile quits so you can install version ${s.version}. This ends your call.`
        : `Crocodile restarts into version ${s.version}. This ends your call.`,
    action: s.after === 'open' ? 'Quit and install' : 'Restart',
    onConfirm: restart,
  });
}

// ---------------------------------------------------------------------------
// Diagnostics for bug reports
// ---------------------------------------------------------------------------

const recentLog: string[] = [];

/** The client's recent log lines, oldest first (debug panel). */
export function recentLogLines(): string[] {
  return [...recentLog];
}
function remember(msg: string, extra?: Record<string, unknown>) {
  recentLog.push(`${new Date().toISOString()} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
  if (recentLog.length > 300) recentLog.shift();
}

/**
 * What a tester pastes into a bug report: versions, connection state,
 * settings and recent client log lines. Never message content, keys or the
 * recovery key.
 */
export async function diagnostics(): Promise<string> {
  const s = client.state;
  const u = ui.get();
  const info = await desktop?.app.info();
  const hosting = await desktop?.coordinator.get().catch(() => null);
  const report = {
    generatedAt: new Date().toISOString(),
    app: { version: u.appVersion, platform: info?.platform, userAgent: navigator.userAgent },
    account: { userId: s.me?.userId, deviceId: s.deviceId, devices: s.devices.length },
    connection: {
      link: s.link,
      server: s.server
        ? { name: s.server.info.name, url: s.server.info.url, rttMs: Math.round(s.server.rttMs) }
        : null,
      knownServers: s.servers.map((r) => ({ name: r.info.name, rttMs: Math.round(r.rttMs) })),
      directories: directoriesInUse,
    },
    settings: {
      allowHosting: s.settings.allowHosting,
      allowServerRelay: s.settings.allowServerRelay,
      useMailbox: s.settings.useMailbox,
      status: s.settings.status,
      preferredServers: s.settings.preferredServers.length,
      voiceMode: u.voiceSettings.mode,
      pushToTalk: u.pttStatus,
    },
    sessions: Object.values(s.sessions).map((v) => ({
      id: v.id.split(':')[0],
      status: v.status,
      epoch: v.epoch,
      members: v.members.length,
      peers: v.peers.length,
      iAmHost: v.iAmHost,
      relayed: !!v.relay,
      route: v.route,
      // The network types election went by, for the host and this device.
      hostNetwork: v.networks.find((n) => n.host)?.nat ?? null,
      myNetwork: v.networks.find((n) => n.self)?.nat ?? null,
      // Steps and failure stages only: no addresses.
      attempts: v.attempts.map((a) => ({
        at: new Date(a.startedAt).toISOString(),
        viaRelay: a.viaRelay,
        steps: a.steps.map((st) => `${st.step}+${st.at - a.startedAt}ms`),
        end: a.end ? (a.end.ok ? 'ok' : `${a.end.stage}: ${a.end.reason}`) : 'pending',
      })),
    })),
    network: s.network
      ? {
          verdict: s.network.verdict,
          checks: Object.fromEntries((s.network.checks ?? []).map((c) => [c.id, c.status])),
        }
      : null,
    voice: s.voiceSession ? { muted: s.muted, deafened: s.deafened } : null,
    hostingServer: hosting
      ? { enabled: hosting.settings.enabled, status: hosting.status.state }
      : null,
    recentLog,
  };
  return JSON.stringify(report, null, 2);
}

export async function saveVoiceSettings(patch: Partial<VoiceSettings>) {
  const engine = client.voiceEngine!;
  await engine.updateSettings(patch);
  ui.set({ voiceSettings: engine.settings });
  await kv.set('voice-settings', engine.settings);
  if (patch.mode) await syncGlobalPtt();
}

export async function setPttKey(code: string) {
  ui.set({ pttKey: code });
  await kv.set('ptt-key', code);
  await syncGlobalPtt();
}

/** Push-to-talk works system-wide (games focused) when the native hook is available. */
export async function syncGlobalPtt() {
  if (!desktop) return;
  const s = ui.get();
  const status = await desktop.ptt.configure(s.voiceSettings.mode === 'ptt' ? s.pttKey : null);
  ui.set({ pttStatus: status });
}

export async function saveAppearance(patch: Partial<Appearance>) {
  const appearance = { ...ui.get().appearance, ...patch };
  ui.set({ appearance });
  applyAppearance(appearance);
  await kv.set('appearance', appearance);
}

export function applyAppearance(a: Appearance) {
  const dark =
    a.theme === 'dark' ||
    (a.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.setProperty('--accent', a.accent);
}

function shallowEqual(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function useStore<S extends object, T>(store: StateStore<S>, selector: (s: S) => T): T {
  const cache = useRef<{ value: T } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const next = selector(store.get());
    if (cache.current && shallowEqual(cache.current.value, next)) return cache.current.value;
    cache.current = { value: next };
    return next;
  });
}

/** Subscribe to a slice of client state; re-renders only when it changes (shallowly). */
export function useCroc<T>(selector: (s: ClientState) => T): T {
  return useStore(client.store, selector);
}

export function useUi<T>(selector: (s: UiState) => T): T {
  return useStore(ui, selector);
}

export const openModal = (modal: ModalState) => ui.set({ modal });
export const closeModal = () => ui.set({ modal: null });

export function navigate(view: View) {
  ui.set({ view });
  if (view.kind === 'space' && view.channelId) void client.openChannel(view.channelId);
  else if (view.kind === 'dm') void client.openDm(view.userId).then((ch) => client.openChannel(ch));
  else client.closeChannel();
}
