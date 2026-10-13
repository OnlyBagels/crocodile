import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Download,
  ExternalLink,
  FileArchive,
  FileText,
  File as FileIcon,
  FolderDown,
  Loader2,
  Play,
  RotateCw,
  X,
} from 'lucide-react';
import type { FileView, MessageView } from '@crocodile/client-core';
import { fileMediaKind, type FileManifest } from '@crocodile/protocol';
import { getClient, useCroc } from '../croc';
import { INLINE_MAX, exportFile, formatBytes, formatDuration, objectUrlOf } from '../lib/files';
import { cx } from './ui';

/** What a file's state means for the person looking at it. */
export function fileStatusText(view: FileView | undefined): string | null {
  switch (view?.status) {
    case 'searching':
      return 'Looking for someone who has it…';
    case 'connecting':
      return 'Connecting…';
    case 'downloading':
      return `${formatBytes(view.done)} of ${formatBytes(view.size)}`;
    case 'unavailable':
      return 'Nobody who has this file is online. It downloads when someone is.';
    case 'no_direct':
      return "Can't connect directly to anyone who has it. Files never go through servers.";
    case 'failed':
      return view.error ?? 'Download failed';
    default:
      return null;
  }
}

const busy = (v?: FileView) =>
  v?.status === 'searching' || v?.status === 'connecting' || v?.status === 'downloading';

function report(err: unknown) {
  getClient().reportError(err instanceof Error ? err.message : String(err));
}

