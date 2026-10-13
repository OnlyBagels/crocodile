import { afterEach, describe, expect, it } from 'vitest';
import {
  CrocodileClient,
  MemoryFileBlockStore,
  MemoryKeyValueStore,
  MemoryMessageStore,
  cleanFileName,
  type FileSource,
  type PlatformAdapter,
} from '@crocodile/client-core';
import type { Coordinator } from '@crocodile/coordinator';
import { sessionIds } from '@crocodile/protocol';
import { FakeRelayNetwork } from './helpers/fake-relay';
import { startCoordinator, waitFor } from './helpers';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server() {
  const c = await startCoordinator();
  cleanup.push(() => c.stop());
  return c;
}

function makeClient(
  net: FakeRelayNetwork,
  coordinator: Coordinator,
  opts: { files?: MemoryFileBlockStore; kv?: MemoryKeyValueStore } = {},
) {
  const files = opts.files ?? new MemoryFileBlockStore();
  const platform: PlatformAdapter = {
    platform: 'desktop',
    appVersion: 'test',
    kv: opts.kv ?? new MemoryKeyValueStore(),
    messages: new MemoryMessageStore(),
    files,
    relay: net.adapter(),
    capabilities: async () => ({ nat: 'cone', cpuCores: 8 }),
  };
  const client = new CrocodileClient(platform, {
    directories: [],
    preferredServers: [coordinator.url],
    transportFactory: net.transportFactory(),
    fileLinks: net.fileLinkFactory(),
    log: process.env.DBG ? (m, e) => console.log('client', m, JSON.stringify(e)) : undefined,
  });
  cleanup.push(() => client.shutdown());
  return { client, files };
}

async function signUp(client: CrocodileClient, name: string) {
  await client.init();
  await client.createAccount(name);
  await waitFor(() => client.state.link === 'connected' && client.state.me, 5000, `${name} up`);
  return client;
}

async function befriend(a: CrocodileClient, b: CrocodileClient) {
  await a.addFriend(b.userId);
  await waitFor(() => b.state.friends.incoming.includes(a.userId), 5000, 'request');
  await b.addFriend(a.userId);
  await waitFor(() => a.state.friends.friends.includes(b.userId), 12000, 'friends');
}

