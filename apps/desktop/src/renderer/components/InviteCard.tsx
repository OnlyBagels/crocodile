import { useEffect, useState } from 'react';
import { Check, Users } from 'lucide-react';
import type { InvitePreview } from '@crocodile/client-core';
import { getClient, navigate, useCroc } from '../croc';
import { initials } from '../lib/format';
import { Button } from './ui';

/** Join a space with an invite, then open its first text channel. */
export async function joinAndOpen(code: string) {
  const client = getClient();
  const spaceId = await client.joinWithInvite(code);
  const space = client.state.spaces[spaceId];
  navigate({
    kind: 'space',
    spaceId,
    channelId: space?.channels.find((c) => c.kind === 'text')?.id ?? null,
  });
}

/** Open a space we're in, or join it. */
export function openInvite(preview: InvitePreview) {
  const client = getClient();
  if (preview.joined) {
    const space = client.state.spaces[preview.spaceId];
    navigate({
      kind: 'space',
      spaceId: preview.spaceId,
      channelId: space?.channels.find((c) => c.kind === 'text')?.id ?? null,
    });
    return;
  }
  void joinAndOpen(preview.code).catch((e) => client.reportError(e.message));
}

const previews = new Map<string, Promise<InvitePreview | null>>();

/** An invite link in a chat, as a card: the space, and a button to join it. */
export function InviteCard({ code }: { code: string }) {
  const [preview, setPreview] = useState<InvitePreview | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    let p = previews.get(code);
    if (!p) {
      p = getClient()
        .previewInvite(code)
        .catch(() => null);
      previews.set(code, p);
      // Look again later: the space may change, or we may join it.
      setTimeout(() => previews.delete(code), 60_000);
    }
    void p.then((v) => live && setPreview(v));
    return () => {
      live = false;
    };
  }, [code]);
  const joined = useCroc((s) => !!preview && !!s.spaces[preview.spaceId]);
  if (preview === undefined)
    return (
      <div className="mt-1.5 h-[68px] w-72 animate-pulse rounded-2xl border border-line bg-field" />
    );
  if (preview === null)
    return (
      <div className="mt-1.5 w-72 rounded-2xl border border-line bg-field px-4 py-3 text-xs text-muted">
        This invite doesn't work (any more).
      </div>
    );
  const isMember = preview.joined || joined;
  return (
    <div
      aria-label={`Invite to ${preview.name}`}
      className="mt-1.5 flex w-80 max-w-full items-center gap-3 rounded-2xl border border-line bg-field p-3"
    >
      {preview.icon ? (
        <img src={preview.icon} alt="" className="h-11 w-11 rounded-xl object-cover" />
      ) : (
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft font-bold text-accent">
          {initials(preview.name)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Invite to a space
        </div>
        <div className="truncate font-bold">{preview.name}</div>
      </div>
      {isMember ? (
        <Button variant="ghost" onClick={() => openInvite({ ...preview, joined: true })}>
          <Check size={15} /> Open
        </Button>
      ) : preview.expired ? (
        <span className="text-xs text-muted">Expired</span>
      ) : (
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await joinAndOpen(preview.code);
            } catch (e) {
              getClient().reportError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Users size={15} /> Join
        </Button>
      )}
    </div>
  );
}
