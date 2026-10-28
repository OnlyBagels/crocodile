import { ConnectionModal } from './modals/ConnectionModals';
import { useEffect, useState } from 'react';
import { Phone, PhoneOff, Server, Video, Wifi, WifiOff } from 'lucide-react';
import { sessionIds } from '@crocodile/protocol';
import {
  closeModal,
  getClient,
  navigate,
  openModal,
  pendingRequests,
  playSound,
  sounds,
  ui,
  useCroc,
  useUi,
} from './croc';
import { messageSound } from './lib/sounds';
import { desktop } from './platform';
import { Onboarding } from './components/Onboarding';
import { TopBar } from './components/TopBar';
import { DetailsPanel, HomeSidebar, SpaceSidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { RoomStage } from './components/RoomStage';
import { PeopleView } from './components/PeopleView';
import { CallDock } from './components/CallDock';
import { CommandPalette } from './components/CommandPalette';
import { joinAndOpen, openInvite } from './components/InviteCard';
import { plain, setInviteLinkHandler } from './lib/format';
import { mentionsIn } from './lib/markup';
import { Avatar, Button, Toasts, UserName } from './components/ui';
import { CrocMark, Logo } from './components/Logo';
import { NETWORK_TEXT } from './lib/network';
import {
  AddSpaceModal,
  CreateChannelModal,
  InviteModal,
  SpaceSettingsModal,
} from './modals/SpaceModals';
import { ConfirmModal, NewDmModal, ProfileModal } from './modals/UserModals';
import { LinkDeviceModal } from './modals/DeviceModals';
import { SettingsModal } from './modals/Settings';
import { CameraModal, ShareScreenModal } from './modals/VideoModals';

export function App() {
  const phase = useCroc((s) => s.phase);
  if (phase === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Logo size={72} className="animate-pulse" />
        <span className="text-sm text-muted">Starting Crocodile…</span>
      </div>
    );
  }
  if (phase === 'onboarding') return <Onboarding />;
  return <Shell />;
}

function Shell() {
  useGlobalBehaviours();
  useSounds();
  const view = useUi((s) => s.view);
  const showMembers = useUi((s) => s.showMembers);
  const spaces = useCroc((s) => s.spaces);
  const me = useCroc((s) => s.me?.userId);
  const profiles = useCroc((s) => s.profiles);
  const inCall = useCroc((s) => !!s.voiceSession);

  // If the space we were looking at disappears (left, banned, deleted) go home.
  useEffect(() => {
    if (view.kind === 'space' && !spaces[view.spaceId]) {
      const t = setTimeout(() => {
        if (!getClient().state.spaces[view.spaceId]) navigate({ kind: 'friends' });
      }, 3000);
      return () => clearTimeout(t);
    }
  }, [view, spaces]);

  let sidebar: React.ReactNode;
  let main: React.ReactNode;
  let details: React.ReactNode = null;

  if (view.kind === 'space') {
    const space = spaces[view.spaceId];
    const channel = space?.channels.find((c) => c.id === view.channelId);
    sidebar = <SpaceSidebar spaceId={view.spaceId} />;
    if (!space) main = <div className="island flex-1" />;
    else if (!channel) main = <EmptyState title={space.name} text="Pick a channel or a room." />;
    else if (channel.kind === 'voice') {
      const client = getClient();
      main = (
        <RoomStage
          sessionId={sessionIds.voice(space.id, channel.id)}
          title={channel.name}
          onJoin={() =>
            void client.joinVoice(space.id, channel.id).catch((e) => client.reportError(e.message))
          }
        />
      );
    } else {
      main = (
        <ChatView channel={channel.id} title={channel.name} topic={channel.topic} kind="channel" />
      );
      if (showMembers) details = <DetailsPanel spaceId={space.id} />;
    }
  } else if (view.kind === 'dm' && me) {
    sidebar = <HomeSidebar />;
    main = (
      <ChatView
        channel={sessionIds.dm(me, view.userId)}
        title={profiles[view.userId]?.username ?? 'Conversation'}
        kind="dm"
        otherUserId={view.userId}
      />
    );
  } else {
    sidebar = <HomeSidebar />;
    main = <PeopleView />;
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <NoServerBanner />
      <div className={`flex min-h-0 flex-1 gap-2.5 px-2.5 ${inCall ? 'pb-[84px]' : 'pb-2.5'}`}>
        {sidebar}
        {main}
        {details}
      </div>
      <CallDock />
      <Modals />
      <CommandPalette />
      <CallPrompts />
      <Toasts />
    </div>
  );
}

