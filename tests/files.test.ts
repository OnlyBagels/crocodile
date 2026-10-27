import { afterEach, describe, expect, it } from 'vitest';
import {
  CrocodileClient,
  MemoryFileBlockStore,
  MemoryKeyValueStore,
  MemoryMessageStore,
  FileTransfers,
  cleanFileName,
  type FileLinkFactory,
  type FileSource,
  type PlatformAdapter,
} from '@crocodile/client-core';
import type { Coordinator } from '@crocodile/coordinator';
import { newFileKey, sign } from '@crocodile/crypto';
import { SIG_DOMAIN, fileBlockCipherSize, sessionIds, type ChatMessage } from '@crocodile/protocol';
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

/** A block store that takes its time writing, like a slow disk. */
class SlowBlocks extends MemoryFileBlockStore {
  override async write(id: string, index: number, block: Uint8Array) {
    await new Promise((r) => setTimeout(r, 250));
    await super.write(id, index, block);
  }
}

type Stores = { files?: MemoryFileBlockStore; kv?: MemoryKeyValueStore };

/** Notes writes made after the app said it had closed. */
class WatchedKv extends MemoryKeyValueStore {
  closed = false;
  late: string[] = [];
  override async set<T>(key: string, value: T) {
    if (this.closed) this.late.push(key);
    await super.set(key, value);
  }
}

