import type { ConnectionRoute, NetworkVerdict } from '@crocodile/client-core';

/** What a network check found, in words. */
export const NETWORK_TEXT: Record<NetworkVerdict, { title: string; detail: string }> = {
  good: {
    title: 'Direct connections work',
    detail:
      'Your network lets Crocodile connect straight to other people, so calls and chats go peer-to-peer.',
  },
  limited: {
    title: 'Direct connections are limited',
    detail:
      'Your router gives every destination a different port (common on mobile hotspots and some office, school and carrier networks). Direct connections still work with most people, but not with someone whose network is limited too. With the relay on, those connections go through a coordination server instead, still end-to-end encrypted.',
  },
  blocked: {
    title: 'Direct connections are blocked',
    detail:
      "Your network blocks the traffic calls and chats need, so you can't connect to anyone directly. Turn on the relay to connect through a coordination server; your voice and messages stay end-to-end encrypted.",
  },
  unknown: {
    title: "Your network couldn't be fully tested",
    detail: "If you can't reach someone, Crocodile will tell you and offer the relay.",
  },
};

/** How a live connection travels, as a short label. */
export const ROUTE_TEXT: Record<ConnectionRoute, string> = {
  local: 'on this device',
  lan: 'same network',
  internet: 'direct',
  relay: 'relayed',
};
