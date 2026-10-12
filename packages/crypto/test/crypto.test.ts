import { describe, expect, it } from 'vitest';
import {
  AnonBox,
  DELETED_PROFILE_NAME,
  NOTE_TTL_MS,
  recordKey,
  type SignedRecord,
  utf8,
} from '@crocodile/protocol';
import {
  AudioReceiver,
  AudioSender,
  PREKEY_LIFETIME_MS,
  SecureChannel,
  TextReceiver,
  acceptChannel,
  answerChannel,
  createChannelKeys,
  createPrekey,
  encryptText,
  exportChains,
  importChain,
  linkSecurityCode,
  openAnonymous,
  openForSelf,
  openLink,
  padmeLength,
  ratchet,
  rotatePrekeys,
  sealAnonymous,
  sealForSelf,
  sealLink,
  sealToDevice,
  userIdFromKey,
  createChatMessage,
  createIdentity,
  createSenderKey,
  decodeRecoveryKey,
  encodeRecoveryKey,
  identityFromSeed,
  isSpaceMember,
  openSealed,
  peekFrameKid,
  randomId,
  safetyNumber,
  signRecord,
  signSdp,
  signSpaceAuthority,
  spaceIdFor,
  validateRecord,
  verifyChatMessage,
  verifySdp,
  type ValidationContext,
} from '../src';

function ctx(records: SignedRecord[], fresh = true): ValidationContext {
  const map = new Map(records.map((r) => [r.key, r]));
  return { get: (k) => map.get(k), now: Date.now(), fresh };
}

describe('identity', () => {
  it('recovers the same identity from the recovery key', () => {
    const id = createIdentity();
    const key = encodeRecoveryKey(id.seed);
    expect(key).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
    const restored = identityFromSeed(decodeRecoveryKey(key.toLowerCase()));
    expect(restored.userId).toBe(id.userId);
    expect(restored.encPublicKey).toBe(id.encPublicKey);
  });

  it('rejects a mistyped recovery key', () => {
    const key = encodeRecoveryKey(createIdentity().seed);
    const typo = (key[0] === 'A' ? 'B' : 'A') + key.slice(1);
    expect(() => decodeRecoveryKey(typo)).toThrow(/checksum/);
  });

  it('safety numbers are symmetric', () => {
    const a = createIdentity();
    const b = createIdentity();
    expect(safetyNumber(a.publicKey, b.publicKey)).toBe(safetyNumber(b.publicKey, a.publicKey));
    expect(safetyNumber(a.publicKey, b.publicKey)).toMatch(/^(\d{5} ){11}\d{5}$/);
  });
});

