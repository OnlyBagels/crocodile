import { useEffect, useState } from 'react';
import {
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { parseSessionId } from '@crocodile/protocol';
import { getClient, navigate, openModal, useCroc, useUi } from '../croc';
import { Avatar, IconButton, cx } from './ui';
import { ROUTE_TEXT } from '../lib/network';

/** Floating controls for the active call, visible from anywhere in the app. */
export function CallDock() {
  const voiceSession = useCroc((s) => s.voiceSession);
  // We called someone who hasn't answered: the call isn't on yet.
  const ringing = useCroc((s) => !!s.voiceSession && s.outgoingCall?.sessionId === s.voiceSession);
  const session = useCroc((s) => (s.voiceSession ? s.sessions[s.voiceSession] : undefined));
  const spaces = useCroc((s) => s.spaces);
  const muted = useCroc((s) => s.muted);
  const deafened = useCroc((s) => s.deafened);
  const hostName = useCroc((s) => (session?.host ? s.profiles[session.host]?.username : undefined));
  const me = useCroc((s) => s.me?.userId);
  const micLevel = useUi((s) => s.micLevel);
  const vad = useUi((s) => s.voiceSettings.vadThresholdDb);
  const [since, setSince] = useState(Date.now());
  const [, tick] = useState(0);
  // The call's clock starts when the other side picks up.
  useEffect(() => setSince(Date.now()), [voiceSession, ringing]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!voiceSession) return null;
  const client = getClient();
  const scope = parseSessionId(voiceSession);
  let where = 'Call';
  let go = () => {};
  if (scope?.kind === 'voice') {
    const space = spaces[scope.spaceId];
    where = space?.channels.find((c) => c.id === scope.channelId)?.name ?? 'Room';
    go = () => navigate({ kind: 'space', spaceId: scope.spaceId, channelId: scope.channelId });
  } else if (scope?.kind === 'dm' && me) {
    const other = scope.users.find((u) => u !== me)!;
    where = client.state.profiles[other]?.username ?? 'Call';
    go = () => navigate({ kind: 'dm', userId: other });
  }
  const status = session?.status ?? 'joining';
  const connected = status === 'connected' && !ringing;
  const secs = Math.floor((Date.now() - since) / 1000);
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const talking = !muted && micLevel > vad;
  const relayLeft = session?.relay
    ? Math.max(0, Math.round((session.relay.expiresAt - Date.now()) / 60_000))
    : null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center">
      <div className="island rise pointer-events-auto flex items-center gap-3 rounded-full py-2 pl-3 pr-2">
        <button
          onClick={go}
          className="flex items-center gap-2.5 rounded-full py-1 pl-1 pr-3 hover:bg-hover"
        >
          <span
            className={cx('h-2.5 w-2.5 rounded-full', connected ? 'live-dot bg-accent' : 'bg-warn')}
          />
          <div className="text-left leading-tight">
            <div className="max-w-[160px] truncate text-[13px] font-bold">{where}</div>
            <div className="text-[11px] text-muted">
              {ringing
                ? 'Ringing…'
                : connected
                  ? clock
                  : status === 'no-host'
                    ? 'Waiting for a host'
                    : 'Connecting…'}
            </div>
          </div>
        </button>
        <div className="flex -space-x-2">
          {(session?.members ?? []).slice(0, 5).map((u) => (
            <Avatar
              key={u}
              userId={u}
              size={28}
              round
              speaking={!!session?.speaking.includes(u)}
              className="rounded-full ring-2 ring-[var(--island)]"
            />
          ))}
        </div>
        {session && (
          <button
            className="hidden items-center gap-1.5 rounded-full bg-raised px-3 py-1.5 text-[11px] text-muted hover:text-text lg:flex"
            title="Connection details. Voice goes peer-to-peer through the host's device and is end-to-end encrypted."
            onClick={() => openModal({ kind: 'connection', sessionId: session.id })}
          >
            <ShieldCheck size={12} className="text-accent" />
            {relayLeft !== null ? (
              <span
                className="flex items-center gap-1 text-warn"
                title={`Relayed via ${session.relay!.server}; still end-to-end encrypted`}
              >
                <Server size={12} /> relayed · {relayLeft} min left
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <Radio size={12} />{' '}
                {session.iAmHost ? 'you host' : hostName ? `hosted by ${hostName}` : 'finding host'}
                {session.route && !session.iAmHost && !ringing
                  ? ` · ${ROUTE_TEXT[session.route]}`
                  : ''}
              </span>
            )}
          </button>
        )}
        <div className="flex items-center gap-1">
          <IconButton
            label={muted ? 'Unmute' : 'Mute'}
            danger={muted}
            active={talking}
            onClick={() => client.setMuted(!muted)}
          >
            {muted ? <MicOff size={18} /> : <Mic size={18} />}
          </IconButton>
          <IconButton
            label={deafened ? 'Undeafen' : 'Deafen'}
            danger={deafened}
            onClick={() => client.setDeafened(!deafened)}
          >
            {deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
          </IconButton>
          <button
            onClick={() => void client.leaveVoice()}
            aria-label="Leave call"
            title="Leave call"
            className="flex h-9 items-center gap-1.5 rounded-full bg-danger px-4 text-sm font-semibold text-white hover:brightness-110"
          >
            <PhoneOff size={16} /> Leave
          </button>
        </div>
      </div>
    </div>
  );
}
