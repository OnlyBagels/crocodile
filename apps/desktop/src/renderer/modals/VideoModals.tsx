import { useEffect, useRef, useState } from 'react';
import { AppWindow, Monitor, ScreenShare, Video } from 'lucide-react';
import type { ScreenQuality } from '@crocodile/client-core';
import type { ScreenSource, ScreenSources } from '../../main/ipc-types';
import { closeModal, getClient } from '../croc';
import { desktop } from '../platform';
import { Button, Modal, Select, Toggle, cx } from '../components/ui';

function report(err: unknown) {
  getClient().reportError(err instanceof Error ? err.message : String(err));
}

/** Turning the camera on: see yourself first, pick the camera, then show it. */
export function CameraModal() {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let live = true;
    navigator.mediaDevices
      .getUserMedia({
        video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: 1280, height: 720 },
      })
      .then(async (s) => {
        if (!live) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        setError(null);
        if (video.current) video.current.srcObject = s;
        const all = await navigator.mediaDevices.enumerateDevices();
        if (live) setCameras(all.filter((d) => d.kind === 'videoinput'));
      })
      .catch((err: { name?: string; message?: string }) => {
        if (!live) return;
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera access was denied. Allow it in your system settings.'
            : err.name === 'NotFoundError'
              ? 'No camera found.'
              : `Could not open the camera: ${err.message ?? err}`,
        );
      });
    return () => {
      live = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId]);
  const start = async () => {
    setBusy(true);
    try {
      // The preview lets go of the camera first (closing the modal does).
      closeModal();
      await getClient().setCamera(true, deviceId);
    } catch (err) {
      report(err);
    }
  };
  return (
    <Modal
      title="Camera"
      subtitle="Only you see this until you turn it on."
      icon={<Video size={20} />}
      onClose={closeModal}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={!!error || busy}>
            <Video size={16} /> Turn camera on
          </Button>
        </>
      }
    >
      <div className="relative aspect-video overflow-hidden rounded-2xl border border-line bg-black">
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          aria-label="Camera preview"
          className="h-full w-full -scale-x-100 object-cover"
        />
        {error && (
          <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white">
            {error}
          </p>
        )}
      </div>
      {cameras.length > 1 && (
        <label className="mt-4 flex items-center gap-3 text-sm font-semibold">
          Camera
          <Select value={deviceId ?? cameras[0]?.deviceId ?? ''} onChange={(v) => setDeviceId(v)}>
            {cameras.map((c, i) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label || `Camera ${i + 1}`}
              </option>
            ))}
          </Select>
        </label>
      )}
      <p className="mt-4 text-xs text-muted">
        Your video goes to the people in this call, end-to-end encrypted, through the device of the
        member who hosts the call.
      </p>
    </Modal>
  );
}

const QUALITY: Record<ScreenQuality, { title: string; text: string }> = {
  text: { title: 'Text and slides', text: 'Sharp, up to 1080p, a few frames a second' },
  motion: { title: 'Motion', text: 'Smooth video and games, 720p, 30 frames a second' },
};

/** Picking what to share: a screen or a window, how it should look, and its sound. */
export function ShareScreenModal() {
  const [info, setInfo] = useState<ScreenSources | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [quality, setQuality] = useState<ScreenQuality>('text');
  const [audio, setAudio] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void desktop.screen
      .sources()
      .then((s) => {
        if (!live) return;
        setInfo(s);
        setChosen(s.sources.find((x) => x.kind === 'screen')?.id ?? s.sources[0]?.id ?? null);
      })
      .catch(report);
    return () => {
      live = false;
    };
  }, []);
  const share = async () => {
    try {
      closeModal();
      await getClient().shareScreen({
        ...(chosen ? { sourceId: chosen } : {}),
        quality,
        audio: audio && !!info?.canShareSound,
      });
    } catch (err) {
      report(err);
    }
  };
  const screens = info?.sources.filter((s) => s.kind === 'screen') ?? [];
  const windows = info?.sources.filter((s) => s.kind === 'window') ?? [];
  const denied = info?.access === 'denied' || info?.access === 'restricted';
  return (
    <Modal
      title="Share your screen"
      subtitle="Members of this call can choose to watch it."
      icon={<ScreenShare size={20} />}
      onClose={closeModal}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={() => void share()} disabled={!!desktop && (!chosen || denied)}>
            <ScreenShare size={16} /> Share
          </Button>
        </>
      }
    >
      {denied && (
        <p className="mb-4 rounded-xl bg-danger/10 p-3 text-sm text-danger">
          Crocodile isn't allowed to record your screen. Allow it in System Settings → Privacy &
          Security → Screen Recording, then open Crocodile again.
        </p>
      )}
      {desktop && !info && <p className="text-sm text-muted">Looking for screens and windows…</p>}
      {screens.length > 0 && (
        <SourceGrid title="Screens" sources={screens} chosen={chosen} onChoose={setChosen} />
      )}
      {windows.length > 0 && (
        <SourceGrid title="Windows" sources={windows} chosen={chosen} onChoose={setChosen} />
      )}
      <fieldset className="mt-4">
        <legend className="mb-2 text-sm font-semibold">Quality</legend>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(QUALITY) as ScreenQuality[]).map((q) => (
            <label
              key={q}
              className={cx(
                'cursor-pointer rounded-xl border p-3 text-sm',
                quality === q ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover',
              )}
            >
              <input
                type="radio"
                name="quality"
                className="sr-only"
                checked={quality === q}
                onChange={() => setQuality(q)}
              />
              <span className="block font-semibold">{QUALITY[q].title}</span>
              <span className="text-xs text-muted">{QUALITY[q].text}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-semibold">Share sound</div>
          <div className="text-xs text-muted">
            {info?.canShareSound
              ? 'What your computer plays goes with the picture.'
              : 'Sharing sound works on Windows only for now.'}
          </div>
        </div>
        <Toggle
          checked={audio && !!info?.canShareSound}
          onChange={(v) => setAudio(v)}
          label="Share sound"
          disabled={!info?.canShareSound}
        />
      </div>
    </Modal>
  );
}

function SourceGrid({
  title,
  sources,
  chosen,
  onChoose,
}: {
  title: string;
  sources: ScreenSource[];
  chosen: string | null;
  onChoose: (id: string) => void;
}) {
  return (
    <section aria-label={title} className="mb-4">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{title}</h3>
      <div className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto">
        {sources.map((s) => (
          <button
            key={s.id}
            aria-pressed={chosen === s.id}
            onClick={() => onChoose(s.id)}
            className={cx(
              'flex flex-col gap-1.5 rounded-xl border p-2 text-left text-xs',
              chosen === s.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover',
            )}
          >
            <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-black/40">
              {s.thumbnail ? (
                <img src={s.thumbnail} alt="" className="h-full w-full object-contain" />
              ) : s.kind === 'screen' ? (
                <Monitor size={22} />
              ) : (
                <AppWindow size={22} />
              )}
            </div>
            <span className="flex items-center gap-1.5 truncate font-semibold">
              {s.icon && <img src={s.icon} alt="" className="h-3.5 w-3.5" />}
              <span className="truncate">{s.name}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