/** Bytes that differ everywhere, so a misplaced block would show. */
function content(size: number, seed = 1) {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function source(name: string, data: Uint8Array, type = 'application/octet-stream'): FileSource {
  return {
    name,
    size: data.length,
    type,
    read: async (o, l) => data.slice(o, o + l),
  };
}

/** Whether two byte arrays are equal (toEqual is very slow on megabytes). */
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function readAll(c: CrocodileClient, id: string) {
  const parts: Uint8Array[] = [];
  await c.readFile(id, (p) => void parts.push(p));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const fileMessage = (c: CrocodileClient, ch: string) =>
  (c.state.messages[ch] ?? []).find((m) => m.file);

async function dmPair(net: FakeRelayNetwork, coord: Coordinator) {
  const alice = await signUp(makeClient(net, coord).client, 'alice');
  const bob = await signUp(makeClient(net, coord).client, 'bob');
  await befriend(alice, bob);
  const dm = await alice.openDm(bob.userId);
  await bob.openDm(alice.userId);
  await alice.openChannel(dm);
  await bob.openChannel(dm);
  await waitFor(
    () =>
      alice.state.sessions[dm]?.peers.includes(bob.userId) &&
      bob.state.sessions[dm]?.peers.includes(alice.userId),
    8000,
    'dm connected',
  );
  return { alice, bob, dm };
}

async function spaceOf(owner: CrocodileClient, others: CrocodileClient[]) {
  const spaceId = await owner.createSpace('Swamp');
  const code = await owner.createInvite(spaceId);
  for (const o of others) await o.joinWithInvite(`croc://join/${code}`);
  await waitFor(
    () => others.every((o) => owner.state.spaces[spaceId]?.members.includes(o.userId)),
    5000,
    'members',
  );
  const ch = owner.state.spaces[spaceId]!.channels.find((c) => c.kind === 'text')!.id;
  for (const c of [owner, ...others]) await c.openChannel(ch);
  const sid = sessionIds.space(spaceId);
  await waitFor(
    () =>
      [owner, ...others].every((c) => (c.state.sessions[sid]?.peers.length ?? 0) >= others.length),
    8000,
    'space connected',
  );
  return { spaceId, ch, sid };
}

describe('files', () => {
  it('sends a file in a DM: the friend fetches it straight from the sender', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const { alice, bob, dm } = await dmPair(net, coord);

    // Several blocks, the last one short.
    const data = content(2.5 * 1024 * 1024);
    const id = await alice.sendFile(dm, source('notes.pdf', data, 'application/pdf'), {
      caption: 'the notes',
    });
    expect(alice.state.files[id]).toMatchObject({ status: 'done', mine: true });

    const msg = await waitFor(() => fileMessage(bob, dm), 8000, 'file message');
    expect(msg.body).toBe('the notes');
    expect(msg.file).toMatchObject({ id, name: 'notes.pdf', size: data.length });
    // A PDF isn't fetched by itself.
    await new Promise((r) => setTimeout(r, 200));
    expect(bob.state.files[id]?.status).toBe('none');

    await bob.downloadFile(id);
    await waitFor(() => bob.state.files[id]?.status === 'done', 15000, 'downloaded');
    expect(same(await readAll(bob, id), data)).toBe(true);
    expect(net.fileLinkLog).toEqual([[bob.userId, alice.userId]]);
  });

  it('carries an empty file and a one-byte file', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const { alice, bob, dm } = await dmPair(net, coord);
    for (const data of [new Uint8Array(0), Uint8Array.of(7)]) {
      const id = await alice.sendFile(dm, source(`f${data.length}`, data));
      await waitFor(() => bob.state.files[id], 8000, 'known');
      await bob.downloadFile(id);
      await waitFor(() => bob.state.files[id]?.status === 'done', 10000, 'downloaded');
      expect(same(await readAll(bob, id), data)).toBe(true);
    }
  });

  it('a member who downloaded a file gives it to others once the sender is gone', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord).client, 'alice');
    const bob = await signUp(makeClient(net, coord).client, 'bob');
    const carol = await signUp(makeClient(net, coord).client, 'carol');
    const { ch } = await spaceOf(alice, [bob, carol]);

    const data = content(1.5 * 1024 * 1024, 3);
    const id = await alice.sendFile(ch, source('map.zip', data, 'application/zip'));
    await waitFor(() => bob.state.files[id], 8000, 'bob knows');
    await bob.downloadFile(id);
    await waitFor(() => bob.state.files[id]?.status === 'done', 15000, 'bob has it');

    await alice.shutdown();
    await waitFor(() => carol.state.files[id], 8000, 'carol knows');
    await carol.downloadFile(id);
    await waitFor(() => carol.state.files[id]?.status === 'done', 20000, 'carol has it');
    expect(same(await readAll(carol, id), data)).toBe(true);
    expect(net.fileLinkLog.at(-1)).toEqual([carol.userId, bob.userId]);
  });

  it('resumes a dropped download without fetching the same blocks again', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const { alice, bob, dm } = await dmPair(net, coord);
    const data = content(6 * 1024 * 1024, 5);
    const id = await alice.sendFile(dm, source('video.bin', data));
    await waitFor(() => bob.state.files[id], 8000, 'known');
    await bob.downloadFile(id);
    await waitFor(() => (bob.state.files[id]?.done ?? 0) >= 2 * 1024 * 1024, 15000, 'partway');
    net.cutFileLinksOf(alice.userId);
    await waitFor(() => bob.state.files[id]?.status !== 'downloading', 5000, 'dropped');
    // Asking again picks up where it stopped.
    await bob.downloadFile(id);
    await waitFor(() => bob.state.files[id]?.status === 'done', 20000, 'finished');
    expect(same(await readAll(bob, id), data)).toBe(true);
    // Each block crossed once, give or take the ones in flight at the cut.
    expect(net.fileBytesFrom.get(alice.userId)!).toBeLessThan(data.length + 2.5 * 1024 * 1024);
    expect(net.fileLinkLog.length).toBe(2);
  });

  it('never sends a file through the server relay: with no direct path it says so', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const { alice, bob, dm } = await dmPair(net, coord);
    const id = await alice.sendFile(dm, source('a.txt', content(1000)));
    await waitFor(() => bob.state.files[id], 8000, 'known');
    // Both behind symmetric NATs: their chat still gets through the host
    // relay, but no direct connection between them can form.
    net.unreachable.add(alice.userId);
    net.unreachable.add(bob.userId);
    await bob.downloadFile(id);
    await waitFor(() => bob.state.files[id]?.status === 'no_direct', 15000, 'no direct');
    expect(net.fileLinkLog).toEqual([]);
  });

  it('waits for someone who has the file and continues when they come online', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const kv = new MemoryKeyValueStore();
    const store = new MemoryFileBlockStore();
    const alice = await signUp(makeClient(net, coord, { kv, files: store }).client, 'alice');
    const bob = await signUp(makeClient(net, coord).client, 'bob');
    const { ch } = await spaceOf(alice, [bob]);
    const data = content(300_000, 9);
    const id = await alice.sendFile(ch, source('later.bin', data));
    await waitFor(() => bob.state.files[id], 8000, 'known');

    // The only one who has it goes offline before bob asks.
    await alice.shutdown();
    await bob.downloadFile(id);
    await waitFor(() => bob.state.files[id]?.status === 'unavailable', 15000, 'waiting');

    // Alice's app starts again (same device): bob's download carries on by itself.
    const again = makeClient(net, coord, { kv, files: store }).client;
    await again.init();
    await waitFor(() => bob.state.files[id]?.status === 'done', 25000, 'fetched');
    expect(same(await readAll(bob, id), data)).toBe(true);
  });

  it('fetches pictures from friends by itself, not from strangers unless allowed', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord).client, 'alice');
    const bob = await signUp(makeClient(net, coord).client, 'bob');
    const carol = await signUp(makeClient(net, coord).client, 'carol');
    await befriend(alice, bob);
    const { ch } = await spaceOf(alice, [bob, carol]);

    const pic = await alice.sendFile(ch, source('cat.png', content(50_000), 'image/png'), {
      preview: { thumb: 'data:image/webp;base64,UklGRg==', w: 640, h: 480 },
    });
    // Bob is alice's friend: it arrives by itself. Carol isn't.
    await waitFor(() => bob.state.files[pic]?.status === 'done', 15000, 'bob auto');
    await waitFor(() => carol.state.files[pic], 8000, 'carol knows');
    await new Promise((r) => setTimeout(r, 500));
    expect(carol.state.files[pic]!.status).toBe('none');
    expect(fileMessage(carol, ch)!.file).toMatchObject({ w: 640, h: 480 });

    // Too big to fetch by itself, even from a friend.
    const big = await alice.sendFile(ch, source('big.png', content(11 * 1024 * 1024), 'image/png'));
    await waitFor(() => bob.state.files[big], 8000, 'bob knows big');
    await new Promise((r) => setTimeout(r, 500));
    expect(bob.state.files[big]!.status).toBe('none');

    // Carol allows everyone: the next picture comes by itself.
    await carol.updateSettings({ autoDownload: 'everyone' });
    const pic2 = await alice.sendFile(ch, source('dog.webp', content(20_000), 'image/webp'));
    await waitFor(() => carol.state.files[pic2]?.status === 'done', 15000, 'carol auto');
  });

  it('deleting the message deletes the file and nobody can fetch it any more', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord).client, 'alice');
    const bob = makeClient(net, coord);
    await signUp(bob.client, 'bob');
    const carol = await signUp(makeClient(net, coord).client, 'carol');
    const { ch } = await spaceOf(alice, [bob.client, carol]);
    const id = await alice.sendFile(ch, source('oops.txt', content(5000)));
    await waitFor(() => bob.client.state.files[id], 8000, 'bob knows');
    await bob.client.downloadFile(id);
    await waitFor(() => bob.client.state.files[id]?.status === 'done', 15000, 'bob has it');

    const msgId = fileMessage(alice, ch)!.id;
    await alice.deleteMessage(ch, msgId);
    await waitFor(() => !bob.client.state.files[id], 8000, 'bob dropped it');
    expect(await bob.files.read(id, 0, 5016)).toBeNull();
    expect(fileMessage(bob.client, ch)).toBeUndefined();
    expect(alice.state.files[id]).toBeUndefined();
  });

  it('a holder whose copy is damaged stops giving it out', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const aliceC = makeClient(net, coord);
    const alice = await signUp(aliceC.client, 'alice');
    const bob = await signUp(makeClient(net, coord).client, 'bob');
    const { ch } = await spaceOf(alice, [bob]);
    const data = content(100_000, 4);
    const id = await alice.sendFile(ch, source('x.bin', data));
    // Corrupt alice's stored block.
    const block = (await aliceC.files.read(id, 0, data.length + 16))!;
    block[10]! ^= 1;
    await aliceC.files.write(id, 0, block);
    await waitFor(() => bob.state.files[id], 8000, 'known');
    await bob.downloadFile(id);
    await waitFor(
      () => ['unavailable', 'no_direct', 'failed'].includes(bob.state.files[id]?.status ?? ''),
      20000,
      'gave up',
    );
    expect(alice.state.files[id]?.status).toBe('none');
  });
});

