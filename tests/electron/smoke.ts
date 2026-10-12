/**
 * Drives two real Electron instances through onboarding, space creation,
 * invites, chat and voice against a local directory + coordinator, taking
 * screenshots along the way. Run: xvfb-run -a npx tsx tests/electron/smoke.ts <outdir>
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Directory } from '@crocodile/directory';
import { Coordinator } from '@crocodile/coordinator';

const out = process.argv[2] ?? join(tmpdir(), 'croc-shots');
mkdirSync(out, { recursive: true });
const appDir = join(import.meta.dirname, '../../apps/desktop');
const require = createRequire(join(appDir, 'package.json'));
const electronPath = require('electron') as unknown as string;

const directory = await new Directory({
  host: '127.0.0.1',
  port: 0,
  allowPrivateUrls: true,
}).start();
const coordinator = await new Coordinator({
  name: 'Local test coordinator',
  host: '127.0.0.1',
  port: 0,
  storage: 'memory',
  stunPort: 0,
  directoryUrls: [directory.url],
  announce: true,
  operatorContact: 'https://example.org/privacy/',
  logLevel: 'warn',
}).start();
await new Promise((r) => setTimeout(r, 1000));

async function launch(
  name: string,
  opts: { noDirectory?: boolean; env?: Record<string, string> } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  // CROC_APP_EXEC points at a packaged build (e.g. release/linux-unpacked/crocodile).
  const packaged = process.env.CROC_APP_EXEC;
  const app = await electron.launch({
    executablePath: packaged ?? electronPath,
    args: [
      ...(packaged ? [] : [appDir]),
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
    env: {
      ...process.env,
      CROC_USER_DATA: mkdtempSync(join(tmpdir(), `croc-${name}-`)),
      CROC_DIRECTORIES_OVERRIDE: opts.noDirectory ? '' : directory.url,
      ...opts.env,
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`));
  return { app, page };
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`screenshot ${name}`);
}

async function onboard(page: Page, name: string) {
  await page.getByText("I'm new here").click();
  await page.getByPlaceholder('e.g. Wally').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Keep your recovery key').waitFor();
  return page;
}

async function finishOnboarding(page: Page) {
  await page.getByText('I saved my recovery key').click();
  await page.getByRole('button', { name: 'Start talking' }).click();
  await page.getByText('Add someone').waitFor();
}

const a = await launch('alice');
await shot(a.page, '01-welcome');
await onboard(a.page, 'Alice');
await shot(a.page, '02-recovery-key');
await finishOnboarding(a.page);
await a.page.waitForFunction(() => /Alice#\d+/.test(document.body.innerText), undefined, {
  timeout: 15_000,
});
await shot(a.page, '03-home');

// Create a space.
await a.page.getByTitle('Create or join a space').click();
await a.page.getByText('Create my own').click();
await a.page.getByRole('dialog').getByRole('textbox').fill('The Swamp');
await a.page.getByRole('button', { name: 'Create' }).click();
await a.page.getByText('This is the start of general').waitFor({ timeout: 15_000 });
await shot(a.page, '04-space');

// Invite.
await a.page.getByRole('button', { name: 'Invite people' }).click();
await a.page.waitForFunction(
  () => /croc:\/\/join\/[a-z2-7]+/.test(document.body.innerText),
  undefined,
  { timeout: 15_000 },
);
const inviteText = await a.page.evaluate(
  () => document.body.innerText.match(/croc:\/\/join\/[a-z2-7]+/)![0],
);
await shot(a.page, '05-invite');
await a.page.keyboard.press('Escape');

// Bob joins.
const b = await launch('bob');
await onboard(b.page, 'Bob');
await finishOnboarding(b.page);
await b.page.getByTitle('Create or join a space').click();
await b.page.getByRole('button', { name: 'Join a space' }).click();
await b.page.getByPlaceholder('croc://join/abcd2345').fill(inviteText);
await b.page.getByRole('button', { name: 'Join space' }).click();
await b.page.getByText('This is the start of general').waitFor({ timeout: 15_000 });
// Only the owner can make invites: Bob isn't offered any.
if (await b.page.getByRole('button', { name: 'Invite people' }).count())
  throw new Error('a member who does not own the space is offered invites');

// Chat both ways.
await a.page.waitForFunction(
  () => /[12] peers? connected/.test(document.body.innerText),
  undefined,
  { timeout: 20_000 },
);
await a.page.getByPlaceholder('Message general').fill('Hi Bob! This never touches a server 🐊');
await a.page.keyboard.press('Enter');
await b.page.getByText('This never touches a server').waitFor({ timeout: 15_000 });
await b.page
  .getByPlaceholder('Message general')
  .fill('Wow, **end-to-end** and peer-to-peer. `nice`');
await b.page.keyboard.press('Enter');
await a.page.getByText('peer-to-peer.').waitFor({ timeout: 15_000 });
// Bob's header says how his connection to Alice's device travels.
await b.page.waitForFunction(
  () => /peers? connected · (same network|on this device|direct)/.test(document.body.innerText),
  undefined,
  { timeout: 15_000 },
);
await shot(a.page, '06-chat');
// Panel shadows stay as faint as designed (12% opaque) whatever the accent.
const shadow = await a.page.evaluate(() => {
  const probe = document.body.appendChild(document.createElement('div'));
  probe.style.boxShadow = 'var(--shadow)';
  const value = getComputedStyle(probe).boxShadow;
  probe.remove();
  return value;
});
if (!/[/,] 0\.12\)/.test(shadow)) throw new Error(`panel shadow is too strong: ${shadow}`);

// Voice room.
const inCall = (page: Page) =>
  page.waitForFunction(() => /you host|hosted by/.test(document.body.innerText), undefined, {
    timeout: 30_000,
  });
await a.page.getByText('General', { exact: true }).click();
await b.page.getByText('General', { exact: true }).click();
await inCall(a.page);
await inCall(b.page);
await a.page.waitForTimeout(2000);
await shot(a.page, '07-voice');
await shot(b.page, '08-voice-bob');

// People.
await b.page.getByRole('button', { name: 'Home' }).click();
await b.page.getByPlaceholder('name#1234').fill('alice');
await b.page.getByRole('button', { name: 'Search' }).click();
await b.page.getByRole('button', { name: 'Add friend' }).waitFor({ timeout: 10_000 });
await shot(b.page, '09-add-friend');
await b.page.getByRole('button', { name: 'Add friend' }).click();
await a.page.getByRole('button', { name: 'Home' }).click();
await a.page.getByRole('button', { name: /Requests/ }).click();
await a.page.getByText('Wants to be friends').waitFor({ timeout: 10_000 });
await shot(a.page, '10-friend-request');

// A call shows as ringing, not as on, until the friend picks up.
await a.page.getByRole('button', { name: 'Accept' }).click();
await a.page.getByRole('button', { name: /^All/ }).click();
await a.page.getByRole('button', { name: 'Call', exact: true }).click();
await a.page.getByText('Ringing…').waitFor({ timeout: 15_000 });
await b.page.getByText('is calling you').waitFor({ timeout: 15_000 });
await a.page.waitForTimeout(1500);
if (!(await a.page.getByText('Ringing…').isVisible()))
  throw new Error('the call looks answered before the friend picked up');
await shot(a.page, '10b-ringing');
await b.page.getByRole('button', { name: 'Accept' }).click();
await a.page.getByText('Ringing…').waitFor({ state: 'detached', timeout: 15_000 });
await a.page.waitForFunction(() => /\b0:0\d\b/.test(document.body.innerText), undefined, {
  timeout: 15_000,
});
await a.page.getByRole('button', { name: 'Leave call' }).click();

// Command palette + settings.
// The search button shows a search icon and this system's shortcut, not the Mac ⌘ key.
const jump = a.page.getByRole('button', { name: /Jump to/ });
if (
  (await jump.locator('svg.lucide-search').count()) !== 1 ||
  (await jump.locator('svg.lucide-command').count()) !== 0 ||
  !(await jump.innerText()).includes('Ctrl K')
)
  throw new Error('the search button should show a search icon and "Ctrl K" off the Mac');
await a.page.keyboard.press('Control+K');
await a.page.waitForTimeout(200);
await shot(a.page, '11-palette');
await a.page.keyboard.press('Escape');
await a.page.getByLabel('Account').click();
await a.page.getByText('Settings', { exact: true }).click();
await a.page.getByRole('button', { name: 'Voice' }).click();
await shot(a.page, '12-settings-voice');
await a.page.getByRole('button', { name: 'Network' }).click();
// The network check ran on connecting, and can run again.
const test = a.page.getByRole('region', { name: 'Connection test' });
const verdicts = /Direct connections (work|are limited|are blocked)|couldn't be fully tested/;
await test.getByText(verdicts).waitFor({ timeout: 15_000 });
await test.getByRole('button', { name: 'Test again' }).click();
await test.getByRole('button', { name: 'Test again' }).waitFor({ timeout: 15_000 });
await test.getByText(verdicts).waitFor({ timeout: 15_000 });
// What the check looked at, one line each, and why it decided what it did.
const checked = test.getByRole('list', { name: 'What was checked' });
await checked.getByText('UDP reaches the coordination server').waitFor();
await test.getByText(/^Result:/).waitFor();
// Who runs the connected server, as it says.
await a.page.getByRole('button', { name: 'https://example.org/privacy/' }).waitFor();
// The public server list from the directory, with the connected server marked.
const listed = a.page
  .getByRole('region', { name: 'Public servers' })
  .getByRole('group', { name: 'Local test coordinator' });
await listed.getByText('Using').waitFor();
await listed.getByText(/\d+ ms/).waitFor();
await shot(a.page, '13-settings-network');
// Running a server asks first and says what the server will keep.
await a.page.getByRole('button', { name: 'Host a server' }).click();
const runServer = a.page.getByRole('switch', { name: 'Run a coordination server' });
await runServer.click();
const hostConfirm = a.page.getByRole('region', { name: 'Before you run a server' });
await hostConfirm.getByText("keeps a copy of everyone's account records").waitFor();
await shot(a.page, '13b-host-confirm');
await hostConfirm.getByRole('button', { name: 'Cancel' }).click();
await hostConfirm.waitFor({ state: 'detached' });
if ((await runServer.getAttribute('aria-checked')) !== 'false')
  throw new Error('cancelling must leave the server off');
await a.page.getByRole('button', { name: 'Appearance' }).click();
await a.page.getByRole('button', { name: 'Lagoon' }).click();
await shot(a.page, '14-settings-dark');
// The whole app follows the accent, its background included.
const appBackground = () => a.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const greenBackground = await appBackground();
await a.page.getByRole('button', { name: 'Accent #a27bf0' }).click();
if ((await appBackground()) === greenBackground)
  throw new Error('the app background must follow the accent');
await shot(a.page, '14b-accent-purple');
await a.page.getByRole('button', { name: 'Accent #34c77b' }).click();
// Bug-report diagnostics: copied as JSON, without message content.
await a.page.getByRole('button', { name: 'About' }).click();
await a.page.getByRole('heading', { name: 'Crocodile', exact: true }).waitFor();
await shot(a.page, '14c-about');
// Donation links open in the browser; nothing from those sites loads in the app.
await a.app.evaluate(({ shell }) => {
  const opened: string[] = [];
  (globalThis as { opened?: string[] }).opened = opened;
  shell.openExternal = async (url: string) => void opened.push(url);
});
const support = a.page.getByRole('region', { name: 'Support Crocodile' });
await support.scrollIntoViewIfNeeded();
await shot(a.page, '14d-support');
await support.getByRole('button', { name: 'GitHub Sponsors' }).click();
await support.getByRole('button', { name: 'Ko-fi' }).click();
await a.page.waitForTimeout(300);
const opened = await a.app.evaluate(() => (globalThis as { opened?: string[] }).opened);
if (
  JSON.stringify(opened) !==
  JSON.stringify(['https://github.com/sponsors/pwalda', 'https://ko-fi.com/pwalda'])
)
  throw new Error(`donation links opened ${JSON.stringify(opened)}`);
await a.page.getByRole('button', { name: 'Copy diagnostics' }).click();
await a.page.getByText('Copied').first().waitFor();
const report = JSON.parse(await a.app.evaluate(({ clipboard }) => clipboard.readText()));
if (report.connection.link !== 'connected' || !Array.isArray(report.recentLog))
  throw new Error('diagnostics report is incomplete');
if (JSON.stringify(report.connection.directories) !== JSON.stringify([directory.url]))
  throw new Error(`expected the test directory, got ${report.connection.directories}`);
if (JSON.stringify(report).includes('This never touches a server'))
  throw new Error('diagnostics must not contain message content');
if (!report.sessions.some((x: { attempts?: unknown[] }) => x.attempts?.length))
  throw new Error('diagnostics must say how connections went');
// Debug: every connection, live.
await a.page.getByRole('button', { name: 'Debug' }).click();
const debugSessions = a.page.getByRole('region', { name: 'Sessions' });
await debugSessions.getByText('The Swamp (chat)').waitFor({ timeout: 10_000 });
await a.page.getByRole('region', { name: 'Client log' }).getByLabel('Log lines').waitFor();
await debugSessions.getByText('The Swamp (chat)').click();
await debugSessions.getByRole('region', { name: 'Connection attempts' }).first().waitFor();
await shot(a.page, '14e-debug');
await a.page.getByRole('button', { name: 'Close settings' }).click();
await a.page.getByRole('button', { name: 'The Swamp' }).click();
await shot(a.page, '15-dark-chat');
// Where a connection stands, step by step.
await a.page.getByTitle('Connection details').first().click();
const details = a.page.getByRole('dialog');
await details.getByRole('region', { name: 'Connection attempts' }).waitFor();
// The network types host election went by.
await details.getByLabel("Members' networks").waitFor();
await shot(a.page, '15b-connection');
await a.page.keyboard.press('Escape');
await details.waitFor({ state: 'detached' });

// Link a second device to Alice's account.
const c = await launch('alice-laptop');
await c.page.getByText('I already use Crocodile').click();
await c.page.getByText('Link from another device').click();
await c.page.waitForFunction(() => /\b[A-Z2-7]{8}\b/.test(document.body.innerText), undefined, {
  timeout: 15_000,
});
const linkCode = await c.page.evaluate(() => document.body.innerText.match(/\b[A-Z2-7]{8}\b/)![0]);
await shot(c.page, '16-link-new-device');
await a.page.getByLabel('Account').click();
await a.page.getByText('Link another device').click();
await a.page.getByPlaceholder('ABCD2345').fill(linkCode);
await a.page.getByRole('button', { name: 'Continue' }).click();
await a.page.getByText('They match').waitFor({ timeout: 10_000 });
await shot(a.page, '17-link-confirm');
await a.page.getByText('They match').click();
await c.page.getByText('The Swamp').first().waitFor({ timeout: 30_000 });
await a.page.getByRole('button', { name: 'Done' }).click();
await shot(c.page, '18-linked-device');

// A first tester with no server list: signs up offline, then connects by address.
const d = await launch('newcomer', { noDirectory: true });
await onboard(d.page, 'Dora');
await finishOnboarding(d.page);
await d.page.getByText("Can't reach a coordination server").waitFor({ timeout: 20_000 });
await shot(d.page, '19-no-server');
// "No directory" must win over the directory built into release builds.
await d.page.getByLabel('Account').click();
await d.page.getByText('Settings', { exact: true }).click();
await d.page.getByRole('button', { name: 'About' }).click();
await d.page.getByRole('button', { name: 'Copy diagnostics' }).click();
await d.page.getByText('Copied').first().waitFor();
const newcomer = JSON.parse(await d.app.evaluate(({ clipboard }) => clipboard.readText()));
if (newcomer.connection.directories.length !== 0)
  throw new Error(`newcomer must use no directory, got ${newcomer.connection.directories}`);
await d.page.getByRole('button', { name: 'Close settings' }).click();
await d.page.getByLabel('Server address').fill(coordinator.url.replace('http://', ''));
await d.page.getByRole('button', { name: 'Connect' }).click();
await d.page.waitForFunction(() => /Dora#\d+/.test(document.body.innerText), undefined, {
  timeout: 20_000,
});
await d.page.getByText("Can't reach a coordination server").waitFor({ state: 'detached' });
await shot(d.page, '20-connected-by-address');
// Deleting the account: typed confirmation, then back to the welcome screen.
await d.page.getByLabel('Account').click();
await d.page.getByText('Settings', { exact: true }).click();
await d.page.getByRole('button', { name: 'Delete account' }).click();
const confirm = d.page.getByRole('dialog');
const deleteButton = confirm.getByRole('button', { name: 'Delete account' });
if (await deleteButton.isEnabled()) throw new Error('delete must wait for the typed name');
await confirm.getByLabel('Type Dora to confirm').fill('Dora');
await shot(d.page, '21-delete-account');
await deleteButton.click();
await d.page.getByText('Your account was deleted').waitFor({ timeout: 15_000 });
await d.page.getByText("I'm new here").waitFor();
await shot(d.page, '22-account-deleted');
await d.app.close();

// In-app update (a pretend release): offered, downloaded on request, then restart.
const u = await launch('updater', {
  noDirectory: true,
  env: {
    CROC_FAKE_UPDATE: '9.9.0',
    CROC_UPDATE_FIRST_CHECK_MS: '500',
    CROC_FAKE_UPDATE_STEP_MS: '250',
  },
});
let updaterLog = '';
u.app.process().stdout?.on('data', (d: Buffer) => (updaterLog += d.toString()));
await onboard(u.page, 'Ulla');
await finishOnboarding(u.page);
await u.page.getByRole('button', { name: 'Update', exact: true }).waitFor({ timeout: 15_000 });
await shot(u.page, '22c-update-available');
await u.page.getByRole('button', { name: 'Update', exact: true }).click();
await u.page.getByRole('button', { name: /Updating \d+%/ }).waitFor();
await shot(u.page, '22d-update-downloading');
await u.page.getByRole('button', { name: /Updating/ }).click();
await u.page.getByRole('progressbar', { name: 'Download progress' }).waitFor();
await u.page.getByText('Version 9.9.0 is downloaded').waitFor({ timeout: 15_000 });
await shot(u.page, '22e-update-ready');
await u.page.getByRole('dialog').getByRole('button', { name: 'Restart to update' }).click();
for (let i = 0; i < 50 && !updaterLog.includes('would restart into 9.9.0'); i++)
  await new Promise((r) => setTimeout(r, 100));
if (!updaterLog.includes('would restart into 9.9.0'))
  throw new Error('Restart to update must install the downloaded version');
// The pretend installer didn't start (like a cancelled password prompt): the
// app keeps running as before, so closing the window hides it to the tray.
await u.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
await new Promise((r) => setTimeout(r, 500));
const hidden = await u.app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().map((w) => w.isVisible()),
);
if (JSON.stringify(hidden) !== '[false]')
  throw new Error(`after an install that didn't start, closing must hide the window: ${hidden}`);
await u.app.close();

// Deleting a space: confirmed by typing its name.
await a.page.getByTitle('Create or join a space').click();
await a.page.getByText('Create my own').click();
await a.page.getByRole('dialog').getByRole('textbox').fill('Scratch');
await a.page.getByRole('button', { name: 'Create' }).click();
await a.page.getByText('This is the start of general').waitFor({ timeout: 15_000 });
await a.page.getByLabel('Space menu').click();
await a.page.getByText('Space settings').click();
await a.page.getByRole('button', { name: 'Delete space' }).click();
const deleteSpace = a.page.getByRole('dialog').getByRole('button', { name: 'Delete space' });
if (await deleteSpace.isEnabled()) throw new Error('deleting a space must wait for its typed name');
await a.page.getByRole('dialog').getByLabel('Type Scratch to confirm').fill('Scratch');
await shot(a.page, '22b-delete-space');
await deleteSpace.click();
await a.page
  .getByText('This is the start of general')
  .waitFor({ state: 'detached', timeout: 15_000 });

// Run server really starts the app's own coordination server (on the default
// port 7443). Done last: while it runs it joins the test network.
await a.page.getByLabel('Account').click();
await a.page.getByText('Settings', { exact: true }).click();
await a.page.getByRole('button', { name: 'Host a server' }).click();
await runServer.click();
// Running a server needs a way to reach whoever runs it.
const run = hostConfirm.getByRole('button', { name: 'Run server' });
if (await run.isEnabled()) throw new Error('Run server must wait for an operator contact');
await hostConfirm.getByLabel('Operator contact (required)').fill('ops@example.org');
await run.click();
await a.page.getByText(/Running at/).waitFor({ timeout: 20_000 });
await shot(a.page, '23-hosting');
await runServer.click();
await a.page.getByText(/^stopped$/i).waitFor({ timeout: 20_000 });

console.log('SMOKE OK');
await a.app.close();
await b.app.close();
await c.app.close();
await coordinator.stop();
await directory.stop();
process.exit(0);
