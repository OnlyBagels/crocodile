/**
 * Which URLs the main window may navigate to. Its preload exposes the identity
 * seed over IPC, and a dropped file navigates the window to that file by
 * default, so only the app's own entry and its hash/query routes are allowed
 * (plus the dev server's origin when set) — never an arbitrary `file://` path.
 */
export function isAllowedNavigation(url: string, appUrl: string, devUrl?: string): boolean {
  const target = parse(url);
  if (!target) return false;
  const dev = devUrl ? parse(devUrl) : undefined;
  // Only a web origin: a file: or custom-scheme URL has the opaque origin "null", which every such URL shares.
  if (dev && /^https?:$/.test(dev.protocol) && target.origin === dev.origin) return true;
  // Parsed rather than compared as text: Chromium spells the same path in its
  // own way (%20 for a space, the case of a drive letter).
  const app = parse(appUrl);
  return (
    !!app &&
    target.protocol === app.protocol &&
    target.host === app.host &&
    comparable(target.pathname) === comparable(app.pathname)
  );
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** The drive letter of a Windows path has no case. */
function comparable(pathname: string): string {
  return pathname.replace(/^\/([a-z]):/i, (_, d: string) => `/${d.toLowerCase()}:`);
}