describe('records', () => {
  const alice = createIdentity();
  const bob = createIdentity();
  const mallory = createIdentity();

  const profile = (who = alice) =>
    signRecord(who, 'profile', recordKey.profile(who.userId), {
      username: 'alice',
      encKey: who.encPublicKey,
    });

  it('accepts a self-signed profile and rejects forgeries', () => {
    expect(validateRecord(profile(), ctx([])).ok).toBe(true);
    const forged = signRecord(mallory, 'profile', recordKey.profile(alice.userId), {
      username: 'alice',
      encKey: mallory.encPublicKey,
    });
    expect(validateRecord(forged, ctx([]))).toMatchObject({ ok: false });
    const tampered = { ...profile(), body: { username: 'eve', encKey: alice.encPublicKey } };
    expect(validateRecord(tampered, ctx([]))).toMatchObject({ ok: false, reason: 'bad signature' });
  });

  it('enforces last-writer-wins versions', () => {
    const v1 = signRecord(
      alice,
      'profile',
      recordKey.profile(alice.userId),
      { username: 'a', encKey: alice.encPublicKey },
      Date.now() - 1000,
    );
    const v2 = signRecord(alice, 'profile', recordKey.profile(alice.userId), {
      username: 'b',
      encKey: alice.encPublicKey,
    });
    expect(validateRecord(v1, ctx([v2]))).toMatchObject({ ok: false, reason: 'stale version' });
    expect(validateRecord(v2, ctx([v1])).ok).toBe(true);
  });

  it('a deleted account is a bare marker and signs nothing more', () => {
    const deleted = (body: Record<string, unknown> = {}, version = Date.now()) =>
      signRecord(
        alice,
        'profile',
        recordKey.profile(alice.userId),
        { username: DELETED_PROFILE_NAME, encKey: alice.encPublicKey, deleted: true, ...body },
        version,
      );
    const before = signRecord(
      alice,
      'profile',
      recordKey.profile(alice.userId),
      { username: 'alice', encKey: alice.encPublicKey },
      Date.now() - 5000,
    );
    expect(validateRecord(deleted(), ctx([before])).ok).toBe(true);
    expect(validateRecord(deleted({ bio: 'still here' }), ctx([]))).toMatchObject({
      ok: false,
      reason: 'a deleted profile carries no details',
    });
    expect(validateRecord(deleted({ username: 'alice' }), ctx([]))).toMatchObject({ ok: false });

    const marker = deleted({}, Date.now() - 1000);
    // Not even a newer profile brings the account back...
    expect(validateRecord(profile(), ctx([marker]))).toMatchObject({
      ok: false,
      reason: 'account was deleted',
    });
    // ...and nothing else it signs is accepted.
    const friends = signRecord(alice, 'friends', recordKey.friends(alice.userId), {
      friends: [bob.userId],
      blocked: [],
    });
    expect(validateRecord(friends, ctx([marker]))).toMatchObject({
      ok: false,
      reason: 'account was deleted',
    });
    // Other people are unaffected.
    expect(validateRecord(profile(bob), ctx([marker])).ok).toBe(true);
  });

  it('binds spaces to their owner and gates membership on invites', () => {
    const nonce = randomId();
    const spaceId = spaceIdFor(alice.publicKey, nonce);
    const space = signRecord(alice, 'space', recordKey.space(spaceId), {
      name: 'Swamp',
      owner: alice.userId,
      nonce,
      admins: [],
      bans: [],
      channels: [{ id: randomId(), name: 'general', kind: 'text' }],
    });
    expect(validateRecord(space, ctx([])).ok).toBe(true);

    const hijack = signRecord(mallory, 'space', recordKey.space(spaceId), {
      ...space.body,
      owner: mallory.userId,
    });
    expect(validateRecord(hijack, ctx([space])).ok).toBe(false);

    const code = randomId(5);
    const invite = signRecord(alice, 'invite', recordKey.invite(code), {
      spaceId,
      code,
      expiresAt: null,
    });
    expect(validateRecord(invite, ctx([space])).ok).toBe(true);
    const fakeInvite = signRecord(mallory, 'invite', recordKey.invite(code), {
      spaceId,
      code,
      expiresAt: null,
    });
    expect(validateRecord(fakeInvite, ctx([space])).ok).toBe(false);

    const join = signRecord(bob, 'member', recordKey.member(spaceId, bob.userId), {
      spaceId,
      userId: bob.userId,
      inviteCode: code,
    });
    expect(validateRecord(join, ctx([space])).ok).toBe(false);
    expect(validateRecord(join, ctx([space, invite])).ok).toBe(true);
    const noInvite = signRecord(mallory, 'member', recordKey.member(spaceId, mallory.userId), {
      spaceId,
      userId: mallory.userId,
    });
    expect(validateRecord(noInvite, ctx([space, invite])).ok).toBe(false);

    const lookup = ctx([space, invite, join]);
    expect(isSpaceMember(lookup, spaceId, alice.userId)).toBe(true);
    expect(isSpaceMember(lookup, spaceId, bob.userId)).toBe(true);
    expect(isSpaceMember(lookup, spaceId, mallory.userId)).toBe(false);
  });

  describe('space admins', () => {
    const carol = createIdentity();
    const nonce = randomId();
    const spaceId = spaceIdFor(alice.publicKey, nonce);
    const key = recordKey.space(spaceId);
    const now = Date.now();
    const base = {
      name: 'Swamp',
      owner: alice.userId,
      nonce,
      bans: [] as string[],
      channels: [{ id: randomId(), name: 'general', kind: 'text' as const }],
    };
    /** Alice makes Bob an admin. */
    const withBob = signRecord(
      alice,
      'space',
      key,
      {
        ...base,
        admins: [bob.userId],
        authority: signSpaceAuthority(alice, spaceId, [bob.userId], now - 2000),
      },
      now - 2000,
    );

    it("lets an admin change the space, checked on its own, without the owner's record", () => {
      const renamed = signRecord(bob, 'space', key, { ...withBob.body, name: 'Pond' }, now - 1000);
      expect(validateRecord(renamed, ctx([withBob])).ok).toBe(true);
      // A server or client that never saw the owner's version can check it too.
      expect(validateRecord(renamed, ctx([])).ok).toBe(true);
      // Someone not on the owner's list can't, signature or not.
      const byMallory = signRecord(mallory, 'space', key, { ...withBob.body, name: 'Mine' });
      expect(validateRecord(byMallory, ctx([withBob]))).toMatchObject({ ok: false });
    });

    it('keeps the admin list, deletion and the owner out of admins’ hands', () => {
      const v = now - 1000;
      const promoted = signRecord(
        bob,
        'space',
        key,
        { ...withBob.body, admins: [bob.userId, mallory.userId] },
        v,
      );
      expect(validateRecord(promoted, ctx([withBob]))).toMatchObject({
        ok: false,
        reason: 'bad admin list signature',
      });
      const deleted = signRecord(bob, 'space', key, { ...withBob.body, deleted: true }, v);
      expect(validateRecord(deleted, ctx([withBob]))).toMatchObject({
        reason: 'only the owner may delete a space',
      });
      const banOwner = signRecord(bob, 'space', key, { ...withBob.body, bans: [alice.userId] }, v);
      expect(validateRecord(banOwner, ctx([withBob]))).toMatchObject({ ok: false });
      const banCarol = signRecord(bob, 'space', key, { ...withBob.body, bans: [carol.userId] }, v);
      expect(validateRecord(banCarol, ctx([withBob])).ok).toBe(true);
    });

    it('refuses an edit under an admin list the owner has replaced', () => {
      // Alice removes Bob; Bob still holds the old signed list.
      const without = signRecord(
        alice,
        'space',
        key,
        { ...base, admins: [], authority: signSpaceAuthority(alice, spaceId, [], now - 500) },
        now - 500,
      );
      const late = signRecord(bob, 'space', key, { ...withBob.body, name: 'Still mine' }, now);
      expect(validateRecord(late, ctx([without]))).toMatchObject({
        ok: false,
        reason: 'the admin list has changed',
      });
    });

    it("lets admins make invites, which stop working when they're no longer admins", () => {
      const code = randomId(5);
      const invite = signRecord(bob, 'invite', recordKey.invite(code), {
        spaceId,
        code,
        expiresAt: null,
      });
      expect(validateRecord(invite, ctx([withBob])).ok).toBe(true);
      const join = signRecord(carol, 'member', recordKey.member(spaceId, carol.userId), {
        spaceId,
        userId: carol.userId,
        inviteCode: code,
      });
      expect(validateRecord(join, { ...ctx([withBob, invite]), fresh: true }).ok).toBe(true);
      const without = signRecord(
        alice,
        'space',
        key,
        { ...base, admins: [], authority: signSpaceAuthority(alice, spaceId, [], now - 500) },
        now - 500,
      );
      expect(validateRecord(join, { ...ctx([without, invite]), fresh: true })).toMatchObject({
        ok: false,
        reason: 'invite was made by someone who is no longer an admin',
      });
      // Revoking it is the owner's (or a current admin's) to do, checked
      // with nothing but the space: no earlier invite needed.
      const revoke = (who: typeof bob) =>
        signRecord(who, 'invite', recordKey.invite(code), { ...invite.body, revoked: true });
      expect(validateRecord(revoke(bob), ctx([without]))).toMatchObject({ ok: false });
      expect(validateRecord(revoke(alice), ctx([without])).ok).toBe(true);
    });
  });
});

