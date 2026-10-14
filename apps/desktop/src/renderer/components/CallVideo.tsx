import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  Eye,
  EyeOff,
  Loader2,
  Maximize2,
  Minimize2,
  MicOff,
  MonitorUp,
  PauseCircle,
  PictureInPicture2,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import type { SessionView, VideoStreamView } from '@crocodile/client-core';
import { getClient, openModal, useCroc } from '../croc';
import { Avatar, Button, IconButton, UserName, cx } from './ui';

/** Why video can't be used in a call, in words. */
export const VIDEO_BLOCKED_TEXT = {
  relayed: 'Video is off while your call goes through a server relay: servers carry voice only.',
  'old-host': "The host's Crocodile is too old for video. Video works once they update.",
} as const;

function report(err: unknown) {
  getClient().reportError(err instanceof Error ? err.message : String(err));
}

/** Plays a camera or screen: ours from the local preview, others' as the host sends them. */
export function VideoView({
  sessionId,
  stream,
  fit = 'cover',
  videoRef,
  label,
}: {
  sessionId: string;
  stream: VideoStreamView;
  fit?: 'cover' | 'contain';
  videoRef?: RefObject<HTMLVideoElement | null>;
  label?: string;
}) {
  const own = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? own;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const client = getClient();
    const media = stream.mine
      ? client.localVideo(stream.kind)
      : client.videoStream(sessionId, stream.id);
    if (el.srcObject !== media) el.srcObject = media;
    if (media) void el.play().catch(() => {});
  }, [ref, sessionId, stream.id, stream.kind, stream.mine, stream.state]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      aria-label={label}
      className={cx(
        'h-full w-full bg-black',
        fit === 'contain' ? 'object-contain' : 'object-cover',
        // Our own camera as in a mirror, the way people expect to see themselves.
        stream.mine && stream.kind === 'camera' && '-scale-x-100',
      )}
    />
  );
}

/** Camera and screen buttons for the call controls. */
export function VideoButtons({ sessionId }: { sessionId: string }) {
  const video = useCroc((s) => s.sessions[sessionId]?.video);
  const camera = useCroc((s) => s.camera);
  const sharing = useCroc((s) => !!s.screenShare);
  const client = getClient();
  const why = video?.blocked
    ? VIDEO_BLOCKED_TEXT[video.blocked]
    : !video?.ready
      ? 'Video is getting ready…'
      : undefined;
  const canShare = !!client.voiceEngine?.canShareScreen;
  return (
    <>
      <IconButton
        label={camera ? 'Turn camera off' : 'Turn camera on'}
        active={camera}
        disabled={!camera && !!why}
        title={!camera ? why : undefined}
        onClick={() => (camera ? void client.setCamera(false) : openModal({ kind: 'camera' }))}
      >
        {camera ? <Video size={18} /> : <VideoOff size={18} />}
      </IconButton>
      {canShare && (
        <IconButton
          label={sharing ? 'Stop sharing your screen' : 'Share your screen'}
          active={sharing}
          disabled={!sharing && !!why}
          title={!sharing ? why : undefined}
          onClick={() => (sharing ? client.stopScreenShare() : openModal({ kind: 'share-screen' }))}
        >
          {sharing ? <ScreenShareOff size={18} /> : <ScreenShare size={18} />}
        </IconButton>
      )}
    </>
  );
}

/**
 * The video side of a call: the screen being watched, large; screens on
 * offer; and a tile per member, their camera or their avatar (a strip of
 * small ones under a watched screen). Nothing when nobody shows anything.
 * `fill`: the call has the whole pane (a voice room), not a stage above a chat.
 */
