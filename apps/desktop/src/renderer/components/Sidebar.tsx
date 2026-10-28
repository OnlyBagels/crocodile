import {
  AudioLines,
  Crown,
  Ellipsis,
  LogOut,
  MessageSquareText,
  MicOff,
  HeadphoneOff,
  Plus,
  Radio,
  Settings,
  UserPlus,
  Users,
  X,
  ShieldCheck,
} from 'lucide-react';
import { sessionIds } from '@crocodile/protocol';
import { getClient, navigate, openModal, useCroc, useUi } from '../croc';
import { dmStatusLabel } from '../lib/connection';
import { colorFor, initials } from '../lib/format';
import { Avatar, Menu, MenuItem, UserName, cx } from './ui';

export function SpaceSidebar({ spaceId }: { spaceId: string }) {
  const space = useCroc((s) => s.spaces[spaceId]);
  const me = useCroc((s) => s.me?.userId);
  const unread = useCroc((s) => s.unread);
  const view = useUi((s) => s.view);
  const client = getClient();
  if (!space) return <aside className="island w-[272px] shrink-0" />;
  const isOwner = space.owner === me;
  // The owner and admins change the space and invite people (servers refuse others).
  const canManage = isOwner || (!!me && space.admins.includes(me));
  const text = space.channels.filter((c) => c.kind === 'text');
  const rooms = space.channels.filter((c) => c.kind === 'voice');
  const activeChannel = view.kind === 'space' ? view.channelId : null;

  return (
    <aside className="island flex w-[272px] shrink-0 flex-col overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl text-sm font-bold text-white"
          style={{ background: space.icon ? undefined : colorFor(space.id) }}
        >
          {space.icon ? (
            <img src={space.icon} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(space.name)
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold">{space.name}</div>
          <div className="text-xs text-muted">{space.members.length} members</div>
        </div>
        <Menu
          align="right"
          trigger={(toggle) => (
            <button
              onClick={toggle}
              className="rounded-full p-1.5 text-muted hover:bg-hover hover:text-text"
              aria-label="Space menu"
            >
              <Ellipsis size={18} />
            </button>
          )}
        >
          {(close) => (
            <>
              {canManage && (
                <MenuItem
                  icon={<UserPlus size={16} />}
                  label="Invite people"
                  onClick={() => {
                    close();
                    openModal({ kind: 'invite', spaceId });
                  }}
                />
              )}
              {canManage && (
                <MenuItem
                  icon={<Plus size={16} />}
                  label="New channel or room"
                  onClick={() => {
                    close();
                    openModal({ kind: 'create-channel', spaceId });
                  }}
                />
              )}
              {canManage && (
                <MenuItem
                  icon={<Settings size={16} />}
                  label="Space settings"
                  onClick={() => {
                    close();
                    openModal({ kind: 'space-settings', spaceId });
                  }}
                />
              )}
              {!isOwner && (
                <MenuItem
                  icon={<LogOut size={16} />}
                  label="Leave space"
                  danger
                  onClick={() => {
                    close();
                    openModal({
                      kind: 'confirm',
                      title: `Leave ${space.name}?`,
                      body: 'You will need a new invite to come back.',
                      action: 'Leave',
                      danger: true,
                      onConfirm: async () => {
                        await client.leaveSpace(spaceId);
                        navigate({ kind: 'friends' });
                      },
                    });
                  }}
                />
              )}
            </>
          )}
        </Menu>
      </div>
      {canManage && (
        <button
          onClick={() => openModal({ kind: 'invite', spaceId })}
          className="mx-4 mb-3 flex items-center justify-center gap-2 rounded-xl bg-accent-soft py-2 text-sm font-semibold text-accent transition hover:brightness-125"
        >
          <UserPlus size={16} /> Invite people
        </button>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <Section
          title="Rooms"
          onAdd={canManage ? () => openModal({ kind: 'create-channel', spaceId }) : undefined}
        />
        <div className="flex flex-col gap-2">
          {rooms.map((c) => (
            <RoomCard
              key={c.id}
              spaceId={spaceId}
              channelId={c.id}
              name={c.name}
              active={activeChannel === c.id}
            />
          ))}
        </div>

        <div className="mt-5" />
        <Section
          title="Channels"
          onAdd={canManage ? () => openModal({ kind: 'create-channel', spaceId }) : undefined}
        />
        {text.map((c) => {
          const active = activeChannel === c.id;
          const count = unread[c.id] ?? 0;
          return (
            <button
              key={c.id}
              onClick={() => navigate({ kind: 'space', spaceId, channelId: c.id })}
              className={cx(
                'mb-0.5 flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[14px] transition',
                active
                  ? 'bg-accent-soft font-semibold text-text'
                  : count
                    ? 'font-semibold text-text hover:bg-hover'
                    : 'text-text-2 hover:bg-hover hover:text-text',
              )}
            >
              <MessageSquareText size={17} className={active ? 'text-accent' : 'text-faint'} />
              <span className="truncate">{c.name}</span>
              {count > 0 && !active && (
                <span className="ml-auto rounded-full bg-accent px-2 text-[11px] font-bold text-on-accent">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/** Voice rooms are cards with who is inside, TeamSpeak-style but at a glance. */
function RoomCard({
  spaceId,
  channelId,
  name,
  active,
}: {
  spaceId: string;
  channelId: string;
  name: string;
  active: boolean;
}) {
  const sid = sessionIds.voice(spaceId, channelId);
  const occ = useCroc((s) => s.voice[sid]);
  const live = useCroc((s) => s.sessions[sid]);
  const joined = useCroc((s) => s.voiceSession === sid);
  const members = live?.members.length ? live.members : (occ?.members ?? []);
  const host = live?.host ?? occ?.host ?? null;
  const client = getClient();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        navigate({ kind: 'space', spaceId, channelId });
        if (!joined)
          void client.joinVoice(spaceId, channelId).catch((e) => client.reportError(e.message));
      }}
      className={cx(
        'cursor-pointer rounded-2xl border p-3 transition',
        joined
          ? 'border-accent bg-accent-soft'
          : active
            ? 'border-line bg-raised'
            : 'border-line bg-island-2 hover:border-accent/50',
      )}
    >
      <div className="flex items-center gap-2 text-[14px] font-semibold">
        <AudioLines size={17} className={members.length ? 'text-accent' : 'text-faint'} />
        <span className="truncate">{name}</span>
        {members.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[11px] font-bold text-accent">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" /> {members.length}
          </span>
        )}
      </div>
      {members.length > 0 ? (
        <div className="mt-2.5 flex flex-col gap-1">
          {members.slice(0, 6).map((u) => (
            <div key={u} className="flex items-center gap-2 text-[13px] text-text-2">
              <Avatar userId={u} size={22} speaking={!!live?.speaking.includes(u)} />
              <UserName userId={u} className="truncate" />
              <span className="ml-auto flex items-center gap-1 text-faint">
                {u === host && (
                  <span title="This member's device relays the room's encrypted audio">
                    <Radio size={12} className="text-accent" />
                  </span>
                )}
                {live?.deafened.includes(u) ? (
                  <HeadphoneOff size={12} />
                ) : live?.muted.includes(u) ? (
                  <MicOff size={12} />
                ) : null}
              </span>
            </div>
          ))}
          {members.length > 6 && (
            <div className="pl-8 text-xs text-muted">+{members.length - 6} more</div>
          )}
        </div>
      ) : (
        <div className="mt-1 text-xs text-faint">Empty — click to start talking</div>
      )}
    </div>
  );
}

function Section({ title, onAdd }: { title: string; onAdd?: () => void }) {
  return (
    <div className="mb-2 flex items-center justify-between px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-faint">
      <span>{title}</span>
      {onAdd && (
        <button
          title="Add"
          onClick={onAdd}
          className="rounded-full p-0.5 hover:bg-hover hover:text-text"
        >
          <Plus size={15} />
        </button>
      )}
    </div>
  );
}

export function HomeSidebar() {
  const view = useUi((s) => s.view);
  const dms = useCroc((s) => s.dms);
  const me = useCroc((s) => s.me?.userId);
  const unread = useCroc((s) => s.unread);
  const incoming = useCroc((s) => s.friends.incoming.length + s.dmRequests.length);
  const presence = useCroc((s) => s.presence);
  const sessions = useCroc((s) => s.sessions);
  return (
    <aside className="island flex w-[272px] shrink-0 flex-col overflow-hidden">
      <div className="p-4">
        <button
          onClick={() => navigate({ kind: 'friends' })}
          className={cx(
            'flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-[15px] font-semibold transition',
            view.kind === 'friends'
              ? 'bg-accent-soft text-text'
              : 'text-text-2 hover:bg-hover hover:text-text',
          )}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-raised text-accent">
            <Users size={18} />
          </span>
          People
          {incoming > 0 && (
            <span className="ml-auto rounded-full bg-danger px-2 text-[11px] font-bold text-white">
              {incoming}
            </span>
          )}
        </button>
      </div>
      <div className="flex items-center justify-between px-5 pb-2 text-[12px] font-bold uppercase tracking-[0.08em] text-faint">
        Conversations
        <button
          title="New conversation"
          className="rounded-full p-0.5 hover:bg-hover hover:text-text"
          onClick={() => openModal({ kind: 'new-dm' })}
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {dms.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-faint">
            Start a conversation from People.
          </p>
        )}
        {dms.map((userId) => {
          const active = view.kind === 'dm' && view.userId === userId;
          const count = me ? (unread[sessionIds.dm(me, userId)] ?? 0) : 0;
          const online = presence[userId] && presence[userId] !== 'offline';
          return (
            <div
              key={userId}
              className={cx(
                'group mb-1 flex cursor-pointer items-center gap-3 rounded-2xl px-2.5 py-2 transition',
                active ? 'bg-accent-soft' : 'hover:bg-hover',
              )}
              onClick={() => navigate({ kind: 'dm', userId })}
            >
              <Avatar userId={userId} size={36} status="auto" />
              <div className="min-w-0 flex-1">
                <UserName
                  userId={userId}
                  className={cx(
                    'block truncate text-[14px]',
                    count > 0 ? 'font-bold text-text' : 'font-semibold text-text-2',
                  )}
                />
                <div className="text-xs text-faint">
                  {dmStatusLabel(!!online, me ? sessions[sessionIds.dm(me, userId)] : undefined)}
                </div>
              </div>
              {count > 0 && (
                <span className="rounded-full bg-accent px-2 text-[11px] font-bold text-on-accent">
                  {count}
                </span>
              )}
              <button
                title="Close conversation"
                className="hidden rounded-full p-1 text-faint hover:bg-hover hover:text-text group-hover:block"
                onClick={(e) => {
                  e.stopPropagation();
                  void getClient().closeDm(userId);
                  if (active) navigate({ kind: 'friends' });
                }}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export function DetailsPanel({ spaceId }: { spaceId: string }) {
  const space = useCroc((s) => s.spaces[spaceId]);
  const presence = useCroc((s) => s.presence);
  const me = useCroc((s) => s.me?.userId);
  if (!space) return null;
  const isOnline = (u: string) => u === me || (presence[u] && presence[u] !== 'offline');
  const online = space.members.filter(isOnline);
  const offline = space.members.filter((u) => !isOnline(u));
  const group = (title: string, users: string[], dim: boolean) =>
    users.length > 0 && (
      <div className="mb-4">
        <div className="mb-2 px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-faint">
          {title} · {users.length}
        </div>
        {users.map((u) => (
          <button
            key={u}
            onClick={() => openModal({ kind: 'profile', userId: u })}
            className={cx(
              'flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition hover:bg-hover',
              dim && 'opacity-50 hover:opacity-100',
            )}
          >
            <Avatar userId={u} size={30} status={dim ? undefined : 'auto'} />
            <UserName userId={u} className="truncate text-[14px] text-text-2" />
            {u === space.owner && (
              <span title="Space owner" className="ml-auto">
                <Crown size={14} className="text-amber" />
              </span>
            )}
            {space.admins.includes(u) && (
              <span title="Admin: can change the space and invite people" className="ml-auto">
                <ShieldCheck size={14} className="text-accent" />
              </span>
            )}
          </button>
        ))}
      </div>
    );
  return (
    <aside className="island w-[248px] shrink-0 overflow-y-auto p-4">
      {group('Online', online, false)}
      {group('Offline', offline, true)}
    </aside>
  );
}