describe('hybrid post-quantum sealed boxes', () => {
  it('only the target device can open, sender is authenticated', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const eve = createIdentity();
    const bobPeer = `${bob.userId}.bobdevice1`;
    const pk = createPrekey();
    const box = sealToDevice(
      alice,
      'alicedev1',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode('hello bob'),
    );
    const lookup = (id: number) => (id === pk.id ? pk : undefined);
    const opened = openSealed({ peer: bobPeer }, lookup, box, userIdFromKey);
    expect(opened?.from).toBe(`${alice.userId}.alicedev1`);
    expect(utf8.decode(opened!.plaintext)).toBe('hello bob');
    // Wrong device, wrong prekey, forged sender, tampering: all rejected.
    expect(openSealed({ peer: `${bob.userId}.otherdev11` }, lookup, box, userIdFromKey)).toBeNull();
    expect(openSealed({ peer: bobPeer }, () => createPrekey(), box, userIdFromKey)).toBeNull();
    expect(
      openSealed({ peer: bobPeer }, lookup, { ...box, from: eve.publicKey }, userIdFromKey),
    ).toBeNull();
    expect(
      openSealed(
        { peer: bobPeer },
        lookup,
        { ...box, ct: box.ct.slice(0, -2) + 'AA' },
        userIdFromKey,
      ),
    ).toBeNull();
    // Length hiding: boxes are padded.
    const small = sealToDevice(
      alice,
      'alicedev1',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode('x'),
    );
    const medium = sealToDevice(
      alice,
      'alicedev1',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode('x'.repeat(40)),
    );
    expect(small.ct.length).toBe(medium.ct.length);
  });

  it('rotates prekeys and forgets expired secrets', () => {
    const t0 = 1_000_000_000_000;
    const first = rotatePrekeys([], t0);
    expect(first.keys).toHaveLength(1);
    expect(rotatePrekeys(first.keys, t0 + 1000).rotated).toBe(false);
    const later = rotatePrekeys(first.keys, t0 + PREKEY_LIFETIME_MS - 1000);
    expect(later.keys).toHaveLength(2);
    const much = rotatePrekeys(later.keys, t0 + PREKEY_LIFETIME_MS + 3 * 24 * 3600_000);
    expect(much.keys.map((k) => k.id)).not.toContain(first.keys[0]!.id);
  });

  it("keeps an offline device's prekey until the grace period after it comes back", () => {
    const t0 = 1_000_000_000_000;
    const first = rotatePrekeys([], t0);
    const id = first.keys[0]!.id;
    // Offline for 30 days: on return the old key is replaced but kept for mail.
    const back = rotatePrekeys(first.keys, t0 + 30 * 24 * 3600_000);
    expect(back.rotated).toBe(true);
    expect(back.keys.map((k) => k.id)).toContain(id);
    const soon = rotatePrekeys(back.keys, t0 + 31 * 24 * 3600_000);
    expect(soon.keys.map((k) => k.id)).toContain(id);
    const after = rotatePrekeys(back.keys, t0 + 33 * 24 * 3600_000);
    expect(after.keys.map((k) => k.id)).not.toContain(id);
  });

  it('links devices: only the new device opens, and the security codes agree', () => {
    const account = createIdentity();
    const temp = createIdentity();
    const box = sealLink(account, temp.encPublicKey, account.seed);
    expect(openLink(temp, box, account.userId)).toEqual(account.seed);
    expect(openLink(temp, box, createIdentity().userId)).toBeNull();
    expect(openLink(createIdentity(), box, account.userId)).toBeNull();
    const shown = linkSecurityCode(temp.publicKey, temp.encPublicKey, account.publicKey);
    expect(shown).toMatch(/^\d{3} \d{3}$/);
    // A different encryption key gives a different code (a swap shows).
    expect(
      linkSecurityCode(temp.publicKey, createIdentity().encPublicKey, account.publicKey),
    ).not.toBe(shown);
  });
});