/** A file posted in a message: a picture or video in the chat, or a card. */
export function FileAttachment({ message }: { message: MessageView }) {
  const file = message.file!;
  const view = useCroc((s) => s.files[file.id]);
  const client = getClient();
  // Fetch by itself what the auto-download setting allows, once it's on screen.
  useEffect(() => {
    if (client.shouldAutoDownload(message)) void client.downloadFile(file.id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);
  const kind = fileMediaKind(file.type);
  if (kind && file.size <= INLINE_MAX) return <MediaTile file={file} kind={kind} view={view} />;
  return <FileCard file={file} view={view} />;
}

function download(id: string) {
  void getClient().downloadFile(id).catch(report);
}

function Progress({ view }: { view?: FileView }) {
  const pct = view && view.size > 0 ? Math.round((view.done / view.size) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
    >
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

function iconFor(file: FileManifest) {
  if (/zip|rar|7z|tar|gzip|compressed/.test(file.type)) return FileArchive;
  if (/^text\/|pdf|document|msword|sheet|presentation/.test(file.type)) return FileText;
  return FileIcon;
}

function FileCard({ file, view }: { file: FileManifest; view?: FileView }) {
  const Icon = iconFor(file);
  const status = fileStatusText(view);
  const done = view?.status === 'done';
  return (
    <div
      role="group"
      aria-label={`File: ${file.name}`}
      className="mt-1 flex w-[360px] max-w-full flex-col gap-2 rounded-2xl border border-line bg-island-2 p-3"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold" title={file.name}>
            {file.name}
          </div>
          <div className="text-xs text-muted">{formatBytes(file.size)}</div>
        </div>
        {done ? (
          <div className="flex gap-1">
            <CardButton label="Open" onClick={() => void exportFile(file, 'open').catch(report)}>
              <ExternalLink size={16} />
            </CardButton>
            <CardButton
              label="Save as…"
              onClick={() => void exportFile(file, 'save').catch(report)}
            >
              <FolderDown size={16} />
            </CardButton>
          </div>
        ) : busy(view) ? (
          <Loader2 size={18} className="animate-spin text-muted" aria-label="Downloading" />
        ) : (
          <CardButton
            label={view?.status === 'none' || !view ? 'Download' : 'Try again'}
            onClick={() => download(file.id)}
          >
            {view?.status === 'none' || !view ? <Download size={16} /> : <RotateCw size={16} />}
          </CardButton>
        )}
      </div>
      {view?.status === 'downloading' && <Progress view={view} />}
      {status && <div className="text-xs text-muted">{status}</div>}
    </div>
  );
}

function CardButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-full bg-raised text-text-2 transition hover:bg-hover hover:text-text"
    >
      {children}
    </button>
  );
}

/** Fits a picture or video into the chat, keeping its shape. */
function boxOf(file: FileManifest) {
  const maxW = 400;
  const maxH = 320;
  const w = file.w ?? 320;
  const h = file.h ?? 200;
  const scale = Math.min(1, maxW / w, maxH / h);
  return {
    width: Math.max(120, Math.round(w * scale)),
    height: Math.max(80, Math.round(h * scale)),
  };
}

function MediaTile({
  file,
  kind,
  view,
}: {
  file: FileManifest;
  kind: 'image' | 'video';
  view?: FileView;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const done = view?.status === 'done';
  useEffect(() => {
    if (!done) return;
    let live = true;
    objectUrlOf(file)
      .then((u) => live && setUrl(u))
      .catch(report);
    return () => {
      live = false;
    };
  }, [done, file]);
  const status = fileStatusText(view);
  const box = boxOf(file);
  const label = kind === 'image' ? `Picture: ${file.name}` : `Video: ${file.name}`;

  return (
    <div
      className="mt-1"
      role="group"
      aria-label={`${kind === 'image' ? 'Picture' : 'Video'} file: ${file.name}`}
    >
      <div
        className="relative overflow-hidden rounded-2xl border border-line bg-raised"
        style={box}
      >
        {url && kind === 'image' ? (
          <button className="block h-full w-full" onClick={() => setZoom(true)} aria-label={label}>
            <img src={url} alt={file.name} className="h-full w-full object-cover" />
          </button>
        ) : url && kind === 'video' ? (
          <video
            src={url}
            controls
            preload="metadata"
            aria-label={label}
            className="h-full w-full bg-black object-contain"
          />
        ) : (
          <>
            {file.thumb && (
              <img
                src={file.thumb}
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full scale-110 object-cover blur-xl"
              />
            )}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/25 p-4 text-center text-white">
              {busy(view) ? (
                <>
                  <Loader2 size={28} className="animate-spin" aria-label="Downloading" />
                  {view?.status === 'downloading' && (
                    <div className="w-2/3">
                      <Progress view={view} />
                    </div>
                  )}
                </>
              ) : (
                <button
                  onClick={() => download(file.id)}
                  aria-label={`${view?.status === 'none' || !view ? 'Download' : 'Try again'}: ${file.name}`}
                  className="flex items-center gap-2 rounded-full bg-black/55 px-4 py-2 text-sm font-semibold backdrop-blur hover:bg-black/70"
                >
                  {kind === 'video' ? <Play size={16} /> : <Download size={16} />}
                  {formatBytes(file.size)}
                  {kind === 'video' && file.dur !== undefined && ` · ${formatDuration(file.dur)}`}
                </button>
              )}
              {status && view?.status !== 'downloading' && (
                <span className="max-w-[90%] text-xs drop-shadow">{status}</span>
              )}
            </div>
          </>
        )}
      </div>
      {done && (
        <div className="mt-1 flex gap-3 text-xs text-muted">
          <button
            className="hover:text-text hover:underline"
            onClick={() => void exportFile(file, 'save').catch(report)}
          >
            Save as…
          </button>
          <button
            className="hover:text-text hover:underline"
            onClick={() => void exportFile(file, 'open').catch(report)}
          >
            Open
          </button>
        </div>
      )}
      {zoom && url && <Lightbox url={url} file={file} onClose={() => setZoom(false)} />}
    </div>
  );
}

function Lightbox({
  url,
  file,
  onClose,
}: {
  url: string;
  file: FileManifest;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      className="fixed inset-0 z-[60] flex flex-col bg-black/85 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="flex items-center gap-3 p-4 text-white"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="truncate font-semibold">{file.name}</span>
        <span className="text-sm text-white/60">{formatBytes(file.size)}</span>
        <button
          className="ml-auto rounded-full px-3 py-1.5 text-sm hover:bg-white/10"
          onClick={() => void exportFile(file, 'save').catch(report)}
        >
          Save as…
        </button>
        <button aria-label="Close" className="rounded-full p-2 hover:bg-white/10" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <img
          src={url}
          alt={file.name}
          className={cx('max-h-full max-w-full rounded-lg object-contain shadow-2xl')}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
    </div>,
    document.body,
  );
}
