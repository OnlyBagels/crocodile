import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  session,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus } from 'node:os';
import { contextMenuTemplate } from './context-menu';
import { configureGlobalPtt, stopGlobalPtt } from './global-ptt';
import { FileExports, FileStore, RISKY_EXTENSIONS, safeFileName } from './file-store';
import { SecureStore } from './secure-store';
import { isAllowedNavigation } from './navigation';
import { createUpdateEngine } from './update-engines';
import { UpdateController } from './updates';
import type {
  CoordinatorProcessOut,
  CoordinatorSettings,
  CoordinatorStatus,
  RelayProcessIn,
  RelayProcessOut,
  UpdateStatus,
} from './ipc-types';
import { setupScreenShare } from './screen-share';

// A packaged app never loads a renderer from elsewhere, whatever the environment says.
const isDev = !app.isPackaged && !!process.env.CROC_RENDERER_URL;
const APP_PROTOCOL = 'croc';

// Separate profiles (e.g. two instances on one machine for testing).
if (process.env.CROC_USER_DATA) app.setPath('userData', process.env.CROC_USER_DATA);

// WebRTC: expose real host candidates so peers on the same LAN (and this
// machine's own relay) connect directly instead of through NAT hairpinning.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.setAppUserModelId('chat.crocodile.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let pendingDeepLink: string | null = null;

const userData = () => app.getPath('userData');
const resource = (...p: string[]) =>
  app.isPackaged ? join(process.resourcesPath, ...p) : join(__dirname, '../../resources', ...p);

// ---------------------------------------------------------------------------
// Secure storage (identity seed): encrypted with the OS keychain via safeStorage.
// ---------------------------------------------------------------------------

const secure = new SecureStore(join(userData(), 'secure.json'), safeStorage);

ipcMain.handle('secure:get', (_e, key: string) => secure.get(key));
ipcMain.handle('secure:set', (_e, key: string, value: string) => secure.set(key, value));
ipcMain.handle('secure:delete', (_e, key: string) => secure.delete(key));

// ---------------------------------------------------------------------------
// Host relay utility process
// ---------------------------------------------------------------------------

let relayProc: UtilityProcess | null = null;

function relayProcess(): UtilityProcess {
  if (relayProc) return relayProc;
  const proc = utilityProcess.fork(join(__dirname, 'relay-process.cjs'), [], {
    serviceName: 'Crocodile Relay',
  });
  proc.on('message', (msg: RelayProcessOut) => {
    if (msg.type === 'log') console.log(`[relay] ${msg.msg}`, msg.extra ?? '');
    else win?.webContents.send('relay:event', msg);
  });
  proc.on('exit', () => {
    relayProc = null;
    win?.webContents.send('relay:event', {
      type: 'error',
      handle: '*',
      message: 'relay process exited',
    });
  });
  relayProc = proc;
  return proc;
}

ipcMain.handle('relay:send', (_e, msg: RelayProcessIn) => {
  relayProcess().postMessage(msg);
});

// ---------------------------------------------------------------------------
// Embedded coordination server (opt-in)
// ---------------------------------------------------------------------------

let coordProc: UtilityProcess | null = null;
let coordStatus: CoordinatorStatus = { state: 'stopped' };
const coordSettingsPath = () => join(userData(), 'coordinator.json');
const defaultCoordSettings: CoordinatorSettings = {
  enabled: false,
  name: `${process.env.USER ?? process.env.USERNAME ?? 'Someone'}'s coordinator`,
  port: 7443,
  announce: true,
  relay: false,
  relayMaxUsers: 10,
  mailbox: false,
};

function coordSettings(): CoordinatorSettings {
  try {
    return { ...defaultCoordSettings, ...JSON.parse(readFileSync(coordSettingsPath(), 'utf8')) };
  } catch {
    return defaultCoordSettings;
  }
}