describe('ratcheting sender keys', () => {
  it('text: per-message ratchet, out-of-order within a window, no going back', () => {
    const sk = createSenderKey();
    const exported = exportChains(sk);
    const rx = new TextReceiver(sk.kid, importChain(exported.text));
    const m0 = encryptText(sk, utf8.encode('zero'));
    const m1 = encryptText(sk, utf8.encode('one'));
    const m2 = encryptText(sk, utf8.encode('two'));
    expect(utf8.decode(rx.decrypt(m2.g, m2.ct)!)).toBe('two');
    expect(utf8.decode(rx.decrypt(m0.g, m0.ct)!)).toBe('zero');
    expect(rx.decrypt(m0.g, m0.ct)).toBeNull(); // replay
    expect(utf8.decode(rx.decrypt(m1.g, m1.ct)!)).toBe('one');
    // A member given the current chain cannot read earlier messages.
    const late = new TextReceiver(sk.kid, importChain(exportChains(sk).text));
    expect(late.decrypt(m1.g, m1.ct)).toBeNull();
    const m3 = encryptText(sk, utf8.encode('three'));
    expect(utf8.decode(late.decrypt(m3.g, m3.ct)!)).toBe('three');
    // Bogus far-future generations do not advance state.
    expect(rx.decrypt(m3.g + 5000, m3.ct)).toBeNull();
    expect(utf8.decode(rx.decrypt(m3.g, m3.ct)!)).toBe('three');
  });

  it('audio: frames across generations, tampering rejected', () => {
    const sk = createSenderKey();
    const sender = new AudioSender(sk.kid, sk.audio);
    const rx = new AudioReceiver(sk.kid, importChain(exportChains(sk).audio));
    const frame = Uint8Array.from({ length: 80 }, (_, i) => i);
    const f0 = sender.encrypt(frame);
    expect(peekFrameKid(f0)).toBe(sk.kid);
    expect(rx.decrypt(f0)).toEqual(frame);
    sender.update(ratchet(ratchet(sk.audio)));
    const f2 = sender.encrypt(frame);
    expect(rx.decrypt(f2)).toEqual(frame);
    expect(rx.gen).toBe(2);
    const bad = f2.slice();
    bad[3] = bad[3]! ^ 1;
    expect(rx.decrypt(bad)).toBeNull();
    const other = createSenderKey();
    expect(new AudioReceiver(other.kid, other.audio).decrypt(f2)).toBeNull();
  });

  it('audio: a sender rebuilt from the same key does not reuse its nonces', () => {
    const sk = createSenderKey();
    const counterOf = (f: Uint8Array) =>
      new DataView(f.buffer, f.byteOffset + f.length - 11, 11).getUint32(6);
    // Two senders from one key state, as after a reconnect: their frame
    // counters (and so their nonces) start apart.
    const first = Array.from({ length: 5 }, () =>
      counterOf(new AudioSender(sk.kid, sk.audio).encrypt(new Uint8Array(40))),
    );
    expect(new Set(first).size).toBe(5);
    const rx = new AudioReceiver(sk.kid, importChain(exportChains(sk).audio));
    expect(rx.decrypt(new AudioSender(sk.kid, sk.audio).encrypt(new Uint8Array(40)))).toEqual(
      new Uint8Array(40),
    );
  });
});

