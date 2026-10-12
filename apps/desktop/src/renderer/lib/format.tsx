import type { ReactNode } from 'react';
import { desktop } from '../platform';
import { getClient, openModal, useCroc } from '../croc';
import { cx } from '../components/ui';
import { plainText, tokenize } from './markup';

export function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dayOf(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

export function stampOf(ts: number) {
  const day = dayOf(ts);
  return day === 'Today'
    ? `Today at ${timeOf(ts)}`
    : day === 'Yesterday'
      ? `Yesterday at ${timeOf(ts)}`
      : `${day} ${timeOf(ts)}`;
}

export function openLink(url: string) {
  if (desktop) void desktop.app.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

/**
 * Safe message formatting (see markup.ts): code, emphasis, links, invite
 * links and mentions. Produces React nodes; never HTML.
 */
export function renderMessage(text: string, opts: { me?: string } = {}): ReactNode[] {
  return tokenize(text).map((tok, i) => {
    const k = `t${i}`;
    switch (tok.t) {
      case 'text':
        return tok.v;
      case 'block':
        return (
          <pre
            key={k}
            className="selectable my-1 overflow-x-auto rounded-xl border border-line bg-field p-3 font-mono text-[13px]"
          >
            {tok.v}
          </pre>
        );
      case 'code':
        return (
          <code key={k} className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[13px]">
            {tok.v}
          </code>
        );
      case 'bold':
        return <strong key={k}>{tok.v}</strong>;
      case 'italic':
        return <em key={k}>{tok.v}</em>;
      case 'strike':
        return <s key={k}>{tok.v}</s>;
      case 'mention':
        return <Mention key={k} userId={tok.user} me={tok.user === opts.me} />;
      case 'invite':
      case 'link':
        return (
          <a
            key={k}
            className="font-semibold text-accent underline-offset-2 hover:underline"
            href={tok.t === 'link' ? tok.href : tok.v}
            title={tok.t === 'link' ? tok.href : 'Invite to a space'}
            onClick={(e) => {
              e.preventDefault();
              if (tok.t === 'link') openLink(tok.href);
              else onInviteLink?.(tok.code);
            }}
          >
            {tok.v}
          </a>
        );
    }
  });
}

/** A message as plain text, mentions as @names: for quotes, notifications and copying. */
export function plain(text: string): string {
  const profiles = getClient().state.profiles;
  return plainText(text, (id) => profiles[id]?.username ?? 'someone');
}

/** What clicking an invite link does (set by the app: ask to join). */
let onInviteLink: ((code: string) => void) | undefined;
export function setInviteLinkHandler(fn: (code: string) => void) {
  onInviteLink = fn;
}

function Mention({ userId, me }: { userId: string; me: boolean }) {
  const name = useCroc((s) => s.profiles[userId]?.username ?? 'someone');
  return (
    <button
      className={cx(
        'rounded-md px-1 font-semibold',
        me ? 'bg-accent text-on-accent' : 'bg-accent-soft text-accent hover:underline',
      )}
      onClick={() => openModal({ kind: 'profile', userId })}
    >
      @{name}
    </button>
  );
}

const PALETTE = [
  '#5865f2',
  '#3ba55d',
  '#faa61a',
  '#ed4245',
  '#eb459e',
  '#2fa56f',
  '#9b59b6',
  '#1abc9c',
  '#e67e22',
];

export function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Downscale a user-picked image to a small square data URL for avatars/icons. */
export async function imageToDataUrl(file: File, size = 256): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL('image/webp', 0.85);
}

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text).catch(() => {});
}

/** Human label for a push-to-talk binding (a KeyboardEvent.code or Mouse4/Mouse5). */
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/** A Ctrl shortcut as people on this system write it: "⌘K" on a Mac, "Ctrl K" elsewhere. */
export function shortcutLabel(key: string) {
  return isMac ? `⌘${key}` : `Ctrl ${key}`;
}

export function keyLabel(code: string) {
  if (code === 'Mouse4') return 'Mouse back';
  if (code === 'Mouse5') return 'Mouse forward';
  if (code === 'Backquote') return '`';
  return code
    .replace(/^Key|^Digit/, '')
    .replace(/Left$/, '')
    .replace(/Right$/, ' (right)')
    .replace(/^Control/, 'Ctrl');
}
