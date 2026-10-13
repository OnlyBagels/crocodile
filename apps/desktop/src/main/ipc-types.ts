import type { SignalData } from '@crocodile/protocol';

/** Messages between the main process and the relay utility process. */
export type RelayProcessIn =
  | {
      type: 'start';
      handle: string;
      seed: string;
      hostPeer: string;
      sessionId: string;
      epoch: number;
      slots: number;
      iceServers: { urls: string }[];
    }
  | { type: 'signal'; handle: string; from: string; data: SignalData }
  | { type: 'members'; handle: string; members: string[] }
  | { type: 'close'; handle: string };

export type RelayProcessOut =
  | { type: 'signal'; handle: string; to: string; data: SignalData }
  | { type: 'log'; level: 'info' | 'warn'; msg: string; extra?: Record<string, unknown> }
  | { type: 'started'; handle: string }
  | { type: 'error'; handle: string; message: string };

export interface CoordinatorSettings {
  enabled: boolean;
  name: string;
  port: number;
  publicUrl?: string;
  /** How people reach whoever runs the server: an email or an https:// page. */
  contact?: string;
  announce: boolean;
  /** Offer the opt-in relay (TURN) to users without a direct path. */
  relay: boolean;
  /** How many users may use the relay at once. */
  relayMaxUsers: number;
  /** Hold sealed messages for offline people (opt-in mailbox). */
  mailbox: boolean;
}

export type CoordinatorStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | {
      state: 'running';
      url: string;
      id: string;
      peers: number;
      users: number;
      publicUrl?: string;
      announced: boolean;
      /** Addresses others on the local network can use. */
      lanUrls: string[];
    }
  | { state: 'error'; message: string };

export type CoordinatorProcessIn =
  | {
      type: 'start';
      settings: CoordinatorSettings;
      dataDir: string;
      directories: string[];
      /** The app's version, which its server reports. */
      version: string;
    }
  | { type: 'stop' }
  | { type: 'status' };
export type CoordinatorProcessOut = { type: 'status'; status: CoordinatorStatus };

/** In-app updates (src/main/updates.ts), as shown in the app. */
export type UpdateStatus =
  /** This build can't update itself (a development build). */
  | { state: 'unsupported' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current'; checkedAt: number }
  /** 'download': it can't be installed from the app; the download page opens. */
  | { state: 'available'; version: string; how: 'install' | 'download' }
  | { state: 'downloading'; version: string; percent: number }
  /** 'open': the installer opens (and the app quits) instead of a restart. */
  | { state: 'ready'; version: string; after: 'restart' | 'open' }
  | { state: 'error'; message: string; version?: string };

/** A screen or window that can be shared. */
export interface ScreenSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** Small picture of it, as a data URL. */
  thumbnail: string | null;
  /** A window's app icon, as a data URL. */
  icon: string | null;
}

export interface ScreenSources {
  sources: ScreenSource[];
  /** The computer's sound can be shared too (Windows). */
  canShareSound: boolean;
  /** Whether the system lets the app record the screen (macOS asks in System Settings). */
  access: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
}