describe('secure channel', () => {
  it('hybrid handshake, encrypted frames, replay protection', () => {
    const keys = createChannelKeys();
    const { answer, secret } = answerChannel(keys.offer);
    const server = new SecureChannel(acceptChannel(keys, answer), 'ctx', false);
    const client = new SecureChannel(secret, 'ctx', true);
    const f1 = client.seal({ hello: 'world' });
    expect(server.open(f1)).toEqual({ hello: 'world' });
    expect(server.open(f1)).toBeUndefined();
    const back = server.seal({ ok: true });
    expect(client.open(back)).toEqual({ ok: true });
    expect(new SecureChannel(secret, 'other', false).open(client.seal({ x: 1 }))).toBeUndefined();
  });

  it('padme buckets', () => {
    expect(padmeLength(10)).toBe(64);
    expect(padmeLength(1000)).toBeGreaterThanOrEqual(1000);
    expect(padmeLength(1000)).toBeLessThan(1000 * 1.13);
  });
});

describe('messages and signalling', () => {
  it('verifies signed chat messages', () => {
    const alice = createIdentity();
    const msg = createChatMessage(alice, { ch: 'general', body: 'hi' });
    expect(verifyChatMessage(msg)).toBe(true);
    expect(verifyChatMessage({ ...msg, body: 'bye' })).toBe(false);
    expect(verifyChatMessage({ ...msg, author: createIdentity().userId })).toBe(false);
  });

  it('binds SDP to session and peers', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const from = `${alice.userId}.aaaadevice`;
    const to = `${bob.userId}.bbbbdevice`;
    const offer = signSdp(alice, 'offer', { sessionId: 's', epoch: 1, from, to }, 'v=0...');
    expect(verifySdp(offer, { sessionId: 's', from, to })).toBe(true);
    expect(verifySdp(offer, { sessionId: 'other', from, to })).toBe(false);
    expect(verifySdp(offer, { sessionId: 's', from: `${bob.userId}.aaaadevice`, to })).toBe(false);
    expect(verifySdp({ ...offer, sdp: 'v=0 evil' }, { sessionId: 's', from, to })).toBe(false);
  });
});

