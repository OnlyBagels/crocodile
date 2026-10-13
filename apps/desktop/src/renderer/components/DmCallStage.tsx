import { useEffect, useState } from 'react';
import { Headphones, HeadphoneOff, Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import { getClient, useCroc } from '../croc';
import { callPhase, callStatusText, showDmCallStage } from '../lib/call';
import { Participant } from './CallParticipants';
import { IconButton, cx } from './ui';
import { CallVideo, VideoButtons } from './CallVideo';

/**
 * A DM's call, laid out like a voice room: both people on a stage above the
 * chat, with what the call is doing (ringing, waiting, live time) and its
 * controls. Shown while we are in the call, are being rung, or the other
 * side is in it without us.
 */
export function DmCallStage({
  sessionId,
  otherUserId,
}: {
  sessionId: string;
  otherUserId: string;
}) {
  const me = useCroc((s) => s.me?.userId);
  const session = useCroc((s) => s.sessions[sessionId]);
  const joined = useCroc((s) => s.voiceSession === sessionId);
  const ringingOut = useCroc((s) => joined && s.outgoingCall?.sessionId === sessionId);
  const ringingIn = useCroc((s) => s.incomingCall?.sessionId === sessionId);
  const liveSince = useCroc((s) => (joined ? s.callLiveSince : null));
  const muted = useCroc((s) => s.muted);
  const deafened = useCroc((s) => s.deafened);
  const otherName = useCroc((s) => s.profiles[otherUserId]?.username ?? 'them');
  const otherInCall = !!session?.inCall.includes(otherUserId);
  const hasVideo = joined && !!session?.video.streams.length;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!liveSince) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [liveSince]);
  if (!me || !showDmCallStage({ joined, ringingIn, otherInCall })) return null;
  const client = getClient();
  const phase = callPhase(session, { ringing: ringingOut, liveSince });
  const status = joined
    ? callStatusText(phase, { liveSince, now, other: otherName })
    : `${otherName} is in a call with you`;
  const live = joined && phase === 'live';
  const call = () => void client.callDm(otherUserId).catch((e) => client.reportError(e.message));
  return (
    <section
      aria-label="Call"
      className="relative shrink-0 overflow-hidden border-b border-line"
      style={{
        background: 'radial-gradient(500px 220px at 50% 70%, var(--accent-soft), transparent 75%)',
      }}
    >
      <div className="flex items-center justify-center gap-2 pt-4 text-sm font-semibold">
        <span className={cx('h-2.5 w-2.5 rounded-full', live ? 'live-dot bg-accent' : 'bg-warn')} />
        <span aria-label="Call status" className={live ? 'tabular-nums' : 'text-muted'}>
          {status}
        </span>
      </div>
      {hasVideo ? (
        <div className="max-h-[55vh] overflow-y-auto">
          <CallVideo sessionId={sessionId} members={[me, otherUserId]} />
        </div>
      ) : (
        <div className="flex items-start justify-center gap-16 px-6 py-6">
          <Participant
            userId={me}
            session={joined ? session : undefined}
            size={96}
            away={joined ? undefined : 'Not in the call'}
          />
          <Participant
            userId={otherUserId}
            session={otherInCall ? session : undefined}
            size={96}
            away={
              otherInCall
                ? undefined
                : ringingOut
                  ? 'Ringing…'
                  : joined
                    ? 'Not in the call'
                    : undefined
            }
          />
        </div>
      )}
      <div className="flex justify-center gap-2 pb-5">
        {joined ? (
          <>
            <IconButton
              label={muted ? 'Unmute' : 'Mute'}
              danger={muted}
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
            <VideoButtons sessionId={sessionId} />
            <button
              onClick={() => void client.leaveVoice()}
              className="flex h-9 items-center gap-1.5 rounded-full bg-danger px-4 text-sm font-semibold text-white hover:brightness-110"
            >
              <PhoneOff size={16} /> {phase === 'ringing' ? 'Cancel' : 'Hang up'}
            </button>
          </>
        ) : (
          <button
            onClick={call}
            className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent hover:brightness-110"
          >
            <Phone size={16} /> Join call
          </button>
        )}
      </div>
    </section>
  );
}
