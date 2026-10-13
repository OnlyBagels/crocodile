import { desktopCapturer, ipcMain, session, systemPreferences } from 'electron';
import type { ScreenSource, ScreenSources } from './ipc-types';

/**
 * Screen sharing: the UI shows the screens and windows to pick from, says
 * which one the user chose (and whether its sound goes too), then asks for
 * it with getDisplayMedia; the handler here answers with that choice, and
 * nothing else. A request without a fresh choice gets nothing.
 */

/** Electron captures the computer's sound on Windows only. */
export const CAN_SHARE_SOUND = process.platform === 'win32';
/** How long a choice waits for the request it was made for. */
const CHOICE_TTL_MS = 30_000;

let chosen: { id: string; audio: boolean; at: number } | null = null;

export function setupScreenShare() {
  ipcMain.handle('screen:sources', async (): Promise<ScreenSources> => {
    // macOS asks once, in System Settings, whether the app may record the screen.
    const access =
      process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
    const found = await desktopCapturer
      .getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      })
      .catch(() => []);
    const sources: ScreenSource[] = found.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
    return { sources, canShareSound: CAN_SHARE_SOUND, access };
  });

  ipcMain.handle('screen:choose', (_e, id: unknown, audio: unknown) => {
    if (typeof id !== 'string' || id.length > 200) throw new Error('bad source');
    chosen = { id, audio: audio === true && CAN_SHARE_SOUND, at: Date.now() };
  });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const c = chosen;
    chosen = null;
    if (!c || Date.now() - c.at > CHOICE_TTL_MS) return callback({});
    void desktopCapturer
      .getSources({ types: ['screen', 'window'] })
      .then((sources) => {
        const video = sources.find((s) => s.id === c.id);
        if (!video) return callback({});
        callback({ video, ...(c.audio ? { audio: 'loopback' as const } : {}) });
      })
      .catch(() => callback({}));
  });
}