describe('anonymous boxes', () => {
  it('hide the sender from everyone but the target device, which can verify them', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const eve = createIdentity();
    const bobPeer = `${bob.userId}.bobdevicea`;
    const pk = createPrekey();
    const lookup = (id: number) => (id === pk.id ? pk : undefined);
    const box = sealAnonymous(
      alice,
      'alicedeva',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode('psst'),
    );
    expect(AnonBox.safeParse(box).success).toBe(true);
    // Nothing outside the encryption says who sent it.
    const outside = JSON.stringify(box);
    expect(outside).not.toContain(alice.publicKey);
    expect(outside).not.toContain(alice.userId);
    expect(outside).not.toContain('alicedeva');

    const opened = openAnonymous({ peer: bobPeer }, lookup, box, userIdFromKey);
    expect(opened?.from).toBe(`${alice.userId}.alicedeva`);
    expect(opened?.fromKey).toBe(alice.publicKey);
    expect(utf8.decode(opened!.plaintext)).toBe('psst');

    // Another device, another prekey, tampering: all rejected.
    expect(
      openAnonymous({ peer: `${bob.userId}.otherdevaa` }, lookup, box, userIdFromKey),
    ).toBeNull();
    expect(openAnonymous({ peer: bobPeer }, () => createPrekey(), box, userIdFromKey)).toBeNull();
    const flipped = box.ct.slice(0, 10) + (box.ct[10] === 'A' ? 'B' : 'A') + box.ct.slice(11);
    expect(
      openAnonymous({ peer: bobPeer }, lookup, { ...box, ct: flipped }, userIdFromKey),
    ).toBeNull();
    // Bob can't pass it on to Carol as if Alice had written to her: the
    // signature covers the device it was sealed to.
    const carolPeer = `${eve.userId}.caroldev`;
    const readdressed = { ...box, to: carolPeer };
    expect(openAnonymous({ peer: carolPeer }, lookup, readdressed, userIdFromKey)).toBeNull();
    // Padded: short payloads look alike.
    const longer = sealAnonymous(
      alice,
      'alicedeva',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode('psst, psst'),
    );
    expect(longer.ct.length).toBe(box.ct.length);
  });
});

