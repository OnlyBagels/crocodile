import { contextBridge, ipcRenderer } from 'electron';
import type {
  CoordinatorSettings,
  CoordinatorStatus,
  RelayProcessIn,
  RelayProcessOut,
  UpdateStatus,
} from '../main/ipc-types';

/** The only bridge between the sandboxed UI and the rest of the app. */
const api = {
  secure: {
    get: (key: string) => ipcRenderer.invoke('secure:get', key) as Promise<string | undefined>,
    set: (key: string, value: string) =>
      ipcRenderer.invoke('secure:set', key, value) as Promise<void>,
    delete: (key: string) => ipcRenderer.invoke('secure:delete', key) as Promise<void>,
  },
  relay: {
    send: (msg: RelayProcessIn) => ipcRenderer.invoke('relay:send', msg) as Promise<void>,
    onEvent: (fn: (msg: RelayProcessOut) => void) => {
      const listener = (_e: unknown, msg: RelayProcessOut) => fn(msg);
      ipcRenderer.on('relay:event', listener);
      return () => {
        ipcRenderer.off('relay:event', listener);
      };
    },
  },
  coordinator: {
    get: () =>
      ipcRenderer.invoke('coordinator:get') as Promise<{
        settings: CoordinatorSettings;
        status: CoordinatorStatus;
      }>,
    set: (patch: Partial<CoordinatorSettings>) =>
      ipcRenderer.invoke('coordinator:set', patch) as Promise<CoordinatorSettings>,
    onStatus: (fn: (s: CoordinatorStatus) => void) => {
      const listener = (_e: unknown, s: CoordinatorStatus) => fn(s);
      ipcRenderer.on('coordinator:status', listener);
      return () => {
        ipcRenderer.off('coordinator:status', listener);
      };
    },
  },
  ptt: {
    /** Enable system-wide push-to-talk for a key code (null disables). */
    configure: (code: string | null) =>
      ipcRenderer.invoke('ptt:configure', code) as Promise<
        'active' | 'unavailable' | 'needs-permission' | 'off'
      >,
    onState: (fn: (down: boolean) => void) => {
      const listener = (_e: unknown, down: boolean) => fn(down);
      ipcRenderer.on('ptt:state', listener);
      return () => {
        ipcRenderer.off('ptt:state', listener);
      };
    },
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status') as Promise<UpdateStatus>,
    /** Looks for a new release (never downloads it). */
    check: () => ipcRenderer.invoke('updates:check') as Promise<UpdateStatus>,
    download: () => ipcRenderer.invoke('updates:download') as Promise<UpdateStatus>,
    /** Quits and restarts into the downloaded version (or opens its installer). */
    install: () => ipcRenderer.invoke('updates:install') as Promise<void>,
    onStatus: (fn: (s: UpdateStatus) => void) => {
      const listener = (_e: unknown, s: UpdateStatus) => fn(s);
      ipcRenderer.on('updates:status', listener);
      return () => {
        ipcRenderer.off('updates:status', listener);
      };
    },
  },
  files: {
    write: (id: string, index: number, block: Uint8Array) =>
      ipcRenderer.invoke('files:write', id, index, block) as Promise<void>,
    read: (id: string, index: number, length: number) =>
      ipcRenderer.invoke('files:read', id, index, length) as Promise<Uint8Array | null>,
    delete: (id: string) => ipcRenderer.invoke('files:delete', id) as Promise<void>,
    usage: () => ipcRenderer.invoke('files:usage') as Promise<number>,
    /** Asks where to save; null if the user cancelled. Returns a token for chunk/end. */
    saveBegin: (name: string) =>
      ipcRenderer.invoke('files:save-begin', name) as Promise<string | null>,
    /** Writes to a private temporary file, to open with the system's app. */
    openBegin: (name: string) => ipcRenderer.invoke('files:open-begin', name) as Promise<string>,
    chunk: (token: string, data: Uint8Array) =>
      ipcRenderer.invoke('files:chunk', token, data) as Promise<void>,
    end: (token: string, then: 'open' | 'reveal' | 'none') =>
      ipcRenderer.invoke('files:end', token, then) as Promise<void>,
    abort: (token: string) => ipcRenderer.invoke('files:abort', token) as Promise<void>,
  },
  app: {
    info: () =>
      ipcRenderer.invoke('app:info') as Promise<{
        version: string;
        platform: string;
        directories: string[];
        cpuCores: number;
      }>,
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<void>,
    /** Copy text, focused or not (the web clipboard needs the window focused). */
    copyText: (text: string) => ipcRenderer.invoke('app:copy-text', text) as Promise<void>,
    setBadge: (count: number) => ipcRenderer.invoke('app:badge', count) as Promise<void>,
    takeDeepLink: () => ipcRenderer.invoke('app:take-deeplink') as Promise<string | null>,
    onDeepLink: (fn: (url: string) => void) => {
      const listener = (_e: unknown, url: string) => fn(url);
      ipcRenderer.on('app:deeplink', listener);
      return () => {
        ipcRenderer.off('app:deeplink', listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('crocodile', api);
export type DesktopApi = typeof api;
