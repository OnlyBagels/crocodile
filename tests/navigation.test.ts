import { describe, expect, it } from 'vitest';
import { isAllowedNavigation } from '../apps/desktop/src/main/navigation';

describe('main-window navigation guard', () => {
  const app = 'file:///C:/app/resources/renderer/index.html';
  const dev = 'http://localhost:5173';

  it('allows the app entry and its own hash and query routes', () => {
    expect(isAllowedNavigation(app, app)).toBe(true);
    expect(isAllowedNavigation(`${app}#/settings`, app)).toBe(true);
    expect(isAllowedNavigation(`${app}?reload=1`, app)).toBe(true);
  });

  it('blocks a dropped file and other file URLs (the seed-read vector)', () => {
    expect(isAllowedNavigation('file:///C:/Users/me/Downloads/evil.html', app)).toBe(false);
    expect(isAllowedNavigation('file:///etc/passwd', app)).toBe(false);
    // A sibling whose path merely starts with the entry path must not pass.
    expect(isAllowedNavigation(`${app}.evil`, app)).toBe(false);
  });

  it('blocks remote navigation in production', () => {
    expect(isAllowedNavigation('https://evil.example/', app)).toBe(false);
    expect(isAllowedNavigation(dev, app)).toBe(false);
  });

  it('trusts the dev server (and its sub-paths) only when configured', () => {
    expect(isAllowedNavigation(dev, app, dev)).toBe(true);
    expect(isAllowedNavigation(`${dev}/#/x`, app, dev)).toBe(true);
    expect(isAllowedNavigation('http://localhost:9999', app, dev)).toBe(false);
    // Only the same origin: a host that merely starts with the dev server's address is another.
    expect(isAllowedNavigation('http://localhost:5173.example.test/', app, dev)).toBe(false);
    expect(isAllowedNavigation('http://localhost:5173@evil.example/', app, dev)).toBe(false);
    expect(isAllowedNavigation('https://localhost:5173/', app, dev)).toBe(false);
    expect(isAllowedNavigation('not a url', app, dev)).toBe(false);
  });
});
