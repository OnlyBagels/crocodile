import { AudioLines, PhoneCall, ShieldCheck } from 'lucide-react';
import { useCroc } from '../croc';
import { Participant } from './CallParticipants';
import { Button } from './ui';
import { CallVideo } from './CallVideo';

/** A voice room: participants float like lily pads; speakers send ripples. */
export function RoomStage({
  sessionId,
  title,
  onJoin,
}: {
  sessionId: string;
  title: string;
  onJoin: () => void;
}) {
  const session = useCroc((s) => s.sessions[sessionId]);
  const occ = useCroc((s) => s.voice[sessionId]);
  const joined = useCroc((s) => s.voiceSession === sessionId);
  const members = session?.members.length ? session.members : (occ?.members ?? []);
  const size = members.length <= 2 ? 120 : members.length <= 6 ? 96 : 72;
  const hasVideo = joined && !!session?.video.streams.length;
  return (
    <section className="island relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(600px 300px at 50% 60%, var(--accent-soft), transparent 70%)',
        }}
      />
      <header className="relative flex h-16 shrink-0 items-center gap-3 border-b border-line px-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-raised text-accent">
          <AudioLines size={18} />
        </span>
        <div>
          <h1 className="text-[16px] font-bold">{title}</h1>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck size={12} className="text-accent" /> Peer-to-peer · end-to-end encrypted
          </div>
        </div>
      </header>
      {hasVideo ? (
        <CallVideo sessionId={sessionId} members={members} fill />
      ) : (
        <div className="relative flex flex-1 flex-wrap content-center items-center justify-center gap-x-10 gap-y-8 overflow-y-auto p-10">
          {members.length === 0 && (
            <div className="text-center">
              <p className="text-lg font-bold">It's quiet here.</p>
              <p className="mt-1 text-sm text-muted">
                Join and whoever comes next can talk to you straight away.
              </p>
            </div>
          )}
          {members.map((u) => (
            <Participant key={u} userId={u} session={joined ? session : undefined} size={size} />
          ))}
        </div>
      )}
      {!joined && (
        <div className="relative flex justify-center pb-8">
          <Button className="h-12 px-8 text-[15px]" onClick={onJoin}>
            <PhoneCall size={18} /> Join room
          </Button>
        </div>
      )}
      {joined && session && session.status !== 'connected' && (
        <p className="relative pb-24 text-center text-sm font-medium text-warn">
          {session.status === 'no-host'
            ? 'Waiting for someone who can host the call…'
            : 'Connecting to the host…'}
        </p>
      )}
    </section>
  );
}