function directories(): string[] {
  const raw = process.env.CROC_DIRECTORIES_OVERRIDE ?? process.env.CROC_DIRECTORIES ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyCoordinator() {
  const s = coordSettings();
  if (!s.enabled) {
    coordProc?.postMessage({ type: 'stop' });
    return;
  }
  if (!coordProc) {
    coordProc = utilityProcess.fork(join(__dirname, 'coordinator-process.cjs'), [], {
      serviceName: 'Crocodile Coordinator',
    });
    coordProc.on('message', (msg: CoordinatorProcessOut) => {
      coordStatus = msg.status;
      win?.webContents.send('coordinator:status', coordStatus);
    });
    coordProc.on('exit', () => {
      coordProc = null;
      coordStatus = { state: 'stopped' };
      win?.webContents.send('coordinator:status', coordStatus);
    });
  }
  coordProc.postMessage({
    type: 'start',
    settings: s,
    dataDir: join(userData(), 'coordinator'),
    directories: directories(),
    version: app.getVersion(),
  });
}

ipcMain.handle('coordinator:get', () => ({ settings: coordSettings(), status: coordStatus }));
ipcMain.handle('coordinator:set', (_e, patch: Partial<CoordinatorSettings>) => {
  const next = { ...coordSettings(), ...patch };
  mkdirSync(userData(), { recursive: true });
  writeFileSync(coordSettingsPath(), JSON.stringify(next, null, 2));
  applyCoordinator();
  return next;
});

// ---------------------------------------------------------------------------
// Files: encrypted blocks, and saving or opening what the UI decrypts.
// ---------------------------------------------------------------------------

const fileStore = new FileStore(join(userData(), 'files'));
const exportsInProgress = new FileExports();

ipcMain.handle('files:write', (_e, id: string, index: number, block: Uint8Array) =>
  fileStore.write(id, index, block),
);
ipcMain.handle('files:read', (_e, id: string, index: number, length: number) =>
  fileStore.read(id, index, length),
);
ipcMain.handle('files:delete', (_e, id: string) => fileStore.delete(id));
ipcMain.handle('files:usage', () => fileStore.usage());

ipcMain.handle('files:save-begin', async (_e, name: unknown) => {
  const options = {
    defaultPath: join(app.getPath('downloads'), safeFileName(name)),
  };
  const res = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (res.canceled || !res.filePath) return null;
  return exportsInProgress.begin(res.filePath, false);
});
ipcMain.handle('files:open-begin', async (_e, name: unknown) =>
  exportsInProgress.begin(await exportsInProgress.tempPath(safeFileName(name)), true),
);
ipcMain.handle('files:chunk', (_e, token: string, data: Uint8Array) =>
  exportsInProgress.chunk(token, data),
);
ipcMain.handle('files:abort', (_e, token: string) => exportsInProgress.abort(token));
/** Finish a save or open: `open` opens it, `reveal` shows it in its folder. */
ipcMain.handle('files:end', async (_e, token: string, then: 'open' | 'reveal' | 'none') => {
  const path = await exportsInProgress.end(token);
  if (then === 'reveal') shell.showItemInFolder(path);
  if (then === 'open') {
    // Asked here rather than in the UI, so nothing the UI does can skip it.
    if (RISKY_EXTENSIONS.has(extname(safeFileName(path)).slice(1).toLowerCase())) {
      const options = {
        type: 'warning' as const,
        buttons: ['Cancel', 'Open anyway'],
        defaultId: 0,
        cancelId: 0,
        message: `Open ${safeFileName(path)}?`,
        detail:
          'This kind of file can run code on your computer. Only open it if you trust ' +
          'the person who sent it and expected it.',
      };
      const res = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      if (res.response !== 1) return;
    }
    const err = await shell.openPath(path);
    if (err) throw new Error(err);
  }
});

// ---------------------------------------------------------------------------
// Misc app services
// ---------------------------------------------------------------------------

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  directories: directories(),
  cpuCores: cpus().length,
}));

ipcMain.handle('app:open-external', (_e, url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
});

ipcMain.handle('app:copy-text', (_e, text: unknown) => {
  if (typeof text === 'string' && text.length <= 100_000) clipboard.writeText(text);
});

ipcMain.handle('app:badge', (_e, count: number) => {
  if (process.platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '');
  else app.setBadgeCount(count);
});

ipcMain.handle('ptt:configure', (e, code: string | null) => configureGlobalPtt(e.sender, code));

ipcMain.handle('app:take-deeplink', () => {
  const link = pendingDeepLink;
  pendingDeepLink = null;
  return link;
});

function handleDeepLink(url: string | undefined) {
  if (!url?.startsWith(`${APP_PROTOCOL}://`)) return;
  pendingDeepLink = url;
  win?.webContents.send('app:deeplink', url);
  showWindow();
}