describe('sealed for self', () => {
  it("opens only with the same account's key and for the same place", () => {
    const alice = createIdentity();
    const sealed = sealForSelf(alice, 'friends', utf8.encode('my list'), 'friends:x');
    expect(utf8.decode(openForSelf(alice, 'friends', sealed, 'friends:x')!)).toBe('my list');
    // Same account on another device: same seed, same key.
    const laptop = identityFromSeed(alice.seed);
    expect(utf8.decode(openForSelf(laptop, 'friends', sealed, 'friends:x')!)).toBe('my list');
    expect(openForSelf(createIdentity(), 'friends', sealed, 'friends:x')).toBeNull();
    expect(openForSelf(alice, 'other', sealed, 'friends:x')).toBeNull();
    expect(openForSelf(alice, 'friends', sealed, 'friends:y')).toBeNull();
    expect(openForSelf(alice, 'friends', 'not base64!', 'friends:x')).toBeNull();
    // Fresh nonce every time.
    expect(sealForSelf(alice, 'friends', utf8.encode('my list'), 'friends:x')).not.toBe(sealed);
  });
});

describe('notes', () => {
  const bob = createIdentity();
  const once = () => createIdentity();
  const boxForBob = () =>
    sealAnonymous(
      once(),
      'somedevice',
      { peer: `${bob.userId}.somedevice`, prekey: createPrekey().bundle },
      utf8.encode('x'),
    );
  const note = (author = once(), version = Date.now()) =>
    signRecord(
      author,
      'note',
      recordKey.note(bob.userId, author.userId),
      { boxes: [boxForBob()] },
      version,
    );

  it('are signed by a one-time key named in the key, and written once', () => {
    const n = note();
    expect(validateRecord(n, ctx([])).ok).toBe(true);
    const author = once();
    const misnamed = signRecord(author, 'note', recordKey.note(bob.userId, once().userId), {
      boxes: [],
    });
    expect(validateRecord(misnamed, ctx([]))).toMatchObject({ ok: false });
    const first = note(author, Date.now() - 1000);
    const again = signRecord(author, 'note', first.key, { boxes: [] });
    expect(validateRecord(again, ctx([first]))).toMatchObject({
      ok: false,
      reason: 'note already exists',
    });
    // Boxes for someone else's devices don't belong in Bob's notes.
    const pk = createPrekey();
    const stray = signRecord(author, 'note', recordKey.note(bob.userId, author.userId), {
      boxes: [
        sealAnonymous(
          once(),
          'somedevice',
          { peer: `${once().userId}.somedevice`, prekey: pk.bundle },
          utf8.encode('x'),
        ),
      ],
    });
    expect(validateRecord(stray, ctx([]))).toMatchObject({ ok: false });
    // An empty one would only take a place in Bob's quota.
    const empty = once();
    expect(
      validateRecord(
        signRecord(empty, 'note', recordKey.note(bob.userId, empty.userId), { boxes: [] }),
        ctx([]),
      ),
    ).toMatchObject({ ok: false, reason: 'a note carries at least one box' });
  });

  it('only the recipient deletes them, and nothing brings back an expired one', () => {
    const n = note();
    const del = (by: typeof bob) =>
      signRecord(by, 'note', n.key, { boxes: [], deleted: true }, n.version + 1);
    expect(validateRecord(del(bob), ctx([n])).ok).toBe(true);
    expect(validateRecord(del(once()), ctx([n]))).toMatchObject({ ok: false });
    const old = note(once(), Date.now() - NOTE_TTL_MS - 1000);
    expect(validateRecord(old, ctx([], false))).toMatchObject({
      ok: false,
      reason: 'note expired',
    });
  });
});