async function dmPair(
  net: FakeRelayNetwork,
  coord: Coordinator,
  stores: { alice?: Stores; bob?: Stores } = {},
) {
  const a = makeClient(net, coord, stores.alice);
  const b = makeClient(net, coord, stores.bob);
  const alice = await signUp(a.client, 'alice');
  const bob = await signUp(b.client, 'bob');
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
  return { alice, bob, dm, aliceFiles: a.files, bobFiles: b.files };
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
    const bobKv = new MemoryKeyValueStore();
    const { alice, bob, dm } = await dmPair(net, coord, { bob: { kv: bobKv } });

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
    // The hash list is kept once, apart from the record saved as blocks come
    // in (for a huge file it runs to megabytes).
    const list = await bobKv.get<string>(`file-hashes:${id}`);
    expect(list).toHaveLength(Math.ceil((3 * 32 * 4) / 3));
    expect(JSON.stringify(await bobKv.get(`file:${id}`))).not.toContain(list);
  });

  it("does not let another member post a file under the id of someone else's", async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord).client, 'alice');
    const mallory = await signUp(makeClient(net, coord).client, 'mallory');
    const bob = await signUp(makeClient(net, coord).client, 'bob');
    const { ch, sid } = await spaceOf(alice, [mallory, bob]);

    const data = content(300_000);
    const id = await alice.sendFile(ch, source('report.pdf', data, 'application/pdf'));
    const real = await waitFor(() => fileMessage(bob, ch), 8000, 'file message');
    expect(real.file!.id).toBe(id);

    // Mallory signs a message of her own that carries Alice's file id and a
    // key and name of her own.
    const unsigned = {
      id: real.id.slice(0, -1) + (real.id.endsWith('a') ? 'b' : 'a'),
      ch,
      sid,
      author: mallory.userId,
      key: mallory.identity!.publicKey,
      ts: real.ts,
      body: '',
      file: { ...real.file!, name: 'report.pdf', key: newFileKey() },
    };
    const squat: ChatMessage = {
      ...unsigned,
      sig: sign(mallory.identity!, SIG_DOMAIN.message, unsigned),
    };
    const accept = (
      bob as unknown as Record<string, (s: string, m: ChatMessage) => Promise<boolean>>
    ).acceptMessage!.bind(bob);
    // Sent the way a member's message really arrives, over the session.
    const mallorySession = (
      mallory as unknown as { sessions: Map<string, { sendGroup(p: unknown): boolean }> }
    ).sessions.get(sid)!;
    expect(mallorySession.sendGroup({ type: 'message', message: squat })).toBe(true);
    await alice.sendMessage(ch, 'after');
    await waitFor(() => bob.state.messages[ch]?.some((m) => m.body === 'after'), 8000, 'later');
    expect((bob.state.messages[ch] ?? []).filter((m) => m.file)).toHaveLength(1);
    expect(await accept(sid, squat)).toBe(false);

    // What Bob fetches is Alice's file.
    await bob.downloadFile(id);
    await waitFor(() => bob.state.files[id]?.status === 'done', 15000, 'downloaded');
    expect(same(await readAll(bob, id), data)).toBe(true);
  });

  it('leaves nothing behind when a file cannot be sent', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const { alice, dm, aliceFiles } = await dmPair(net, coord);
    // The file goes away while it is being encrypted.
    const vanishing: FileSource = {
      name: 'gone.bin',
      size: 3 * 1024 * 1024,
      type: 'application/octet-stream',
      read: async (o, l) => {
        if (o >= 1024 * 1024) throw new Error('the file went away');
        return new Uint8Array(l);
      },
    };
    await expect(alice.sendFile(dm, vanishing)).rejects.toThrow('the file went away');
    expect(await aliceFiles.usage()).toBe(0);
    // Or the step before posting fails.
    const fails = () => {
      throw new Error('no room');
    };
    await expect(
      alice.sendFile(dm, source('a.bin', content(2 * 1024 * 1024)), { prepared: fails }),
    ).rejects.toThrow('no room');
    expect(await aliceFiles.usage()).toBe(0);
    expect(alice.state.files).toEqual({});
  });

  it('deleting the message while it downloads leaves nothing behind', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const bobKv = new MemoryKeyValueStore();
    const bobFiles = new SlowBlocks();
    const { alice, bob, dm } = await dmPair(net, coord, { bob: { kv: bobKv, files: bobFiles } });
    const id = await alice.sendFile(dm, source('long.bin', content(4 * 1024 * 1024, 6)));
    await waitFor(() => bob.state.files[id], 8000, 'known');
    await bob.downloadFile(id);
    await waitFor(() => (bob.state.files[id]?.done ?? 0) > 0, 15000, 'first block in');

    await alice.deleteMessage(dm, fileMessage(alice, dm)!.id);
    await waitFor(() => !bob.state.files[id], 8000, 'bob dropped it');
    // A block on its way to the disk when the delete came doesn't bring it back.
    await new Promise((r) => setTimeout(r, 1000));
    expect(bob.state.files[id]).toBeUndefined();
    expect(await bobKv.get(`file:${id}`)).toBeUndefined();
    expect(await bobKv.get(`file-hashes:${id}`)).toBeUndefined();
    expect(await bobFiles.usage()).toBe(0);
  });

  it('tells the sender someone has the file only once they have all of it', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const { alice, bob, dm } = await dmPair(net, coord);
    const id = await alice.sendFile(dm, source('big.bin', content(3 * 1024 * 1024, 2)));
    const seen: { to: string; bobStatus?: string }[] = [];
    alice.on('fileServed', (e) => {
      if (e.fileId === id) seen.push({ to: e.to, bobStatus: bob.state.files[id]?.status });
    });
    await waitFor(() => bob.state.files[id], 8000, 'known');
    await bob.downloadFile(id);
    await waitFor(() => seen.length > 0, 15000, 'served');
    // Not when the last block left alice, but once bob had checked and kept it.
    expect(seen).toEqual([{ to: bob.userId, bobStatus: 'done' }]);
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
    // The connection drops once about a third has crossed.
    net.cutFileLinksAfter = { user: alice.userId, bytes: 3 * 1024 * 1024 };
    await bob.downloadFile(id);
    await waitFor(() => net.fileLinkLog.length === 2, 20000, 'reconnected');
    await waitFor(() => bob.state.files[id]?.status === 'done', 20000, 'finished');
    expect(same(await readAll(bob, id), data)).toBe(true);
    // The second connection carried what was missing, not the whole file again.
    const afterCut = net.fileBytesFrom.get(alice.userId)! - net.bytesAtCut;
    expect(afterCut).toBeLessThan(data.length - 0.5 * 1024 * 1024);
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

  it('fetches a picture by itself only from its author or a friend', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord).client, 'alice');
    const bob = await signUp(makeClient(net, coord).client, 'bob');
    const carol = await signUp(makeClient(net, coord).client, 'carol');
    await befriend(alice, bob);
    const { ch } = await spaceOf(alice, [bob, carol]);
    await carol.updateSettings({ autoDownload: 'everyone' });
    // No direct path between alice and bob; carol reaches both.
    net.unreachable.add(alice.userId);
    net.unreachable.add(bob.userId);

    const pic = await alice.sendFile(ch, source('lake.png', content(60_000, 8), 'image/png'));
    await waitFor(() => carol.state.files[pic]?.status === 'done', 15000, 'carol has it');
    // Carol has it too, but bob never chose to connect to her.
    await waitFor(
      () => ['no_direct', 'unavailable'].includes(bob.state.files[pic]?.status ?? ''),
      25000,
      'bob stopped',
    );
    expect(net.fileLinkLog.filter(([to]) => to === bob.userId)).toEqual([]);

    // Asked for, it comes from whoever has it.
    await bob.downloadFile(pic);
    await waitFor(() => bob.state.files[pic]?.status === 'done', 15000, 'bob fetched it');
    expect(net.fileLinkLog.at(-1)).toEqual([bob.userId, carol.userId]);
  });

  it('stops giving a file to someone removed from the space while they download it', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord).client, 'alice');
    const bob = await signUp(makeClient(net, coord).client, 'bob');
    const { spaceId, ch, sid } = await spaceOf(alice, [bob]);
    const id = await alice.sendFile(ch, source('plans.bin', content(6 * 1024 * 1024, 7)));
    await waitFor(() => bob.state.files[id], 8000, 'known');

    net.pauseFileLinksAfter = { user: alice.userId, bytes: 1024 * 1024 };
    await bob.downloadFile(id);
    await waitFor(() => net.fileLinksPaused, 15000, 'under way');
    await alice.banMember(spaceId, bob.userId);
    await waitFor(() => !alice.isAllowedPeer(sid, bob.peer), 5000, 'banned');
    const sentAtBan = net.fileBytesFrom.get(alice.userId)!;
    net.resumeFileLinks();
    await new Promise((r) => setTimeout(r, 1500));
    expect(bob.state.files[id]?.status).not.toBe('done');
    // At most the rest of the block that was on its way: one encrypted block
    // (1 MiB and its tag), when it had passed the check just before the ban.
    expect(net.fileBytesFrom.get(alice.userId)! - sentAtBan).toBeLessThanOrEqual(
      fileBlockCipherSize(6 * 1024 * 1024, 1),
    );
  });

  it('has written everything once it has shut down, a download in progress included', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const bobKv = new WatchedKv();
    const { alice, bob, dm } = await dmPair(net, coord, { bob: { kv: bobKv } });
    const id = await alice.sendFile(dm, source('half.bin', content(6 * 1024 * 1024, 11)));
    await waitFor(() => bob.state.files[id], 8000, 'known');
    net.pauseFileLinksAfter = { user: alice.userId, bytes: 2 * 1024 * 1024 };
    await bob.downloadFile(id);
    await waitFor(() => net.fileLinksPaused, 15000, 'under way');
    await waitFor(() => (bob.state.files[id]?.done ?? 0) > 0, 5000, 'some in');

    await bob.shutdown();
    bobKv.closed = true;
    // Saves on timers (the record cache's, the download's progress) came before.
    await new Promise((r) => setTimeout(r, 1500));
    net.resumeFileLinks();
    expect(bobKv.late).toEqual([]);
    const saved = await bobKv.get<{ have: string }>(`file:${id}`);
    expect(saved?.have).not.toMatch(/^A+$/);
  });

  it("gets going when someone's first key to the other side is lost", async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const kv = new MemoryKeyValueStore();
    const files = new MemoryFileBlockStore();
    const { alice, bob, dm } = await dmPair(net, coord, { bob: { kv, files } });
    const id = await alice.sendFile(dm, source('k.bin', content(100_000, 12)));
    await waitFor(() => bob.state.files[id], 8000, 'known');

    // Bob's app starts again; the key it sends first goes missing on the way
    // (sent while its side was still connecting, say).
    await bob.shutdown();
    net.dropDirectFrom = { user: bob.userId, count: 1 };
    const again = makeClient(net, coord, { kv, files }).client;
    await again.init();
    await again.openDm(alice.userId);
    await again.openChannel(dm);
    await waitFor(() => net.dropDirectFrom!.count === 0, 8000, 'key lost');
    // Asking for the file is encrypted with that key.
    await again.downloadFile(id);
    await waitFor(() => again.state.files[id]?.status === 'done', 15000, 'downloaded');
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
    // Still alice's: fetched back, it is shared as hers.
    expect(alice.state.files[id]).toMatchObject({ status: 'none', mine: true });
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

describe('uploads', () => {
  it('counts uploads per member, not per device', async () => {
    const sent: { to: string; kind?: string }[] = [];
    const session = {
      connected: true,
      peers: new Map(),
      sendGroup: () => true,
      sendSealedTo: async (to: string, p: { kind?: string }) => {
        sent.push({ to, kind: p.kind });
        return true;
      },
    };
    // Links that open and then stay busy.
    const links: FileLinkFactory = () => ({
      createOffer: async () => 'offer',
      acceptOffer: async () => 'answer',
      acceptAnswer: async () => {},
      ready: new Promise(() => {}),
      close() {},
    });
    const files = new FileTransfers({
      kv: new MemoryKeyValueStore(),
      blocks: new MemoryFileBlockStore(),
      links,
      peer: () => 'me.desk',
      iceServers: () => [],
      session: () => session as never,
      openSession: async () => {},
      isAllowedPeer: () => true,
      shareDownloads: () => true,
      changed: () => {},
      log: () => {},
    });
    const { manifest, hashes } = await files.prepare(source('a.bin', content(1000)));
    const sid = 'space:swamp';
    await files.posted(sid, { id: 'm1', ch: 'c1', author: 'me', file: manifest }, hashes);
    const offer = (from: string, link: string) =>
      files.onMessage(sid, from, {
        type: 'file_link',
        file: manifest.id,
        link,
        kind: 'offer',
        sdp: 'sdp',
      });
    offer('bob.phone', 'link000001');
    offer('bob.phone', 'link000002');
    // Bob's third, from another of his devices, waits; carol's doesn't.
    offer('bob.laptop', 'link000003');
    offer('carol.desk', 'link000004');
    await waitFor(() => sent.length === 4, 2000, 'answers');
    expect(sent.find((s) => s.to === 'bob.laptop')?.kind).toBe('reject');
    expect(sent.find((s) => s.to === 'carol.desk')?.kind).toBe('answer');
    expect(sent.filter((s) => s.to === 'bob.phone' && s.kind === 'answer')).toHaveLength(2);
    await files.close();
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
    expect(cleanFileName(' . a b . ')).toBe('a b');
  });

  it('fits names in 255 bytes, whole characters only, keeping the extension', () => {
    const bytes = (n: string) => new TextEncoder().encode(n).length;
    for (const name of ['ż'.repeat(300) + '.txt', '😀'.repeat(100) + '.png', 'a'.repeat(400)]) {
      const fit = cleanFileName(name);
      expect(bytes(fit)).toBeLessThanOrEqual(255);
      expect(bytes(fit)).toBeGreaterThan(240);
      // No half of a surrogate pair left at the cut.
      expect(new TextDecoder().decode(new TextEncoder().encode(fit))).toBe(fit);
      expect(fit.slice(-4)).toBe(name.slice(-4));
    }
    expect(cleanFileName('ż'.repeat(100) + '.txt')).toBe('ż'.repeat(100) + '.txt');
  });

  it('takes no longer on long runs of spaces than on any other name', () => {
    const name = `a${' '.repeat(100_000)}b`;
    const start = performance.now();
    expect(cleanFileName(name)).toHaveLength(255);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
