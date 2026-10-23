/**
 * Which URLs the main window may navigate to. Its preload exposes the identity
 * seed over IPC, and a dropped file navigates the window to that file by
 * default, so only the app's own entry and its hash/query routes are allowed
 * (plus the dev server when set) — never an arbitrary `file://` path.
 */
export function isAllowedNavigation(url: string, appUrl: string, devUrl?: string): boolean {
  if (devUrl && url.startsWith(devUrl)) return true;
  return url === appUrl || url.startsWith(`${appUrl}#`) || url.startsWith(`${appUrl}?`);
}
