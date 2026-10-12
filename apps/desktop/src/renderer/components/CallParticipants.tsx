import { HeadphoneOff, MicOff, Radio, Signal } from 'lucide-react';
import type { SessionView } from '@crocodile/client-core';
import { LATENCY_CLASS, latencyQuality } from '../lib/call';
import { Avatar, UserName, cx } from './ui';

/** One person on a call stage: avatar with speaking ripples, mute state, host mark, latency. */
export function Participant({
  userId,
  session,
  size,
  away,
}: {
  userId: string;
  session?: SessionView;
  size: number;
  /** Not in the call (yet): shown faded with this caption. */
  away?: string;
}) {
  const speaking = !!session?.speaking.includes(userId);
  const muted = session?.muted.includes(userId);
  const deaf = session?.deafened.includes(userId);
  const isHost = session?.host === userId;
  return (
    <div className={cx('flex flex-col items-center gap-3', away && 'opacity-50')}>
      <div className="relative">
        <Avatar userId={userId} size={size} speaking={speaking && !away} round />
        {!away && (muted || deaf) && (
          <span className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full border-2 border-[var(--island)] bg-danger text-white">
            {deaf ? <HeadphoneOff size={14} /> : <MicOff size={14} />}
          </span>
        )}
      </div>
      <div
        className={cx(
          'flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold',
          speaking && !away ? 'bg-accent-soft text-accent' : 'text-text-2',
        )}
      >
        <UserName userId={userId} />
        {isHost && !away && (
          <span title="This member's device relays the call's encrypted audio">
            <Radio size={13} className="text-accent" />
          </span>
        )}
      </div>
      {away ? (
        <span className="-mt-2 text-xs text-muted">{away}</span>
      ) : (
        session && <Latency userId={userId} session={session} />
      )}
    </div>
  );
}

/** "host", or this member's live round trip to the host. */
export function Latency({ userId, session }: { userId: string; session: SessionView }) {
  if (session.host === userId)
    return <span className="-mt-2 text-xs text-muted">hosting the call</span>;
  const ms = session.latency[userId];
  if (ms === undefined) return <span className="-mt-2 text-xs text-faint">measuring…</span>;
  const quality = latencyQuality(ms);
  return (
    <span
      className={cx('-mt-2 flex items-center gap-1 text-xs font-medium', LATENCY_CLASS[quality])}
      title="Round trip to the host's device, measured every few seconds"
      aria-label={`Latency to the host: ${ms} ms`}
    >
      <Signal size={12} /> {ms} ms
    </span>
  );
}