// ---------------------------------------------------------------------------
// Window, tray, lifecycle
// ---------------------------------------------------------------------------

function appIcon(name = 'icon.png') {
  const file = resource(name);
  return existsSync(file) ? nativeImage.createFromPath(file) : undefined;
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#1e1f22',
    title: 'Crocodile',
    icon: appIcon(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
    // Like Discord: closing keeps you reachable in the tray.
    if (!quitting && tray && process.platform !== 'darwin') {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('context-menu', (_e, params) => {
    const contents = win?.webContents;
    if (!contents) return;
    const template = contextMenuTemplate(params, {
      replaceMisspelling: (word) => contents.replaceMisspelling(word),
      addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      openLink: (url) => void shell.openExternal(url),
      copy: (text) => clipboard.writeText(text),
    });
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win! });
  });
  const appUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString();
  const guardNavigation = (e: { preventDefault(): void }, url: string) => {
    if (!isAllowedNavigation(url, appUrl, isDev ? process.env.CROC_RENDERER_URL : undefined))
      e.preventDefault();
  };
  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-frame-navigate', (e) => guardNavigation(e, e.url));
  if (isDev) void win.loadURL(process.env.CROC_RENDERER_URL!);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

function createTray() {
  const icon = appIcon('tray.png');
  if (!icon) return;
  tray = new Tray(process.platform === 'darwin' ? icon.resize({ width: 18, height: 18 }) : icon);
  tray.setToolTip('Crocodile');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Crocodile', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);
}

app.on('second-instance', (_e, argv) => {
  handleDeepLink(argv.find((a) => a.startsWith(`${APP_PROTOCOL}://`)));
  showWindow();
});

app.on('open-url', (e, url) => {
  e.preventDefault();
  handleDeepLink(url);
});

app.whenReady().then(() => {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [process.argv[1]!]);
  } else {
    app.setAsDefaultProtocolClient(APP_PROTOCOL);
  }
  handleDeepLink(process.argv.find((a) => a.startsWith(`${APP_PROTOCOL}://`)));

  // Microphone and camera ('media'); screens go through the picker (screen-share.ts);
  // full screen for a screen someone shares.
  const allowed = [
    'media',
    'display-capture',
    'fullscreen',
    'notifications',
    'clipboard-sanitized-write',
    'speaker-selection',
  ];
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    allowed.includes(permission),
  );
  setupScreenShare();

  createWindow();
  createTray();
  applyCoordinator();

  void startUpdates();
});

// ---------------------------------------------------------------------------
// Updates: checked now and then; downloaded and installed when the user says.
// ---------------------------------------------------------------------------

let updates = new UpdateController(null, () => {});
/** Versions the user was already told about in a notification. */
const announced = new Set<string>();

function publishUpdate(s: UpdateStatus) {
  win?.webContents.send('updates:status', s);
  if (s.state !== 'available' || announced.has(s.version)) return;
  announced.add(s.version);
  if (win?.isFocused() || !Notification.isSupported()) return;
  const n = new Notification({
    title: 'A new version of Crocodile is available',
    body: `Version ${s.version} is out. Open Crocodile to update.`,
  });
  n.on('click', showWindow);
  n.show();
}

async function startUpdates() {
  try {
    // Installing quits through app.quit(), so before-quit marks the app as quitting.
    const engine = await createUpdateEngine();
    updates = new UpdateController(engine, publishUpdate);
    publishUpdate(updates.status);
    if (!engine) return;
    setTimeout(() => void updates.check(), UPDATE_FIRST_CHECK_MS);
    setInterval(() => void updates.check(), UPDATE_CHECK_EVERY_MS).unref();
  } catch (err) {
    console.warn('updates unavailable', err);
  }
}

const UPDATE_FIRST_CHECK_MS = Number(process.env.CROC_UPDATE_FIRST_CHECK_MS ?? 15_000);
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000;

ipcMain.handle('updates:status', () => updates.status);
ipcMain.handle('updates:check', () => updates.check());
ipcMain.handle('updates:download', () => updates.download());
ipcMain.handle('updates:install', () => updates.install());

app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
  stopGlobalPtt();
  exportsInProgress.cleanup();
  relayProc?.kill();
  coordProc?.postMessage({ type: 'stop' });
  setTimeout(() => coordProc?.kill(), 1500);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
