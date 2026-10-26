import { afterEach, describe, expect, it } from 'vitest';
import { createChannelKeys } from '@crocodile/crypto';
import { PROTOCOL_VERSION } from '@crocodile/protocol';
import { Coordinator } from '@crocodile/coordinator';
import { meshLinkTo, startCoordinator, waitFor } from './helpers';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(overrides = {}) {
  const c = await startCoordinator(overrides);
  cleanup.push(() => c.stop());
  return c;
}

/** `victim` is linked to an honest server and to a rogue one. */
async function threeServers() {
  const victim = await server({ name: 'victim' });
  const honest = await server({ name: 'honest', meshPeers: [victim.url] });
  const rogue = await server({ name: 'rogue', meshPeers: [victim.url] });
  await waitFor(
    () =>
      victim.mesh.peerIds().length === 2 &&
      rogue.mesh.peerIds().includes(victim.info.id) &&
      honest.mesh.peerIds().includes(victim.info.id),
    5000,
    'mesh links',
  );
  return { victim, honest, rogue };
}

const cursorOf = (c: Coordinator, serverId: string) =>
  Number(c.records.store.getMeta(`cursor:${serverId}`) ?? 0);

describe('a mesh link keeps the identity it authenticated with', () => {
  it('closes a link that sends a second hello and credits nothing to the identity in it', async () => {
    const { victim, honest, rogue } = await threeServers();
    const toVictim = meshLinkTo(rogue, victim.info.id);
    const offer = { x25519: 'a'.repeat(43), mlkem: 'b'.repeat(100) };

    toVictim.send({
      t: 'fed_hello',
      server: honest.info,
      challenge: 'c',
      channel: offer,
      protocol: 99,
    });
    // Would move the honest server's catch-up cursor if it were credited to it.
    toVictim.send({ t: 'records', items: [], upTo: 5_000_000 });

    await waitFor(
      () => !victim.mesh.peerIds().includes(rogue.info.id),
      3000,
      'the rogue link to be dropped',
    );
    expect(cursorOf(victim, honest.info.id)).toBe(0);
    // The honest server's own link is untouched.
    expect(victim.mesh.peerIds()).toContain(honest.info.id);
  });

  it('closes a link that introduces itself twice before it has authenticated', async () => {
    const victim = await server({ name: 'victim' });
    const honest = await server({ name: 'honest' });
    const ws = new WebSocket(victim.url.replace(/^http/, 'ws') + '/v1/federation');
    const received: string[] = [];
    ws.addEventListener('message', (e) => received.push(JSON.parse(String(e.data)).t));
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener('close', (e) => resolve(e.code)),
    );
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const hello = () =>
      JSON.stringify({
        t: 'fed_hello',
        server: honest.info,
        challenge: 'c',
        channel: createChannelKeys().offer,
        protocol: PROTOCOL_VERSION,
      });
    ws.send(hello());
    await waitFor(() => received.includes('fed_auth'), 3000, 'the answer to the first hello');
    ws.send(hello());
    expect(await closed).toBe(1008);
    expect(received.filter((t) => t === 'fed_auth')).toHaveLength(1);
  });
});