/** Shown when no coordination server can be reached for a while. */
function NoServerBanner() {
  const link = useCroc((s) => s.link);
  const [late, setLate] = useState(false);
  const [url, setUrl] = useState('');
  const client = getClient();
  useEffect(() => {
    setLate(false);
    if (link === 'connected') return;
    const t = setTimeout(() => setLate(true), 8000);
    return () => clearTimeout(t);
  }, [link]);
  if (link === 'connected' || !late) return null;
  const add = () => {
    let clean = url.trim().replace(/\/$/, '');
    if (!clean) return;
    if (!/^https?:\/\//.test(clean)) clean = `http://${clean}`;
    if (!/:\d+$/.test(new URL(clean).host) && clean.startsWith('http://')) clean += ':7443';
    void client.updateSettings({
      preferredServers: [...new Set([clean, ...client.state.settings.preferredServers])],
    });
    setUrl('');
  };
  return (
    <div className="island rise mx-2.5 mb-2.5 flex flex-wrap items-center gap-3 px-4 py-3">
      <WifiOff size={18} className="text-warn" />
      <div className="min-w-[220px] flex-1 text-sm">
        <div className="font-bold">Can't reach a coordination server</div>
        <div className="text-muted">
          Enter the address of a server a friend runs, or host one on this computer.
        </div>
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="192.168.1.20:7443 or https://…"
          aria-label="Server address"
          className="selectable h-9 w-64 rounded-full border border-line bg-field px-4 text-sm outline-none focus:border-accent"
        />
        <Button type="submit" className="h-9">
          Connect
        </Button>
      </form>
      <Button
        variant="secondary"
        className="h-9"
        onClick={() => openModal({ kind: 'settings', tab: 'host' })}
      >
        <Server size={15} /> Host one here
      </Button>
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="island flex flex-1 flex-col items-center justify-center text-center">
      <CrocMark size={64} className="text-accent" />
      <h2 className="mt-4 text-xl font-bold">{title}</h2>
      <p className="mt-1 text-muted">{text}</p>
    </div>
  );
}

function Modals() {
  const modal = useUi((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'add-space':
      return <AddSpaceModal />;
    case 'invite':
      return <InviteModal spaceId={modal.spaceId} />;
    case 'create-channel':
      return <CreateChannelModal spaceId={modal.spaceId} />;
    case 'space-settings':
      return <SpaceSettingsModal spaceId={modal.spaceId} />;
    case 'settings':
      return <SettingsModal tab={modal.tab} />;
    case 'profile':
      return <ProfileModal userId={modal.userId} />;
    case 'new-dm':
      return <NewDmModal />;
    case 'link-device':
      return <LinkDeviceModal />;
    case 'confirm':
      return <ConfirmModal {...modal} />;
    case 'connection':
      return <ConnectionModal sessionId={modal.sessionId} />;
    case 'camera':
      return <CameraModal />;
    case 'share-screen':
      return <ShareScreenModal />;
  }
}

function CallPrompts() {
  const incoming = useCroc((s) => s.incomingCall);
  const outgoing = useCroc((s) => s.outgoingCall);
  const view = useUi((s) => s.view);
  const me = useCroc((s) => s.me?.userId);
  const relayEnded = useCroc((s) => s.relayEnded);
  const trouble = useCroc((s) => s.connectionTrouble);
  const network = useCroc((s) => s.network);
  const relayOn = useCroc((s) => s.settings.allowServerRelay);
  const [noticeSeen, setNoticeSeen] = useState(() => {
    try {
      return localStorage.getItem('croc.networkNotice') ?? '';
    } catch {
      return '';
    }
  });
  const client = getClient();
  if (incoming) {
    return (
      <div className="island rise fixed right-5 top-20 z-[55] w-80 rounded-3xl p-6 text-center">
        <div className="mx-auto w-fit">
          <Avatar userId={incoming.from} size={84} round speaking />
        </div>
        <div className="mt-4 text-lg font-bold">
          <UserName userId={incoming.from} />
        </div>
        <div className="text-sm text-muted">
          {incoming.video ? 'is video calling you' : 'is calling you'}
        </div>
        <div className="mt-5 flex justify-center gap-6">
          <button
            aria-label="Decline"
            title="Decline"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-danger text-white hover:brightness-110"
            onClick={() => client.declineCall()}
          >
            <PhoneOff size={22} />
          </button>
          <button
            aria-label="Accept"
            title="Accept"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-on-accent hover:brightness-110"
            onClick={() => {
              navigate({ kind: 'dm', userId: incoming.from });
              void client.callDm(incoming.from).catch((e) => client.reportError(e.message));
            }}
          >
            <Phone size={22} />
          </button>
          <button
            aria-label="Accept with video"
            title="Accept with video"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-on-accent hover:brightness-110"
            onClick={() => {
              navigate({ kind: 'dm', userId: incoming.from });
              void client
                .callDm(incoming.from, { video: true })
                .catch((e) => client.reportError(e.message));
            }}
          >
            <Video size={22} />
          </button>
        </div>
      </div>
    );
  }
  if (trouble) {
    return (
      <section
        aria-label="Can't connect directly"
        className="island rise fixed right-5 top-20 z-[55] w-96 rounded-3xl p-5"
      >
        <div className="flex items-center gap-2 font-bold">
          <WifiOff size={18} className="text-warn" />
          {trouble.with ? (
            <span>
              Can't connect to <UserName userId={trouble.with} /> directly
            </span>
          ) : (
            "Can't connect directly"
          )}
        </div>
        <p className="mt-2 text-sm text-muted">
          Your network or theirs blocks a direct connection. Relay through a coordination server?
          Voice and messages stay end-to-end encrypted; the server sees only their size and timing,
          and only while a direct connection doesn't work.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => openModal({ kind: 'connection', sessionId: trouble.sessionId })}
          >
            Details
          </Button>
          <Button variant="ghost" onClick={() => client.dismissConnectionTrouble()}>
            Not now
          </Button>
          <Button onClick={() => void client.useRelay(trouble.sessionId)}>Use the relay</Button>
        </div>
      </section>
    );
  }
  if (relayEnded) {
    return (
      <div className="island rise fixed right-5 top-20 z-[55] w-96 rounded-3xl p-5">
        <div className="flex items-center gap-2 font-bold">
          <Server size={18} className="text-warn" /> The relay stopped
        </div>
        <p className="mt-2 text-sm text-muted">
          Your connection went through a volunteer coordination server because no direct path
          worked, and the server ended it ({relayEnded.reason}). Connect through the relay again?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => client.dismissRelayNotice()}>
            Not now
          </Button>
          <Button onClick={() => void client.extendRelay(relayEnded.sessionId)}>Reconnect</Button>
        </div>
      </div>
    );
  }
  // Looking at the DM, its call stage already shows the ringing (and Cancel).
  const onStage =
    !!outgoing &&
    view.kind === 'dm' &&
    !!me &&
    sessionIds.dm(me, view.userId) === outgoing.sessionId;
  if (outgoing && !onStage) {
    return (
      <div className="island rise fixed right-5 top-20 z-[55] flex items-center gap-3 rounded-full py-2 pl-2 pr-3">
        <Avatar userId={outgoing.to} size={36} round speaking />
        <div className="text-sm font-semibold">
          Calling <UserName userId={outgoing.to} />…
        </div>
        <button
          aria-label="Hang up"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-danger text-white"
          onClick={() => void client.leaveVoice()}
        >
          <PhoneOff size={16} />
        </button>
      </div>
    );
  }
  // At launch: the network check found direct connections limited and the relay is off.
  const verdict = network?.verdict;
  if (
    !relayOn &&
    network?.checkedAt &&
    (verdict === 'limited' || verdict === 'blocked') &&
    noticeSeen !== verdict
  ) {
    const seen = () => {
      setNoticeSeen(verdict);
      try {
        localStorage.setItem('croc.networkNotice', verdict);
      } catch {
        // Shown again next time; harmless.
      }
    };
    return (
      <section
        aria-label="Network check"
        className="island rise fixed right-5 top-20 z-[55] w-96 rounded-3xl p-5"
      >
        <div className="flex items-center gap-2 font-bold">
          <Wifi size={18} className="text-warn" /> {NETWORK_TEXT[verdict].title}
        </div>
        <p className="mt-2 text-sm text-muted">{NETWORK_TEXT[verdict].detail}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={seen}>
            Not now
          </Button>
          <Button
            onClick={() => {
              seen();
              void client.updateSettings({ allowServerRelay: true });
            }}
          >
            Turn on the relay
          </Button>
        </div>
      </section>
    );
  }
  return null;
}

/** Ringing, call and message sounds. */
function useSounds() {
  const client = getClient();
  const ringingIn = useCroc((s) => !!s.incomingCall);
  const ringingOut = useCroc(
    (s) => !!s.voiceSession && s.outgoingCall?.sessionId === s.voiceSession,
  );
  const enabled = useUi((s) => s.sounds.enabled);
  const busy = useCroc((s) => s.settings.status === 'dnd');

  // Rings repeat until answered, declined or given up.
  useEffect(() => {
    if (!enabled || !ringingIn || busy) return;
    sounds.volume = ui.get().sounds.volume;
    return sounds.loop('ring', 2000);
  }, [enabled, ringingIn, busy]);
  useEffect(() => {
    if (!enabled || !ringingOut) return;
    sounds.volume = ui.get().sounds.volume;
    return sounds.loop('ringback', 3000);
  }, [enabled, ringingOut]);

  useEffect(() => {
    const offMessage = client.on('message', ({ channel, message, mine, update }) => {
      const s = client.state;
      const sound = messageSound({
        mine,
        update,
        mentionsMe: !!s.me && mentionsIn(message.body).includes(s.me.userId),
        busy: s.settings.status === 'dnd',
        watching: document.hasFocus() && s.activeChannel === channel,
      });
      if (sound) playSound(sound);
    });
    // Others coming and going in our call.
    const offCall = client.on('call', ({ event }) => {
      if (event === 'joined') playSound('join');
      else if (event === 'left') playSound('leave');
    });
    // Our own: joining a call, leaving or being hung up on, muting.
    let prev = client.state;
    const offStore = client.store.subscribe(() => {
      const s = client.state;
      if (s.voiceSession !== prev.voiceSession) {
        if (!prev.voiceSession) playSound('join');
        else if (!s.voiceSession) playSound('hangup');
      } else if (s.voiceSession && s.muted !== prev.muted) {
        playSound(s.muted ? 'mute' : 'unmute');
      }
      prev = s;
    });
    return () => {
      offMessage();
      offCall();
      offStore();
    };
  }, [client]);
}

/** Push-to-talk (in-window), notifications, unread badge and invite deep links. */
function useGlobalBehaviours() {
  const client = getClient();

  useEffect(() => {
    const isPtt = (code: string) => code === ui.get().pttKey && ui.get().pttStatus !== 'active';
    const down = (e: KeyboardEvent) => {
      if (isPtt(e.code) && !e.repeat && !(e.target as HTMLElement)?.closest('input,textarea'))
        client.voiceEngine?.setPushToTalk(true);
    };
    const up = (e: KeyboardEvent) => {
      if (isPtt(e.code)) client.voiceEngine?.setPushToTalk(false);
    };
    const blur = () => ui.get().pttStatus !== 'active' && client.voiceEngine?.setPushToTalk(false);
    // Side mouse buttons: DOM button 3/4 are "back"/"forward" (Mouse4/Mouse5).
    const mouse = (e: MouseEvent, down: boolean) => {
      if (e.button >= 3 && isPtt(`Mouse${e.button + 1}`)) {
        e.preventDefault();
        client.voiceEngine?.setPushToTalk(down);
      }
    };
    const mdown = (e: MouseEvent) => mouse(e, true);
    const mup = (e: MouseEvent) => mouse(e, false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('mousedown', mdown);
    window.addEventListener('mouseup', mup);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('mousedown', mdown);
      window.removeEventListener('mouseup', mup);
      window.removeEventListener('blur', blur);
    };
  }, [client]);

  useEffect(
    () =>
      client.on('message', ({ channel, message, mine, update }) => {
        const s = client.state;
        if (mine || update || !s.settings.notifications || s.settings.status === 'dnd') return;
        if (document.hasFocus() && s.activeChannel === channel) return;
        const author = s.profiles[message.author]?.username ?? 'Someone';
        const space = Object.values(s.spaces).find((sp) =>
          sp.channels.some((c) => c.id === channel),
        );
        const chName = space?.channels.find((c) => c.id === channel)?.name;
        const mentioned = !!s.me && mentionsIn(message.body).includes(s.me.userId);
        const who = mentioned ? `${author} mentioned you` : author;
        const n = new Notification(space ? `${who} · ${chName} · ${space.name}` : who, {
          body: plain(message.body).slice(0, 200),
        });
        n.onclick = () => {
          window.focus();
          if (space) navigate({ kind: 'space', spaceId: space.id, channelId: channel });
          else navigate({ kind: 'dm', userId: message.author });
        };
      }),
    [client],
  );

  const totalUnread = useCroc(
    (s) => Object.values(s.unread).reduce((a, b) => a + b, 0) + pendingRequests(s),
  );
  useEffect(() => {
    void desktop?.app.setBadge(totalUnread);
  }, [totalUnread]);

  useEffect(() => {
    // Invite links clicked in a chat.
    setInviteLinkHandler(askToJoin);
    if (!desktop) return;
    const handle = (url: string | null) => {
      const m = url?.match(/^croc:\/\/join\/([a-z2-7]+)/i);
      if (m) askToJoin(m[1]!.toLowerCase());
    };
    void desktop.app.takeDeepLink().then(handle);
    return desktop.app.onDeepLink(handle);
  }, [client]);
}

/** An invite link was opened: join that space, after asking (or just open it if we're in). */
function askToJoin(code: string) {
  const client = getClient();
  void client
    .previewInvite(code)
    .catch(() => null)
    .then((preview) => {
      if (preview?.joined) return openInvite(preview);
      if (preview?.expired) return client.reportError('This invite has expired or was revoked.');
      closeModal();
      openModal({
        kind: 'confirm',
        title: preview ? `Join ${preview.name}?` : 'Join this space?',
        body: `You were invited with the code ${code}.`,
        action: 'Join',
        onConfirm: () => joinAndOpen(code),
      });
    });
}
