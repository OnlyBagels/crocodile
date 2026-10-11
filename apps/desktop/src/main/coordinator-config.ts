import { isOperatorContact } from '@crocodile/protocol';
import type { CoordinatorSettings } from './ipc-types';

/**
 * Why the app's own server can't start with these settings, or undefined if
 * it can. Settings saved by older versions may be enabled without a contact.
 */
export function coordinatorStartError(s: CoordinatorSettings): string | undefined {
  // People using a server must be able to reach whoever runs it.
  if (!s.contact) return 'Add an operator contact below to run your server.';
  if (!isOperatorContact(s.contact))
    return 'The operator contact must be an email address or a page starting with https://.';
  // The relay's ports sit just above the server's own two.
  if (s.relay && relayPorts(s).max > 65535) {
    const highest = 65535 - 1 - relayCapacity(s) * 4;
    return `With the relay on, the port must be ${highest} or lower (its ports come right after it).`;
  }
  return undefined;
}

/** Relay capacity as the server applies it: 1 to 100 people. */
export function relayCapacity(s: CoordinatorSettings): number {
  return Math.max(1, Math.min(100, s.relayMaxUsers || 10));
}

/**
 * UDP ports for relayed traffic, one per relayed connection: a fixed range
 * just above the server's own two ports, so it can be forwarded on a router
 * (a port chosen at random for each connection can't be).
 */
export function relayPorts(s: CoordinatorSettings): { min: number; max: number } {
  const min = s.port + 2;
  // Four per person covers typical use (a chat, a DM and a call). Someone
  // holding more takes over their own oldest port when the range is full
  // (TurnServer). Past port 65535 the settings are refused (coordinatorStartError).
  return { min, max: min + relayCapacity(s) * 4 - 1 };
}
