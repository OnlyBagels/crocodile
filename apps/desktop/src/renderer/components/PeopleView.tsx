import { useState } from 'react';
import {
  Check,
  MessageCircle,
  Phone,
  Search,
  ShieldBan,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import type { ProfileView } from '@crocodile/client-core';
import { getClient, navigate, openModal, useCroc } from '../croc';
import { CrocMark } from './Logo';
import { Avatar, Button, IconButton, UserName, cx } from './ui';

type Tab = 'all' | 'online' | 'requests' | 'blocked';

export function PeopleView() {
  const [tab, setTab] = useState<Tab>('all');
  const friends = useCroc((s) => s.friends);
  const presence = useCroc((s) => s.presence);
  const client = getClient();
  const online = friends.friends.filter((f) => presence[f] && presence[f] !== 'offline');
  const dmRequests = useCroc((s) => s.dmRequests);
  const requestCount = dmRequests.length + friends.incoming.length + friends.outgoing.length;
  const tabs: [Tab, string, number][] = [
    ['all', 'All', friends.friends.length],
    ['online', 'Online', online.length],
    ['requests', 'Requests', requestCount],
    ['blocked', 'Blocked', friends.blocked.length],
  ];
  const rows =
    tab === 'all'
      ? friends.friends.map((u) => ({ u, kind: 'friend' as const }))
      : tab === 'online'
        ? online.map((u) => ({ u, kind: 'friend' as const }))
        : tab === 'requests'
          ? [
              ...dmRequests.map((u) => ({ u, kind: 'message' as const })),
              ...friends.incoming.map((u) => ({ u, kind: 'incoming' as const })),
              ...friends.outgoing.map((u) => ({ u, kind: 'outgoing' as const })),
            ]
          : friends.blocked.map((u) => ({ u, kind: 'blocked' as const }));

  return (
    <section className="island flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-raised text-accent">
          <Users size={18} />
        </span>
        <h1 className="text-[16px] font-bold">People</h1>
        <div className="ml-4 flex rounded-full bg-raised p-1">
          {tabs.map(([id, label, n]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cx(
                'flex items-center gap-1.5 rounded-full px-3.5 py-1 text-[13px] font-semibold transition',
                tab === id ? 'bg-island text-text shadow' : 'text-muted hover:text-text',
              )}
            >
              {label}
              {n > 0 && (
                <span
                  className={cx(
                    'rounded-full px-1.5 text-[10px]',
                    id === 'requests' && (friends.incoming.length || dmRequests.length)
                      ? 'bg-danger text-white'
                      : 'bg-hover',
                  )}
                >
                  {n}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <AddPeople />
        {rows.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center text-muted">
            <CrocMark size={56} className="text-accent" />
            <p className="mt-3 font-semibold text-text-2">
              {tab === 'requests'
                ? 'No pending requests.'
                : tab === 'online'
                  ? 'Nobody is around right now.'
                  : tab === 'blocked'
                    ? 'You have not blocked anyone.'
                    : 'No friends yet.'}
            </p>
            {tab === 'all' && (
              <p className="mt-1 text-sm">Search for someone above by their name and tag.</p>
            )}
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            {rows.map(({ u, kind }) => (
              <div
                key={u}
                className="rounded-2xl border border-line bg-island-2 p-4 transition hover:border-accent/40"
              >
                <button
                  className="flex w-full items-center gap-3 text-left"
                  onClick={() => openModal({ kind: 'profile', userId: u })}
                >
                  <Avatar userId={u} size={44} status="auto" />
                  <div className="min-w-0">
                    <UserName userId={u} className="block truncate font-bold" />
                    <div className="text-xs text-muted">
                      {kind === 'message'
                        ? 'Wants to message you'
                        : kind === 'incoming'
                          ? 'Wants to be friends'
                          : kind === 'outgoing'
                            ? 'Request sent'
                            : kind === 'blocked'
                              ? 'Blocked'
                              : (presence[u] ?? 'offline')}
                    </div>
                  </div>
                </button>
                <div className="mt-3 flex gap-1.5">
                  {kind === 'friend' && (
                    <>
                      <Button
                        variant="soft"
                        className="h-8 flex-1 px-3 text-xs"
                        onClick={() => navigate({ kind: 'dm', userId: u })}
                      >
                        <MessageCircle size={14} /> Message
                      </Button>
                      <IconButton
                        label="Call"
                        size={32}
                        onClick={() => {
                          navigate({ kind: 'dm', userId: u });
                          void client.callDm(u).catch((e) => client.reportError(e.message));
                        }}
                      >
                        <Phone size={15} />
                      </IconButton>
                      <IconButton
                        label="Remove friend"
                        size={32}
                        onClick={() => void client.removeFriend(u)}
                      >
                        <UserMinus size={15} />
                      </IconButton>
                    </>
                  )}
                  {kind === 'message' && (
                    <>
                      <Button
                        className="h-8 flex-1 px-3 text-xs"
                        onClick={() => {
                          void client.acceptDmRequest(u);
                          navigate({ kind: 'dm', userId: u });
                        }}
                      >
                        <Check size={14} /> Accept
                      </Button>
                      <Button
                        variant="secondary"
                        className="h-8 px-3 text-xs"
                        onClick={() => client.declineDmRequest(u)}
                      >
                        Decline
                      </Button>
                      <IconButton label="Block" size={32} onClick={() => void client.block(u)}>
                        <ShieldBan size={15} />
                      </IconButton>
                    </>
                  )}
                  {kind === 'incoming' && (
                    <>
                      <Button
                        className="h-8 flex-1 px-3 text-xs"
                        onClick={() => void client.addFriend(u)}
                      >
                        <Check size={14} /> Accept
                      </Button>
                      <Button
                        variant="secondary"
                        className="h-8 px-3 text-xs"
                        onClick={() => void client.block(u)}
                      >
                        <ShieldBan size={14} /> Block
                      </Button>
                    </>
                  )}
                  {kind === 'outgoing' && (
                    <Button
                      variant="secondary"
                      className="h-8 flex-1 px-3 text-xs"
                      onClick={() => void client.removeFriend(u)}
                    >
                      Cancel request
                    </Button>
                  )}
                  {kind === 'blocked' && (
                    <Button
                      variant="secondary"
                      className="h-8 flex-1 px-3 text-xs"
                      onClick={() => void client.unblock(u)}
                    >
                      <ShieldBan size={14} /> Unblock
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function AddPeople() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProfileView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const me = useCroc((s) => s.me);
  const friends = useCroc((s) => s.friends);
  const client = getClient();
  const search = async () => {
    setBusy(true);
    try {
      setResults((await client.searchUsers(query)).filter((p) => p.userId !== me?.userId));
    } catch (e) {
      client.reportError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-3xl border border-line bg-gradient-to-br from-accent-soft to-transparent p-5">
      <div className="flex items-center gap-2 font-bold">
        <UserPlus size={18} className="text-accent" /> Add someone
      </div>
      <p className="mt-1 text-sm text-muted">
        Ask for their name and tag. Yours is{' '}
        <b className="selectable text-text">{me ? `${me.username}#${me.tag}` : 'name#1234'}</b>.
      </p>
      <form
        className="mt-3 flex items-center gap-2 rounded-full border border-line bg-field py-1.5 pl-4 pr-1.5 focus-within:border-accent"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) void search();
        }}
      >
        <Search size={16} className="text-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="name#1234"
          className="selectable flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
        />
        <Button type="submit" disabled={!query.trim() || busy} className="h-8">
          Search
        </Button>
      </form>
      {results && results.length === 0 && (
        <p className="mt-3 text-sm text-muted">Nobody found. Check the spelling and the #tag.</p>
      )}
      {results?.map((p) => {
        const already = friends.friends.includes(p.userId) || friends.outgoing.includes(p.userId);
        return (
          <div
            key={p.userId}
            className="mt-2 flex items-center gap-3 rounded-2xl bg-island px-3 py-2"
          >
            <Avatar userId={p.userId} size={34} />
            <div className="flex-1">
              <span className="font-bold">{p.username}</span>
              <span className="text-muted">#{p.tag}</span>
            </div>
            <Button
              className="h-8 text-xs"
              disabled={already}
              onClick={() => void client.addFriend(p.userId)}
            >
              {already ? 'Requested' : 'Add friend'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