describe('who may fetch', () => {
  it('a file is only given out in the space or DM it was posted in', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord).client, 'alice');
    const bob = await signUp(makeClient(net, coord).client, 'bob');
    const carol = await signUp(makeClient(net, coord).client, 'carol');
    // Alice and bob share space A; alice and carol share space B.
    const a = await spaceOf(alice, [bob]);
    const b = await spaceOf(alice, [carol]);
    const id = await alice.sendFile(a.ch, source('secret.txt', content(1000)));

    // Carol learned the id somehow and asks through the space she shares with alice.
    type Inner = {
      sessions: Map<
        string,
        {
          sendGroup(p: unknown): boolean;
          sendSealedTo(to: string, p: unknown): Promise<boolean>;
          on(
            ev: 'file',
            fn: (e: { from: string; payload: { type: string; kind?: string } }) => void,
          ): void;
        }
      >;
    };
    const carolSession = (carol as unknown as Inner).sessions.get(b.sid)!;
    const heard: string[] = [];
    carolSession.on('file', (e) => heard.push(e.payload.kind ?? e.payload.type));
    carolSession.sendGroup({ type: 'file_want', file: id });
    await carolSession.sendSealedTo(alice.peer, {
      type: 'file_link',
      file: id,
      link: 'abcdefgh12',
      kind: 'offer',
      sdp: 'offer-forged',
    });
    await waitFor(() => heard.includes('reject'), 5000, 'rejected');
    expect(heard).not.toContain('file_have');
    expect(heard).not.toContain('answer');
    expect(net.fileLinkLog).toEqual([]);
  });
});

describe('file names', () => {
  it('keeps names harmless to show and save', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\me\\a.txt')).toBe('a.txt');
    expect(cleanFileName('.bashrc')).toBe('bashrc');
    expect(cleanFileName('evil\u202Egnp.exe')).toBe('evil_gnp.exe');
    expect(cleanFileName('a<b>:c|d?.txt')).toBe('a_b__c_d_.txt');
    expect(cleanFileName('   ')).toBe('file');
  });
});
