import { useEffect, useState } from 'react';
import { Check, Copy, Hash, Volume2 } from 'lucide-react';
import type { ChannelKind } from '@crocodile/protocol';
import { closeModal, getClient, navigate, openModal, useCroc } from '../croc';
import { copyText, imageToDataUrl, initials } from '../lib/format';
import {
  Avatar,
  Button,
  Input,
  Label,
  Modal,
  Segmented,
  Toggle,
  UserName,
  cx,
} from '../components/ui';

export function AddSpaceModal() {
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose');
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>();
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = useCroc((s) => s.me?.username);
  const client = getClient();

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      const spaceId = await fn();
      closeModal();
      const space = client.state.spaces[spaceId];
      navigate({
        kind: 'space',
        spaceId,
        channelId: space?.channels.find((c) => c.kind === 'text')?.id ?? null,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'choose') {
    return (
      <Modal
        title="Add a space"
        subtitle="A space is where you and your friends hang out: text channels, voice channels, all peer-to-peer."
        onClose={closeModal}
      >
        <button
          onClick={() => {
            setName(`${me ?? 'My'}'s space`);
            setMode('create');
          }}
          className="mb-3 w-full rounded-2xl border border-line bg-island-2 px-4 py-4 transition hover:border-accent text-left font-semibold text-text hover:bg-hover"
        >
          Create my own
        </button>
        <div className="mt-4 text-center">
          <h3 className="font-semibold text-text">Have an invite already?</h3>
          <Button variant="secondary" className="mt-2 w-full" onClick={() => setMode('join')}>
            Join a space
          </Button>
        </div>
      </Modal>
    );
  }

  if (mode === 'create') {
    return (
      <Modal
        title="Customize your space"
        subtitle="Give it a personality with a name and an icon. You can change them later."
        onClose={closeModal}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMode('choose')}>
              Back
            </Button>
            <Button
              disabled={!name.trim() || busy}
              onClick={() => void run(() => client.createSpace(name, icon))}
            >
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </>
        }
      >
        <label className="mx-auto mb-5 flex h-20 w-20 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-muted text-xl font-bold text-muted hover:border-text">
          {icon ? (
            <img src={icon} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(name || '?')
          )}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) =>
              e.target.files?.[0] && setIcon(await imageToDataUrl(e.target.files[0]))
            }
          />
        </label>
        <Label>Space name</Label>
        <Input autoFocus maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </Modal>
    );
  }

  return (
    <Modal
      title="Join a space"
      subtitle="Enter an invite code or link."
      onClose={closeModal}
      footer={
        <>
          <Button variant="ghost" onClick={() => setMode('choose')}>
            Back
          </Button>
          <Button
            disabled={!invite.trim() || busy}
            onClick={() => void run(() => client.joinWithInvite(invite))}
          >
            {busy ? 'Joining…' : 'Join space'}
          </Button>
        </>
      }
    >
      <Label>Invite code or link</Label>
      <Input
        autoFocus
        value={invite}
        onChange={(e) => setInvite(e.target.value)}
        placeholder="croc://join/abcd2345"
      />
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </Modal>
  );
}

const DAY_MS = 86_400_000;
type InviteLifetime = '1d' | '7d' | 'never';
const INVITE_LIFETIMES: Record<InviteLifetime, number | null> = {
  '1d': DAY_MS,
  '7d': 7 * DAY_MS,
  never: null,
};

