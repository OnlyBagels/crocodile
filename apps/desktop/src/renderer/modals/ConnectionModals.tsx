import { useEffect, useState } from 'react';
import { Activity, CheckCircle2, Circle, Copy, RefreshCw, XCircle } from 'lucide-react';
import { parseSessionId } from '@crocodile/protocol';
import type { ClientState, ConnectAttempt, LinkStats, SessionView } from '@crocodile/client-core';
import { closeModal, diagnostics, getClient, recentLogLines, useCroc } from '../croc';
import { STAGE_TEXT, STEPS, attemptSummary, duration } from '../lib/connection';
import { NETWORK_TEXT, ROUTE_TEXT } from '../lib/network';
import { copyText } from '../lib/format';
import { Button, Input, Modal, cx } from '../components/ui';

/** "Alice", "#general in The Swamp", "The Swamp (text)". */
export function sessionTitle(id: string, s: ClientState): string {
  const scope = parseSessionId(id);
  const me = s.me?.userId;
  if (scope?.kind === 'dm') {
    const other = scope.users.find((u) => u !== me) ?? scope.users[0];
    return s.profiles[other]?.username ?? 'Direct messages';
  }
  if (scope?.kind === 'voice') {
    const space = s.spaces[scope.spaceId];
    const room = space?.channels.find((c) => c.id === scope.channelId)?.name ?? 'voice room';
    return `${room} in ${space?.name ?? 'a space'}`;
  }
  if (scope?.kind === 'space') return `${s.spaces[scope.spaceId]?.name ?? 'A space'} (chat)`;
  return id;
}

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The steps of one attempt: done, failed at, or not reached. */
function AttemptSteps({ attempt }: { attempt: ConnectAttempt }) {
  const failedAt =
    attempt.end &&
    !attempt.end.ok &&
    attempt.end.stage !== 'lost' &&
    attempt.end.stage !== 'host-left' &&
    attempt.end.stage !== 'superseded'
      ? STEPS.find((s) => !attempt.steps.some((d) => d.step === s.step))?.step
      : undefined;
  return (
    <ol className="space-y-1.5">
      {STEPS.map(({ step, label }) => {
        const done = attempt.steps.find((d) => d.step === step);
        const failed = !done && step === failedAt;
        return (
          <li key={step} className="flex items-center gap-2 text-xs">
            {done ? (
              <CheckCircle2 size={14} className="shrink-0 text-accent" aria-label="Done" />
            ) : failed ? (
              <XCircle size={14} className="shrink-0 text-danger" aria-label="Failed here" />
            ) : (
              <Circle size={14} className="shrink-0 text-faint" aria-label="Not reached" />
            )}
            <span
              className={cx(
                done ? 'text-text' : failed ? 'font-semibold text-danger' : 'text-faint',
              )}
            >
              {label}
            </span>
            {done && (
              <span className="ml-auto tabular-nums text-faint">
                +{((done.at - attempt.startedAt) / 1000).toFixed(1)} s
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * How one session's connection stands: who hosts, how it travels, and each
 * recent attempt step by step, with where and why the failed ones stopped.
 */
export function ConnectionDetails({ session }: { session: SessionView }) {
  const profiles = useCroc((s) => s.profiles);
  const me = useCroc((s) => s.me?.userId);
  const name = (u: string | null) =>
    !u ? 'nobody' : u === me ? 'you' : (profiles[u]?.username ?? 'someone');
  const attempts = [...session.attempts].reverse();
  const latest = attempts[0];
  // The latest real failure; an attempt the session itself stopped isn't one.
  const failure = attempts.find((a) => a.end && !a.end.ok && a.end.stage !== 'superseded');
  let headline: string;
  if (session.iAmHost) headline = 'You are hosting: the others connect to you.';
  else if (session.status === 'connected')
    headline = `Connected to ${name(session.host)}${session.route ? `, ${ROUTE_TEXT[session.route]}` : ''}${
      session.connectedAt ? `, for ${duration(Date.now() - session.connectedAt)}` : ''
    }.`;
  else if (session.status === 'no-host') headline = 'Nobody online can host right now.';
  else headline = `Connecting to ${name(session.host)}…`;
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="font-semibold">{headline}</div>
        <div className="mt-0.5 text-xs text-muted">
          Host: {name(session.host)} · backup: {name(session.backup)} · {session.members.length}{' '}
          {session.members.length === 1 ? 'member' : 'members'} online
          {session.relay
            ? ` · relay through ${session.relay.server} until ${time(session.relay.expiresAt)}`
            : ''}
        </div>
      </div>
      {failure?.end && !failure.end.ok && (
        <div className="rounded-2xl border border-line p-3">
          <div className="text-xs font-semibold text-warn">
            Last problem, at {time(failure.end.at)}: {attemptSummary(failure)}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {STAGE_TEXT[failure.end.stage].detail}
          </p>
          <p className="mt-1 text-[11px] text-faint">Details: {failure.end.reason}</p>
        </div>
      )}
      {latest && (
        <section aria-label="Connection attempts" className="space-y-3">
          {attempts.map((a, i) => (
            <div key={`${a.startedAt}-${i}`} className="rounded-2xl border border-line p-3">
              <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="font-semibold">{time(a.startedAt)}</span>
                <span className="text-muted">
                  to {name(a.host)}
                  {a.viaRelay ? ' · relay offered' : ''}
                </span>
                <span
                  className={cx(
                    'ml-auto font-semibold',
                    !a.end ? 'text-muted' : a.end.ok ? 'text-accent' : 'text-warn',
                  )}
                >
                  {attemptSummary(a)}
                </span>
              </div>
              <AttemptSteps attempt={a} />
            </div>
          ))}
        </section>
      )}
      {!latest && !session.iAmHost && (
        <p className="text-xs text-muted">No connection attempts yet.</p>
      )}
    </div>
  );
}

/** Connection details for one session, opened from the chat header or the call dock. */
export function ConnectionModal({ sessionId }: { sessionId: string }) {
  const session = useCroc((s) => s.sessions[sessionId]);
  const title = useCroc((s) => sessionTitle(sessionId, s));
  return (
    <Modal
      title="Connection"
      subtitle={title}
      icon={<Activity size={20} />}
      onClose={closeModal}
      wide
    >
      {session ? (
        <ConnectionDetails session={session} />
      ) : (
        <p className="text-sm text-muted">Not connected.</p>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Debug tab
// ---------------------------------------------------------------------------

const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

/** Live WebRTC numbers for a session, refreshed every two seconds. */
function useLinkStats(sessionId: string) {
  const [stats, setStats] = useState<LinkStats | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void getClient()
        .sessionStats(sessionId)
        .then((s) => alive && setStats(s))
        .catch(() => {});
    read();
    const t = setInterval(read, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId]);
  return stats;
}

function StatsLine({ sessionId }: { sessionId: string }) {
  const s = useLinkStats(sessionId);
  if (!s) return <div className="text-[11px] text-faint">No live connection.</div>;
  const cand = (c: LinkStats['local']) => (c ? `${c.type}/${c.protocol} ${c.address}` : '?');
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] text-text-2">
      <dt className="text-faint">route</dt>
      <dd>{s.route ?? '?'}</dd>
      <dt className="text-faint">local</dt>
      <dd>{cand(s.local)}</dd>
      <dt className="text-faint">remote</dt>
      <dd>{cand(s.remote)}</dd>
      <dt className="text-faint">rtt</dt>
      <dd>{s.rttMs ?? '?'} ms</dd>
      <dt className="text-faint">traffic</dt>
      <dd>
        {bytes(s.bytesSent)} sent · {bytes(s.bytesReceived)} received
      </dd>
      {s.audio && (
        <>
          <dt className="text-faint">audio in</dt>
          <dd>
            {s.audio.packetsReceived} packets · {s.audio.packetsLost} lost
            {s.audio.jitterMs !== null ? ` · jitter ${s.audio.jitterMs} ms` : ''}
          </dd>
        </>
      )}
    </dl>
  );
}

function DebugSession({ session }: { session: SessionView }) {
  const title = useCroc((s) => sessionTitle(session.id, s));
  const [open, setOpen] = useState(false);
  const last = session.attempts.at(-1);
  return (
    <div className="rounded-2xl border border-line bg-island-2 p-4">
      <button
        className="flex w-full items-center gap-2 text-left text-sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="font-semibold">{title}</span>
        <span className="text-xs text-muted">
          {session.status}
          {session.iAmHost ? ' · hosting' : ''}
          {session.route ? ` · ${session.route}` : ''}
          {session.relay ? ' · relay' : ''} · epoch {session.epoch}
        </span>
        <span className="ml-auto text-xs text-faint">{last ? attemptSummary(last) : ''}</span>
      </button>
      <div className="mt-2">
        <StatsLine sessionId={session.id} />
      </div>
      {open && (
        <div className="mt-3 border-t border-line pt-3">
          <ConnectionDetails session={session} />
        </div>
      )}
    </div>
  );
}

/**
 * Everything about the app's connections on one page, live: the
 * coordination server, the network check, each session with its attempts
 * and WebRTC numbers, and the client log.
 */
export function DebugTab() {
  const link = useCroc((s) => s.link);
  const server = useCroc((s) => s.server);
  const network = useCroc((s) => s.network);
  const sessions = useCroc((s) => s.sessions);
  const relayOn = useCroc((s) => s.settings.allowServerRelay);
  const [filter, setFilter] = useState('');
  const [lines, setLines] = useState<string[]>(() => recentLogLines());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setLines(recentLogLines()), 1000);
    return () => clearInterval(t);
  }, []);
  const shown = lines.filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()));
  const list = Object.values(sessions).filter((s) => s.status !== 'left');
  return (
    <div className="space-y-6">
      <section aria-label="Coordination server">
        <h3 className="mb-2 text-lg font-bold">Coordination server</h3>
        <div className="rounded-2xl border border-line bg-island-2 p-4 font-mono text-[12px] text-text-2">
          <div>link: {link}</div>
          {server && (
            <>
              <div>
                server: {server.info.name} · {server.info.url} · {Math.round(server.rttMs)} ms
              </div>
              <div>relay setting: {relayOn ? 'on' : 'off'}</div>
            </>
          )}
        </div>
      </section>
      <section aria-label="Network check">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-lg font-bold">Network check</h3>
          <Button
            variant="ghost"
            className="ml-auto h-8 text-xs"
            disabled={!!network?.checking}
            onClick={() => void getClient().checkNetwork(true)}
          >
            <RefreshCw size={13} /> {network?.checking ? 'Testing…' : 'Test again'}
          </Button>
        </div>
        <div className="rounded-2xl border border-line bg-island-2 p-4 text-xs">
          <div className="font-semibold">{NETWORK_TEXT[network?.verdict ?? 'unknown'].title}</div>
          {network?.reason && <p className="mt-1 text-muted">{network.reason}</p>}
          {network?.checks?.map((c) => (
            <div key={c.id} className="mt-1 font-mono text-[11px] text-text-2">
              {c.status.padEnd(7)} {c.label}
            </div>
          ))}
        </div>
      </section>
      <section aria-label="Sessions">
        <h3 className="mb-2 text-lg font-bold">Sessions</h3>
        <div className="space-y-2">
          {list.length === 0 && <p className="text-xs text-muted">No open sessions.</p>}
          {list.map((s) => (
            <DebugSession key={s.id} session={s} />
          ))}
        </div>
      </section>
      <section aria-label="Client log">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-lg font-bold">Client log</h3>
          <Input
            aria-label="Filter the log"
            placeholder="Filter"
            className="ml-auto h-8 w-48 text-xs"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Button
            variant="secondary"
            className="h-8 text-xs"
            onClick={async () => {
              await copyText(await diagnostics());
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={13} /> {copied ? 'Copied' : 'Copy diagnostics'}
          </Button>
        </div>
        <pre
          aria-label="Log lines"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-2xl border border-line bg-island-2 p-3 font-mono text-[11px] leading-relaxed text-text-2"
        >
          {shown.slice(-200).join('\n') || 'Nothing logged yet.'}
        </pre>
      </section>
    </div>
  );
}
