import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AtSign,
  Clock,
  MailCheck,
  MessageSquareText,
  Pencil,
  Phone,
  Reply,
  SendHorizontal,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { MessageView } from '@crocodile/client-core';
import { getClient, openModal, ui, useCroc, useUi } from '../croc';
import { colorFor, dayOf, renderMessage, timeOf } from '../lib/format';
import { ROUTE_TEXT } from '../lib/network';
import { Avatar, IconButton, UserName, cx } from './ui';

export function ChatView({
  channel,
  title,
  topic,
  kind,
  otherUserId,
}: {
  channel: string;
  title: string;
  topic?: string;
  kind: 'channel' | 'dm';
  otherUserId?: string;
}) {
  const messages = useCroc((s) => s.messages[channel]);
  const sessionId = kind === 'dm' ? channel : getClient().sessionOfChannel(channel);
  const session = useCroc((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const typing = useCroc((s) => s.typing[channel]);
  const showMembers = useUi((s) => s.showMembers);
  const density = useUi((s) => s.appearance.density);
  const me = useCroc((s) => s.me?.userId);
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const client = getClient();

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages?.length, channel]);

  useEffect(() => {
    stick.current = true;
    setReplyTo(null);
    setEditing(null);
  }, [channel]);

  const typers = Object.entries(typing ?? {})
    .filter(([u, until]) => u !== me && until > Date.now())
    .map(([u]) => u);

  const peers = session?.peers.length ?? 0;
  const connection =
    !session || session.status === 'joining' || session.status === 'connecting'
      ? 'Connecting to peers…'
      : session.status === 'reconnecting'
        ? 'Reconnecting to peers…'
        : session.status === 'no-host'
          ? 'Nobody online can host right now; your messages wait safely on this device.'
          : null;

  return (
    <section className="island flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-5">
        {kind === 'dm' && otherUserId ? (
          <button onClick={() => openModal({ kind: 'profile', userId: otherUserId })}>
            <Avatar userId={otherUserId} size={34} status="auto" />
          </button>
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-raised text-accent">
            <MessageSquareText size={18} />
          </span>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-[16px] font-bold">{title}</h1>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck size={12} className="text-accent" />
            {topic && (
              <>
                <span className="truncate">{topic}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <button
              className="shrink-0 whitespace-nowrap hover:text-text hover:underline"
              title="Connection details"
              onClick={() => sessionId && openModal({ kind: 'connection', sessionId })}
            >
              {topic ? '' : 'End-to-end encrypted · '}
              {peers} peer{peers === 1 ? '' : 's'} connected
              {session?.route && !session.iAmHost && peers > 0
                ? ` · ${ROUTE_TEXT[session.route]}`
                : ''}
            </button>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {kind === 'dm' && otherUserId && (
            <IconButton
              label="Start a call"
              onClick={() =>
                void client.callDm(otherUserId).catch((e) => client.reportError(e.message))
              }
            >
              <Phone size={18} />
            </IconButton>
          )}
          {kind === 'channel' && (
            <IconButton
              label={showMembers ? 'Hide members' : 'Show members'}
              active={showMembers}
              onClick={() => ui.set({ showMembers: !showMembers })}
            >
              <Users size={18} />
            </IconButton>
          )}
        </div>
      </header>

      {connection && (
        <div className="flex items-center gap-2 border-b border-line bg-warn/10 px-5 py-1.5 text-xs font-medium text-warn">
          {connection}
          {sessionId && (
            <button
              className="ml-auto underline hover:text-text"
              onClick={() => openModal({ kind: 'connection', sessionId })}
            >
              Details
            </button>
          )}
        </div>
      )}

      <div
        ref={scroller}
        className="selectable flex-1 overflow-y-auto px-5 pb-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          if (el.scrollTop < 40) void client.loadOlder(channel);
        }}
      >
        <div className="mx-auto flex max-w-md flex-col items-center py-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            {kind === 'dm' && otherUserId ? <AtSign size={26} /> : <MessageSquareText size={26} />}
          </div>
          <h2 className="mt-3 text-lg font-bold">
            {kind === 'dm' ? `You and ${title}` : `This is the start of ${title}`}
          </h2>
          <p className="mt-1 text-sm text-muted">
            Messages here travel only between {kind === 'dm' ? 'your devices' : 'members'},
            end-to-end encrypted, and are stored on those devices alone.
          </p>
        </div>
        <MessageList
          messages={messages ?? []}
          me={me}
          onReply={setReplyTo}
          editing={editing}
          setEditing={setEditing}
          channel={channel}
          bubbles={density === 'bubbles'}
        />
      </div>

      <div className="px-5 pb-5">
        <div className="h-5 px-2 text-xs text-muted">
          {typers.length > 0 && (
            <span>
              <b className="text-text-2">
                {typers.map((u) => getClient().state.profiles[u]?.username ?? 'Someone').join(', ')}
              </b>{' '}
              {typers.length === 1 ? 'is' : 'are'} typing…
            </span>
          )}
        </div>
        {replyTo && (
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-island-2 px-3 py-2 text-sm text-muted">
            <Reply size={14} />
            Replying to <UserName userId={replyTo.author} className="font-semibold text-text" />
            <span className="truncate">{replyTo.body}</span>
            <button onClick={() => setReplyTo(null)} className="ml-auto hover:text-text">
              <X size={14} />
            </button>
          </div>
        )}
        <Composer
          channel={channel}
          placeholder={kind === 'dm' ? `Message ${title}` : `Message ${title}`}
          onSend={async (text) => {
            await client.sendMessage(channel, text, replyTo ? { replyTo: replyTo.id } : {});
            setReplyTo(null);
            stick.current = true;
          }}
        />
      </div>
    </section>
  );
}

function MessageList(props: {
  messages: MessageView[];
  me?: string;
  onReply: (m: MessageView) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  channel: string;
  bubbles: boolean;
}) {
  const { messages, me } = props;
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  return (
    <div className="flex flex-col">
      {messages.map((m, i) => {
        if (m.deleted) return null;
        const prev = messages[i - 1];
        const next = messages[i + 1];
        const newDay = !prev || dayOf(prev.ts) !== dayOf(m.ts);
        const sameAsPrev =
          !!prev && !newDay && prev.author === m.author && m.ts - prev.ts < 5 * 60_000;
        const sameAsNext =
          !!next &&
          dayOf(next.ts) === dayOf(m.ts) &&
          next.author === m.author &&
          next.ts - m.ts < 5 * 60_000;
        return (
          <div key={m.id}>
            {newDay && (
              <div className="my-4 flex justify-center">
                <span className="rounded-full bg-raised px-3 py-1 text-[11px] font-semibold text-muted">
                  {dayOf(m.ts)}
                </span>
              </div>
            )}
            <Message
              {...props}
              message={m}
              first={!sameAsPrev}
              last={!sameAsNext}
              mine={m.author === me}
              replied={m.replyTo ? byId.get(m.replyTo) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

function Message({
  message: m,
  first,
  last,
  mine,
  replied,
  onReply,
  editing,
  setEditing,
  channel,
  bubbles,
}: {
  message: MessageView;
  first: boolean;
  last: boolean;
  mine: boolean;
  replied?: MessageView;
  onReply: (m: MessageView) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  channel: string;
  bubbles: boolean;
}) {
  const client = getClient();
  const [draft, setDraft] = useState(m.body);
  const isEditing = editing === m.id;
  const right = bubbles && mine;

  const actions = !isEditing && (
    <div
      className={cx(
        'invisible flex items-center gap-0.5 self-center group-hover:visible',
        right ? 'order-first mr-1' : 'ml-1',
      )}
    >
      <IconButton label="Reply" size={28} onClick={() => onReply(m)}>
        <Reply size={14} />
      </IconButton>
      {mine && (
        <IconButton
          label="Edit"
          size={28}
          onClick={() => {
            setDraft(m.body);
            setEditing(m.id);
          }}
        >
          <Pencil size={14} />
        </IconButton>
      )}
      {mine && (
        <IconButton
          label="Delete"
          size={28}
          onClick={() => void client.deleteMessage(channel, m.id)}
        >
          <Trash2 size={14} />
        </IconButton>
      )}
    </div>
  );

  const body = isEditing ? (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim() && draft !== m.body) void client.editMessage(channel, m.id, draft);
        setEditing(null);
      }}
    >
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
        className="w-80 max-w-full rounded-lg border border-line bg-field px-3 py-1.5 text-[14px] outline-none focus:border-accent"
      />
      <div className="mt-1 text-[11px] text-muted">Esc to cancel · Enter to save</div>
    </form>
  ) : (
    <div className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed">
      {renderMessage(m.body)}
      <span className="ml-2 inline-flex translate-y-0.5 items-center gap-1 align-baseline text-[10.5px] text-faint">
        {m.edited && 'edited · '}
        {timeOf(m.ts)}
        {m.pending &&
          (m.mailed ? (
            <span
              title="The recipient is offline. A coordination server holds this message, sealed so only their devices can read it."
              className="text-muted"
            >
              <MailCheck size={11} />
            </span>
          ) : (
            <span
              title="Not delivered yet. It goes out peer-to-peer as soon as someone who should have it is online."
              className="delayed-in text-warn"
            >
              <Clock size={11} />
            </span>
          ))}
      </span>
    </div>
  );

  const quote = replied && (
    <div
      className="mb-1 border-l-2 pl-2 text-xs text-muted"
      style={{ borderColor: colorFor(replied.author) }}
    >
      <UserName userId={replied.author} className="font-semibold" /> ·{' '}
      <span className="line-clamp-1">{replied.body}</span>
    </div>
  );

  if (!bubbles) {
    return (
      <div
        className={cx(
          'group flex gap-3 rounded-xl px-2 hover:bg-hover/50',
          first ? 'mt-3 py-1' : 'py-0.5',
        )}
      >
        <div className="w-9 shrink-0">{first && <Avatar userId={m.author} size={36} />}</div>
        <div className="min-w-0 flex-1">
          {first && (
            <button
              onClick={() => openModal({ kind: 'profile', userId: m.author })}
              className="text-[14px] font-bold hover:underline"
              style={{ color: colorFor(m.author) }}
            >
              <UserName userId={m.author} />
            </button>
          )}
          {quote}
          {body}
        </div>
        {actions}
      </div>
    );
  }

  return (
    <div
      className={cx(
        'group flex items-end gap-2',
        right ? 'justify-end' : 'justify-start',
        first ? 'mt-3' : 'mt-0.5',
      )}
    >
      {!right && (
        <div className="w-8 shrink-0">{last && <Avatar userId={m.author} size={32} />}</div>
      )}
      {right && actions}
      <div
        className={cx(
          'max-w-[72%] px-3.5 py-2 shadow-sm',
          right ? 'bg-bubble-me' : 'bg-bubble',
          right
            ? cx(
                'rounded-l-2xl',
                first ? 'rounded-tr-2xl' : 'rounded-tr-md',
                last ? 'rounded-br-md' : 'rounded-br-md',
              )
            : cx(
                'rounded-r-2xl',
                first ? 'rounded-tl-2xl' : 'rounded-tl-md',
                last ? 'rounded-bl-md' : 'rounded-bl-md',
              ),
        )}
      >
        {first && !right && (
          <button
            onClick={() => openModal({ kind: 'profile', userId: m.author })}
            className="mb-0.5 block text-[12.5px] font-bold hover:underline"
            style={{ color: colorFor(m.author) }}
          >
            <UserName userId={m.author} />
          </button>
        )}
        {quote}
        {body}
      </div>
      {!right && actions}
    </div>
  );
}

function Composer({
  channel,
  placeholder,
  onSend,
}: {
  channel: string;
  placeholder: string;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const lastTyping = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setText('');
    ref.current?.focus();
  }, [channel]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  const send = () => {
    const value = text;
    if (!value.trim()) return;
    setText('');
    void onSend(value).catch((err) => getClient().reportError(err.message));
  };
  return (
    <div className="flex items-end gap-2 rounded-3xl border border-line bg-field py-1.5 pl-5 pr-1.5 transition focus-within:border-accent focus-within:ring-4 focus-within:ring-accent-soft">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        maxLength={4000}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          if (Date.now() - lastTyping.current > 3000) {
            lastTyping.current = Date.now();
            getClient().sendTyping(channel);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        className="selectable max-h-56 flex-1 resize-none bg-transparent py-2 text-[14.5px] text-text outline-none placeholder:text-faint"
      />
      <button
        onClick={send}
        disabled={!text.trim()}
        aria-label="Send"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition hover:brightness-110 disabled:bg-raised disabled:text-faint"
      >
        <SendHorizontal size={17} />
      </button>
    </div>
  );
}