export function InviteModal({ spaceId }: { spaceId: string }) {
  const space = useCroc((s) => s.spaces[spaceId]);
  const [lifetime, setLifetime] = useState<InviteLifetime>('7d');
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    let current = true;
    setCode(null);
    setCopied(false);
    setError(null);
    getClient()
      .shareInvite(spaceId, INVITE_LIFETIMES[lifetime])
      .then(
        (c) => current && setCode(c),
        (e: Error) => current && setError(e.message),
      );
    return () => {
      current = false;
    };
  }, [spaceId, lifetime]);
  // Stop other links to the space; keepThis keeps the one on screen, else make a fresh one.
  const clear = async (keepThis: boolean) => {
    if (!code) return;
    setResetting(true);
    setError(null);
    try {
      await getClient().clearInviteLinks(spaceId, keepThis ? [code] : []);
      if (!keepThis) setCode(await getClient().shareInvite(spaceId, INVITE_LIFETIMES[lifetime]));
      setCopied(false);
      setConfirmReset(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResetting(false);
    }
  };
  const link = code ? `croc://join/${code}` : '';
  // While the link loads, describe the lifetime that was picked.
  const expiresAt = code
    ? (getClient().records.get(`invite:${code}`)?.body as { expiresAt?: number | null } | undefined)
        ?.expiresAt
    : INVITE_LIFETIMES[lifetime] === null
      ? null
      : undefined;
  const days = expiresAt
    ? Math.max(1, Math.round((expiresAt - Date.now()) / DAY_MS))
    : (INVITE_LIFETIMES[lifetime] ?? 7 * DAY_MS) / DAY_MS;
  return (
    <Modal
      title={`Invite friends to ${space?.name ?? 'this space'}`}
      subtitle={
        expiresAt === null
          ? 'Anyone with this link can join, until you reset it.'
          : `Anyone with this link can join for the next ${days === 1 ? 'day' : `${days} days`}.`
      }
      onClose={closeModal}
    >
      <Label>Invite link</Label>
      <div className="flex items-center gap-2 rounded-xl bg-field p-1 pl-3">
        <span className="selectable flex-1 truncate font-mono text-sm">
          {error ?? (link || 'Creating invite…')}
        </span>
        <Button
          disabled={!code}
          className={cx(copied && 'bg-online')}
          onClick={async () => {
            await copyText(link);
            setCopied(true);
          }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Friends can also paste just the code: <b className="selectable text-text">{code}</b>
      </p>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Label>Expire after</Label>
          <Segmented
            label="Expire after"
            value={lifetime}
            options={[
              { id: '1d', label: '1 day' },
              { id: '7d', label: '7 days' },
              { id: 'never', label: 'Never' },
            ]}
            onChange={(v) => {
              setConfirmReset(false);
              setLifetime(v);
            }}
          />
        </div>
        <Button variant="ghost" disabled={!code || resetting} onClick={() => setConfirmReset(true)}>
          Reset links…
        </Button>
      </div>
      {confirmReset && (
        <div className="mt-4 rounded-2xl border border-line bg-island-2 p-4">
          <p className="text-sm text-text">
            Stop other links to this space: anyone who hasn&apos;t joined yet will need a new one.
            People already in the space stay. Keep this link to leave the one above working.
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={resetting} onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={resetting} onClick={() => void clear(false)}>
              Reset all
            </Button>
            <Button disabled={resetting || !code} onClick={() => void clear(true)}>
              {resetting ? 'Resetting…' : 'Keep this link'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function CreateChannelModal({ spaceId }: { spaceId: string }) {
  const [kind, setKind] = useState<ChannelKind>('text');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const client = getClient();
  const create = async () => {
    setBusy(true);
    try {
      await client.addChannel(spaceId, name, kind);
      closeModal();
    } catch (e) {
      client.reportError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create channel"
      onClose={closeModal}
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || busy} onClick={() => void create()}>
            Create channel
          </Button>
        </>
      }
    >
      <Label>Channel type</Label>
      {(['text', 'voice'] as ChannelKind[]).map((k) => (
        <button
          key={k}
          onClick={() => setKind(k)}
          className={cx(
            'mb-2 flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition',
            kind === k ? 'border-accent bg-accent-soft' : 'border-line bg-island-2 hover:bg-hover',
          )}
        >
          {k === 'text' ? <Hash size={22} /> : <Volume2 size={22} />}
          <div>
            <div className="font-medium text-text">{k === 'text' ? 'Text' : 'Voice'}</div>
            <div className="text-xs text-muted">
              {k === 'text' ? 'Messages, emoji and opinions' : 'Hang out together with voice'}
            </div>
          </div>
          <span
            className={cx(
              'ml-auto h-5 w-5 rounded-full border-2',
              kind === k ? 'border-accent bg-accent' : 'border-muted',
            )}
          />
        </button>
      ))}
      <div className="mt-3">
        <Label>Channel name</Label>
        <Input
          autoFocus
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()}
          placeholder={kind === 'text' ? 'new-channel' : 'Lounge'}
        />
      </div>
    </Modal>
  );
}

export function SpaceSettingsModal({ spaceId }: { spaceId: string }) {
  const space = useCroc((s) => s.spaces[spaceId]);
  const me = useCroc((s) => s.me?.userId);
  const [name, setName] = useState(space?.name ?? '');
  const [icon, setIcon] = useState(space?.icon);
  const client = getClient();
  if (!space) return null;
  const isOwner = space.owner === me;
  // Members, and admins who are no longer members (so their rights can still be taken back).
  const people = [...new Set([...space.members, ...space.admins])].filter((u) => u !== space.owner);
  const save = async () => {
    await client.updateSpace(spaceId, (b) => ({
      ...b,
      name: name.trim() || b.name,
      ...(icon ? { icon } : {}),
    }));
    closeModal();
  };
  return (
    <Modal
      title="Space settings"
      onClose={closeModal}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={() => void save().catch((e) => client.reportError(e.message))}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex gap-6">
        <label className="flex h-24 w-24 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-[28px] bg-active text-2xl font-bold text-text">
          {icon ? <img src={icon} alt="" className="h-full w-full object-cover" /> : initials(name)}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) =>
              e.target.files?.[0] && setIcon(await imageToDataUrl(e.target.files[0]))
            }
          />
        </label>
        <div className="flex-1">
          <Label>Space name</Label>
          <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="mt-6">
        <Label>Channels</Label>
        {space.channels.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-hover">
            {c.kind === 'text' ? (
              <Hash size={16} className="text-faint" />
            ) : (
              <Volume2 size={16} className="text-faint" />
            )}
            <span className="flex-1">{c.name}</span>
            <button
              className="text-xs text-danger hover:underline"
              onClick={() =>
                void client.removeChannel(spaceId, c.id).catch((e) => client.reportError(e.message))
              }
            >
              Delete
            </button>
          </div>
        ))}
      </div>
      <section aria-label="People" className="mt-6">
        <Label>People</Label>
        <p className="mb-2 text-xs text-muted">
          {isOwner
            ? 'Admins can rename the space, change its icon and channels, invite people and ban members. Only you choose admins or delete the space.'
            : "You're an admin: you can change this space, invite people and ban members. The owner chooses admins and can delete the space."}
        </p>
        {people.length === 0 && (
          <p className="rounded-xl bg-field px-3 py-2 text-sm text-muted">
            Invite people first; then you can make them admins.
          </p>
        )}
        {people.map((u) => {
          const name = client.state.profiles[u]?.username ?? 'Member';
          const admin = space.admins.includes(u);
          const gone = !space.members.includes(u);
          return (
            <div key={u} className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-hover">
              <Avatar userId={u} size={28} />
              <UserName userId={u} className="flex-1 truncate text-sm font-semibold" />
              {gone && <span className="text-xs text-muted">not a member</span>}
              {!admin && !gone && (
                <button
                  className="text-xs text-danger hover:underline"
                  onClick={() =>
                    openModal({
                      kind: 'confirm',
                      title: `Ban ${name}?`,
                      body: `${name} leaves ${space.name} and can't join again, even with an invite.`,
                      action: 'Ban',
                      danger: true,
                      onConfirm: () => client.banMember(spaceId, u),
                    })
                  }
                >
                  Ban
                </button>
              )}
              {isOwner && (
                <Toggle
                  checked={admin}
                  label={`${name} is an admin`}
                  onChange={(v) =>
                    void client.setAdmin(spaceId, u, v).catch((e) => client.reportError(e.message))
                  }
                />
              )}
            </div>
          );
        })}
      </section>
      {isOwner && (
        <div className="mt-6 rounded-2xl border border-danger/40 p-4">
          <div className="font-semibold text-text">Delete space</div>
          <p className="mt-1 text-sm text-muted">
            Everyone loses access. Messages stay only on members' devices.
          </p>
          <Button
            variant="danger"
            className="mt-3"
            onClick={() =>
              openModal({
                kind: 'confirm',
                title: `Delete ${space.name}?`,
                body: 'Everyone loses access, for good. This cannot be undone.',
                action: 'Delete space',
                danger: true,
                confirmText: space.name,
                onConfirm: async () => {
                  await client.deleteSpace(spaceId);
                  closeModal();
                  navigate({ kind: 'friends' });
                },
              })
            }
          >
            Delete space
          </Button>
        </div>
      )}
    </Modal>
  );
}