export function CallVideo({
  sessionId,
  members,
  fill,
}: {
  sessionId: string;
  members: string[];
  fill?: boolean;
}) {
  const session = useCroc((s) => s.sessions[sessionId]);
  const joined = useCroc((s) => s.voiceSession === sessionId);
  if (!session || !joined) return null;
  const { streams, blocked } = session.video;
  if (streams.length === 0) return null;
  if (blocked)
    return (
      <p className="mx-auto max-w-md px-6 py-4 text-center text-sm font-medium text-warn">
        {VIDEO_BLOCKED_TEXT[blocked]}
      </p>
    );
  const screens = streams.filter((s) => s.kind === 'screen');
  const watched = screens.filter((s) => !s.mine && s.state !== 'off');
  const offered = screens.filter((s) => !s.mine && s.state === 'off');
  const mine = screens.find((s) => s.mine);
  const cameras = new Map(
    streams.filter((s) => s.kind === 'camera').map((s) => [s.userId, s] as const),
  );
  const tiles = members.length;
  const cols = tiles <= 1 ? 1 : tiles <= 4 ? 2 : tiles <= 9 ? 3 : 4;
  return (
    <section aria-label="Video" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      {watched.map((s) => (
        <ScreenStage
          key={s.id}
          sessionId={sessionId}
          stream={s}
          maxHeight={fill ? `${62 / watched.length}vh` : '30vh'}
        />
      ))}
      {(mine || offered.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {mine && <MySharing stream={mine} sessionId={sessionId} />}
          {offered.map((s) => (
            <ScreenOffer key={s.id} sessionId={sessionId} stream={s} />
          ))}
        </div>
      )}
      <div
        className={
          watched.length ? 'flex flex-wrap justify-center gap-2' : 'mx-auto grid w-full gap-3'
        }
        style={
          watched.length
            ? undefined
            : { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, maxWidth: 1100 }
        }
      >
        {members.map((u) => {
          const cam = cameras.get(u);
          const small = watched.length > 0;
          return cam ? (
            <CameraTile
              key={u}
              sessionId={sessionId}
              stream={cam}
              session={session}
              small={small}
            />
          ) : (
            <AvatarTile key={u} userId={u} session={session} small={small} />
          );
        })}
      </div>
    </section>
  );
}

const tileClass = (speaking: boolean, small?: boolean) =>
  cx(
    'relative aspect-video overflow-hidden border border-line bg-raised',
    small ? 'h-24 shrink-0 rounded-xl' : 'rounded-2xl',
    speaking && 'outline outline-2 outline-offset-2 outline-[var(--accent)]',
  );

function NameTag({
  userId,
  session,
  mine,
}: {
  userId: string;
  session: SessionView;
  mine?: boolean;
}) {
  const muted = session.muted.includes(userId);
  return (
    <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white">
      {muted && <MicOff size={12} aria-label="Muted" />}
      <UserName userId={userId} />
      {mine && <span className="font-normal opacity-75">(you)</span>}
    </span>
  );
}

function CameraTile({
  sessionId,
  stream,
  session,
  small,
}: {
  sessionId: string;
  stream: VideoStreamView;
  session: SessionView;
  small?: boolean;
}) {
  const name = useCroc((s) => s.profiles[stream.userId]?.username ?? 'Someone');
  return (
    <div
      role="group"
      aria-label={`${stream.mine ? 'Your' : `${name}'s`} camera`}
      className={tileClass(session.speaking.includes(stream.userId), small)}
    >
      {stream.state === 'live' ? (
        <VideoView sessionId={sessionId} stream={stream} label={`Camera: ${name}`} />
      ) : (
        <Waiting stream={stream} />
      )}
      <NameTag userId={stream.userId} session={session} mine={stream.mine} />
    </div>
  );
}

function AvatarTile({
  userId,
  session,
  small,
}: {
  userId: string;
  session: SessionView;
  small?: boolean;
}) {
  const speaking = session.speaking.includes(userId);
  return (
    <div className={cx(tileClass(speaking, small), 'flex items-center justify-center')}>
      <Avatar userId={userId} size={small ? 36 : 72} round speaking={speaking} />
      <NameTag userId={userId} session={session} />
    </div>
  );
}

/** A camera or screen asked for that isn't playing yet, or that the host held back. */
function Waiting({ stream }: { stream: VideoStreamView }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted">
      {stream.state === 'paused' ? (
        <>
          <PauseCircle size={26} />
          <span>Paused: the host's connection is full. It resumes when there's room.</span>
        </>
      ) : (
        <>
          <Loader2 size={24} className="animate-spin" />
          <span>Connecting video…</span>
        </>
      )}
    </div>
  );
}

function ScreenOffer({ sessionId, stream }: { sessionId: string; stream: VideoStreamView }) {
  const name = useCroc((s) => s.profiles[stream.userId]?.username ?? 'Someone');
  return (
    <div
      role="group"
      aria-label={`${name}'s screen`}
      className="flex items-center gap-3 rounded-2xl border border-line bg-raised py-2 pl-3 pr-2"
    >
      <MonitorUp size={18} className="text-accent" />
      <span className="text-sm">
        <strong>{name}</strong> is sharing their screen
        {stream.audio && (
          <span className="text-muted">
            {' '}
            with sound <Volume2 size={12} className="inline" />
          </span>
        )}
      </span>
      <Button
        variant="soft"
        className="h-8 px-3 text-xs"
        aria-label={`Watch ${name}'s screen`}
        onClick={() => getClient().watchScreen(sessionId, stream.id, true)}
      >
        <Eye size={14} /> Watch
      </Button>
    </div>
  );
}

function MySharing({ stream, sessionId }: { stream: VideoStreamView; sessionId: string }) {
  return (
    <div
      role="group"
      aria-label="Your screen"
      className="flex items-center gap-3 rounded-2xl border border-accent/40 bg-accent-soft py-2 pl-2 pr-2"
    >
      <div className="h-10 w-16 overflow-hidden rounded-lg">
        <VideoView sessionId={sessionId} stream={stream} label="Your shared screen" />
      </div>
      <span className="text-sm font-semibold text-accent">You're sharing your screen</span>
      <Button
        variant="secondary"
        className="h-8 px-3 text-xs"
        onClick={() => getClient().stopScreenShare()}
      >
        <ScreenShareOff size={14} /> Stop sharing
      </Button>
    </div>
  );
}

/** A screen being watched: large, with full screen and a pop-out window. */
function ScreenStage({
  sessionId,
  stream,
  maxHeight,
}: {
  sessionId: string;
  stream: VideoStreamView;
  /** As tall as this at most (a CSS length); as wide as fits. */
  maxHeight: string;
}) {
  const name = useCroc((s) => s.profiles[stream.userId]?.username ?? 'Someone');
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const client = getClient();
  const popOut = () => {
    const el = video.current as
      (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    void el?.requestPictureInPicture?.().catch(report);
  };
  const [full, setFull] = useState(false);
  useEffect(() => {
    const onChange = () => setFull(!!box.current && document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFull = () =>
    void (full ? document.exitFullscreen() : box.current?.requestFullscreen())?.catch(report);
  return (
    <div
      role="group"
      aria-label={`Watching ${name}'s screen`}
      ref={box}
      className="group relative mx-auto aspect-video shrink-0 overflow-hidden rounded-2xl border border-line bg-black [&:fullscreen]:rounded-none [&:fullscreen]:border-0"
      style={{ width: `min(100%, calc(${maxHeight} * 16 / 9))` }}
    >
      {stream.state === 'live' ? (
        <VideoView
          sessionId={sessionId}
          stream={stream}
          fit="contain"
          videoRef={video}
          label={`Screen: ${name}`}
        />
      ) : (
        <Waiting stream={stream} />
      )}
      <div className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 py-2 text-white opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
        <MonitorUp size={16} />
        <span className="flex-1 truncate text-sm font-semibold">{name}'s screen</span>
        <IconButton label="Pop out" className="text-white hover:bg-white/15" onClick={popOut}>
          <PictureInPicture2 size={16} />
        </IconButton>
        <IconButton
          label={full ? 'Exit full screen' : 'Full screen'}
          className="text-white hover:bg-white/15"
          onClick={toggleFull}
        >
          {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </IconButton>
        <IconButton
          label="Stop watching"
          className="text-white hover:bg-white/15"
          onClick={() => client.watchScreen(sessionId, stream.id, false)}
        >
          <EyeOff size={16} />
        </IconButton>
      </div>
    </div>
  );
}
