import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  AppWindow,
  ArrowDownCircle,
  Bug,
  Check,
  CheckCircle2,
  Code,
  Coffee,
  Copy,
  Eye,
  Globe,
  Heart,
  HelpCircle,
  Info,
  Laptop,
  LogOut,
  Mic,
  Monitor,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Shield,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  User,
  Users,
  Wifi,
  X,
  XCircle,
} from 'lucide-react';
import {
  ACCENTS,
  closeModal,
  diagnostics,
  downloadUpdate,
  getClient,
  installUpdate,
  openModal,
  playSound,
  saveAppearance,
  saveSounds,
  saveVoiceSettings,
  setPttKey,
  useCroc,
  useUi,
} from '../croc';
import { copyText, imageToDataUrl, keyLabel, openLink, stampOf } from '../lib/format';
import { NETWORK_TEXT } from '../lib/network';

const SOURCE_URL = 'https://github.com/pwalda/crocodile';
const WEBSITE_URL = 'https://crocodilechat.com';
const SPONSORS_URL = 'https://github.com/sponsors/pwalda';
const KOFI_URL = 'https://ko-fi.com/pwalda';
const HOSTING_GUIDE_URL = `${SOURCE_URL}/blob/main/docs/SELF_HOSTING.md#if-other-people-use-your-server`;
import { isOperatorContact } from '@crocodile/protocol';
import type { NetworkCheckItem } from '@crocodile/client-core';
import { desktop } from '../platform';
import { Avatar, Button, Input, Label, Toggle, cx } from '../components/ui';
import { Logo } from '../components/Logo';
import { DebugTab } from './ConnectionModals';
import type { CoordinatorSettings, CoordinatorStatus } from '../../main/ipc-types';
import { relayPorts } from '../../main/coordinator-config';

const TABS = [
  { id: 'account', label: 'Profile', icon: User },
  { id: 'devices', label: 'Devices', icon: Laptop },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'privacy', label: 'Privacy & alerts', icon: Shield },
  { id: 'connection', label: 'Network', icon: Wifi },
  { id: 'host', label: 'Host a server', icon: Server },
  { id: 'about', label: 'About', icon: Info },
  { id: 'debug', label: 'Debug', icon: Bug },
] as const;
type Tab = (typeof TABS)[number]['id'];

export function SettingsModal({ tab: initial }: { tab?: string }) {
  const [tab, setTab] = useState<Tab>(
    TABS.some((t) => t.id === initial) ? (initial as Tab) : 'account',
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeModal();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onMouseDown={closeModal}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="island rise flex h-full max-h-[760px] w-full max-w-[1000px] overflow-hidden rounded-3xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="flex w-56 shrink-0 flex-col gap-0.5 border-r border-line bg-island-2 p-3">
          <div className="px-3 pb-3 pt-2 text-lg font-extrabold">Settings</div>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cx(
                'flex items-center gap-3 rounded-xl px-3 py-2 text-left text-[14px] font-semibold transition',
                tab === id
                  ? 'bg-accent-soft text-accent'
                  : 'text-text-2 hover:bg-hover hover:text-text',
              )}
            >
              <Icon size={17} /> {label}
            </button>
          ))}
        </nav>
        <div className="relative min-w-0 flex-1 overflow-y-auto">
          <button
            onClick={closeModal}
            aria-label="Close settings"
            className="absolute right-5 top-5 rounded-full p-2 text-muted hover:bg-hover hover:text-text"
          >
            <X size={20} />
          </button>
          <div className="max-w-[680px] px-9 py-8">
            {tab === 'account' && <AccountTab />}
            {tab === 'devices' && <DevicesTab />}
            {tab === 'voice' && <VoiceTab />}
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'privacy' && <PrivacyTab />}
            {tab === 'connection' && <ConnectionTab />}
            {tab === 'host' && <HostTab />}
            {tab === 'about' && <AboutTab />}
            {tab === 'debug' && (
              <>
                <H sub="Live state of every connection, to see what goes wrong and where. Copy diagnostics into a bug report: it has no messages, keys or addresses.">
                  Debug
                </H>
                <DebugTab />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function H({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-2xl font-extrabold tracking-tight">{children}</h2>
      {sub && <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{sub}</p>}
    </div>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-2xl border border-line bg-island-2 p-5', className)}>
      {children}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-line py-4 last:border-b-0">
      <div>
        <div className="font-semibold">{label}</div>
        {hint && <div className="mt-1 text-[13px] leading-relaxed text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-11 w-full rounded-xl border border-line bg-field px-3 text-sm text-text outline-none focus:border-accent"
    >
      {children}
    </select>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-full bg-field p-1">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            'flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition',
            value === o.id ? 'bg-island text-text shadow' : 'text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AccountTab() {
  const me = useCroc((s) => s.me);
  const [name, setName] = useState(me?.username ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [accent, setAccent] = useState(me?.accent ?? '#34c77b');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const client = getClient();
  if (!me) return null;
  const dirty =
    name !== me.username || bio !== (me.bio ?? '') || accent !== (me.accent ?? '#34c77b');
  return (
    <>
      <H sub="How others see you. Your profile is signed with your key, so nobody can change it but you.">
        Profile
      </H>
      <Card className="p-0">
        <div
          className="h-24 rounded-t-2xl"
          style={{
            background: `linear-gradient(120deg, ${accent}, color-mix(in oklab, ${accent} 40%, #051410))`,
          }}
        />
        <div className="flex items-end gap-4 px-5">
          <label
            className="-mt-10 cursor-pointer rounded-[30px] border-[5px] border-[var(--island-2)]"
            title="Change picture"
          >
            <Avatar userId={me.userId} size={84} />
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f)
                  await client
                    .saveProfile({ avatar: await imageToDataUrl(f) })
                    .catch((err) => client.reportError(err.message));
              }}
            />
          </label>
          <div className="pb-2">
            <div className="text-xl font-extrabold">{me.username}</div>
            <div className="text-sm text-muted">#{me.tag}</div>
          </div>
        </div>
        <div className="space-y-4 p-5">
          <div>
            <Label>Display name</Label>
            <Input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>About me</Label>
            <textarea
              value={bio}
              maxLength={190}
              onChange={(e) => setBio(e.target.value)}
              className="selectable h-20 w-full resize-none rounded-xl border border-line bg-field p-3 text-[15px] outline-none focus:border-accent"
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-[12px] font-semibold text-muted">Banner</span>
              <input
                type="color"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                className="h-8 w-12 cursor-pointer rounded-lg border-0 bg-transparent"
              />
            </div>
            <Button
              disabled={!dirty || !name.trim()}
              onClick={() =>
                void client
                  .saveProfile({ username: name.trim(), bio, accent })
                  .catch((e) => client.reportError(e.message))
              }
            >
              Save profile
            </Button>
          </div>
        </div>
      </Card>

      <h3 className="mb-2 mt-9 text-lg font-bold">Recovery key</h3>
      <p className="mb-3 text-sm text-muted">
        Your recovery key is your account. You only need it if you lose every device. Anyone who has
        it can become you.
      </p>
      <Card className="flex items-center gap-2 p-3">
        <span className="selectable flex-1 break-all px-2 font-mono text-sm text-accent">
          {showKey ? client.recoveryKey() : '•••• •••• •••• •••• •••• •••• ••••'}
        </span>
        <Button variant="secondary" onClick={() => setShowKey(!showKey)}>
          <Eye size={16} /> {showKey ? 'Hide' : 'Reveal'}
        </Button>
        <Button
          variant="secondary"
          aria-label="Copy recovery key"
          onClick={async () => {
            await copyText(client.recoveryKey());
            setCopied(true);
          }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </Button>
      </Card>
      <div className="mt-2 text-xs text-faint">
        User ID: <span className="selectable font-mono">{me.userId}</span>
      </div>

      <h3 className="mb-2 mt-9 text-lg font-bold">Sign out</h3>
      <p className="mb-3 text-sm text-muted">
        Removes this device from your account and deletes your identity and message history from it.
      </p>
      <Button
        variant="danger"
        onClick={() =>
          openModal({
            kind: 'confirm',
            title: 'Sign out of this device?',
            body: 'Without your recovery key or another signed-in device you will not be able to get this account back.',
            action: 'Sign out',
            danger: true,
            onConfirm: () => client.signOut(),
          })
        }
      >
        <LogOut size={16} /> Sign out
      </Button>

      <h3 className="mb-2 mt-9 text-lg font-bold">Delete account</h3>
      <p className="mb-3 text-sm text-muted">
        Deletes your account on every device and from the coordination servers: your profile,
        friends list, memberships and any mail waiting for you. Spaces you own are deleted for
        everyone. Messages already on other people's devices stay with them.
      </p>
      <Button
        variant="danger"
        onClick={() =>
          openModal({
            kind: 'confirm',
            title: 'Delete your account?',
            body: 'This cannot be undone, not even with your recovery key.',
            action: 'Delete account',
            danger: true,
            confirmText: me.username,
            onConfirm: () => client.deleteAccount(),
          })
        }
      >
        <Trash2 size={16} /> Delete account
      </Button>
    </>
  );
}

function DevicesTab() {
  const devices = useCroc((s) => s.devices);
  const deviceName = useCroc((s) => s.settings.deviceName);
  const current = devices.find((d) => d.current);
  const [name, setName] = useState(deviceName ?? current?.name ?? '');
  const client = getClient();
  const active = devices.filter((d) => !d.revoked);
  return (
    <>
      <H sub="Every device has its own keys. Messages are encrypted separately to each one, and a removed device can never decrypt anything new.">
        Devices
      </H>
      <div className="mb-6 flex gap-2">
        <Button onClick={() => openModal({ kind: 'link-device' })}>
          <Plus size={16} /> Link a new device
        </Button>
      </div>
      <Card className="py-1">
        {active.length === 0 && <p className="py-4 text-sm text-muted">Loading…</p>}
        {active.map((d) => {
          const Icon = /android|ios|mobile/i.test(d.platform)
            ? Smartphone
            : /web/i.test(d.platform)
              ? AppWindow
              : Monitor;
          return (
            <div
              key={d.deviceId}
              className="flex items-center gap-4 border-b border-line py-3.5 last:border-b-0"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-text-2">
                <Icon size={19} />
              </span>
              <div className="min-w-0 flex-1">
                {d.current ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void client.renameDevice(name);
                    }}
                  >
                    <input
                      value={name}
                      maxLength={40}
                      onChange={(e) => setName(e.target.value)}
                      onBlur={() => name !== d.name && void client.renameDevice(name)}
                      className="selectable -ml-1 rounded-md bg-transparent px-1 font-semibold outline-none focus:bg-field"
                      aria-label="Device name"
                    />
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">
                      This device
                    </span>
                  </form>
                ) : (
                  <div className="font-semibold">{d.name}</div>
                )}
                <div className="text-xs text-muted">
                  {d.platform} · updated {stampOf(d.lastUpdated)}
                </div>
              </div>
              {!d.current && (
                <Button
                  variant="ghost"
                  className="text-danger"
                  onClick={() =>
                    openModal({
                      kind: 'confirm',
                      title: `Remove ${d.name}?`,
                      body: 'It will stop receiving messages and calls immediately. Note: a removed device still knows your account key; if it was lost or stolen, consider it compromised.',
                      action: 'Remove',
                      danger: true,
                      onConfirm: () => client.revokeDevice(d.deviceId),
                    })
                  }
                >
                  <Trash2 size={15} /> Remove
                </Button>
              )}
            </div>
          );
        })}
      </Card>
    </>
  );
}

function VoiceTab() {
  const settings = useUi((s) => s.voiceSettings);
  const level = useUi((s) => s.micLevel);
  const pttKey = useUi((s) => s.pttKey);
  const pttStatus = useUi((s) => s.pttStatus);
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>(
    { inputs: [], outputs: [] },
  );
  const [capturing, setCapturing] = useState(false);
  const [testing, setTesting] = useState(false);
  const engine = getClient().voiceEngine!;

  useEffect(() => {
    void engine.devices().then(setDevices);
  }, [engine]);

  useEffect(() => {
    if (!capturing) return;
    const done = (code: string) => {
      setCapturing(false);
      void setPttKey(code);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code !== 'Escape') done(e.code);
      else setCapturing(false);
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button >= 3) {
        e.preventDefault();
        done(`Mouse${e.button + 1}`);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('mousedown', onMouse, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('mousedown', onMouse, { capture: true });
    };
  }, [capturing]);

  useEffect(() => {
    if (!testing) return;
    const inVoice = !!getClient().state.voiceSession;
    void engine.start().catch(() => setTesting(false));
    return () => {
      if (!inVoice && !getClient().state.voiceSession) engine.stop();
    };
  }, [testing, engine]);

  const pct = Math.max(0, Math.min(100, level + 100));
  const threshold = settings.vadThresholdDb + 100;
  const pttHint = {
    active: 'Works everywhere, even while a game or another app is focused.',
    'needs-permission':
      'Works while Crocodile is focused. To use it everywhere on macOS, allow Crocodile under System Settings → Privacy & Security → Accessibility.',
    unavailable:
      'Works while Crocodile is focused. System-wide shortcuts are not available on this system (e.g. Wayland).',
    off: 'Works while Crocodile is focused.',
  }[pttStatus];

  return (
    <>
      <H sub="Voice is Opus at a constant bitrate, so packet sizes don't leak what you say.">
        Voice
      </H>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Microphone</Label>
          <Select
            value={settings.inputDeviceId ?? ''}
            onChange={(v) => void saveVoiceSettings({ inputDeviceId: v || undefined })}
          >
            <option value="">System default</option>
            {devices.inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Microphone'}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Speakers</Label>
          <Select
            value={settings.outputDeviceId ?? ''}
            onChange={(v) => void saveVoiceSettings({ outputDeviceId: v || undefined })}
          >
            <option value="">System default</option>
            {devices.outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Speakers'}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mt-6">
        <Label>Output volume · {Math.round(settings.outputVolume * 100)}%</Label>
        <input
          type="range"
          min={0}
          max={200}
          value={Math.round(settings.outputVolume * 100)}
          onChange={(e) => void saveVoiceSettings({ outputVolume: Number(e.target.value) / 100 })}
          className="w-full accent-[var(--accent)]"
        />
      </div>

      <h3 className="mb-3 mt-8 text-lg font-bold">How you talk</h3>
      <Segmented
        value={settings.mode}
        options={[
          { id: 'vad', label: 'When I speak' },
          { id: 'ptt', label: 'Push to talk' },
        ]}
        onChange={(m) => void saveVoiceSettings({ mode: m })}
      />
      {settings.mode === 'ptt' ? (
        <Card className="mt-4">
          <div className="flex items-center gap-4">
            <span className="text-sm font-semibold">Talk key</span>
            <button
              onClick={() => setCapturing(true)}
              className={cx(
                'min-w-[120px] rounded-xl border px-4 py-2 font-mono text-sm font-bold',
                capturing ? 'border-accent text-accent' : 'border-line bg-field',
              )}
            >
              {capturing ? 'Press a key or mouse button…' : keyLabel(pttKey)}
            </button>
            <span
              className={cx(
                'ml-auto rounded-full px-2.5 py-1 text-[11px] font-bold',
                pttStatus === 'active' ? 'bg-accent-soft text-accent' : 'bg-warn/15 text-warn',
              )}
            >
              {pttStatus === 'active' ? 'System-wide' : 'In app only'}
            </span>
          </div>
          <p className="mt-3 text-[13px] text-muted">{pttHint}</p>
        </Card>
      ) : (
        <Card className="mt-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Sensitivity</span>
            <Button variant="soft" className="h-8 text-xs" onClick={() => setTesting(!testing)}>
              {testing ? 'Stop test' : 'Test my mic'}
            </Button>
          </div>
          <div className="relative mt-3 h-3 overflow-hidden rounded-full bg-field">
            <div
              className={cx(
                'absolute inset-y-0 left-0 rounded-full transition-[width]',
                pct > threshold ? 'bg-accent' : 'bg-faint',
              )}
              style={{ width: `${pct}%` }}
            />
            <div
              className="absolute inset-y-0 w-1 -translate-x-1/2 rounded bg-amber"
              style={{ left: `${threshold}%` }}
            />
          </div>
          <input
            type="range"
            min={-100}
            max={0}
            value={settings.vadThresholdDb}
            onChange={(e) => void saveVoiceSettings({ vadThresholdDb: Number(e.target.value) })}
            className="mt-2 w-full accent-[var(--accent)]"
          />
          <p className="text-xs text-faint">Sound louder than the amber marker is sent.</p>
        </Card>
      )}

      <h3 className="mb-1 mt-8 text-lg font-bold">Processing</h3>
      <Row label="Echo cancellation">
        <Toggle
          checked={settings.echoCancellation}
          onChange={(v) => void saveVoiceSettings({ echoCancellation: v })}
          label="Echo cancellation"
        />
      </Row>
      <Row label="Noise suppression">
        <Toggle
          checked={settings.noiseSuppression}
          onChange={(v) => void saveVoiceSettings({ noiseSuppression: v })}
          label="Noise suppression"
        />
      </Row>
      <Row label="Automatic gain control">
        <Toggle
          checked={settings.autoGainControl}
          onChange={(v) => void saveVoiceSettings({ autoGainControl: v })}
          label="Automatic gain control"
        />
      </Row>
    </>
  );
}

function AppearanceTab() {
  const a = useUi((s) => s.appearance);
  return (
    <>
      <H sub="Make Crocodile yours. These settings stay on this device.">Appearance</H>
      <Row label="Theme">
        <Segmented
          value={a.theme}
          options={[
            {
              id: 'system',
              label: (
                <>
                  <Monitor size={14} /> System
                </>
              ),
            },
            {
              id: 'dark',
              label: (
                <>
                  <Moon size={14} /> Lagoon
                </>
              ),
            },
            {
              id: 'light',
              label: (
                <>
                  <Sun size={14} /> Reed
                </>
              ),
            },
          ]}
          onChange={(theme) => void saveAppearance({ theme })}
        />
      </Row>
      <Row label="Accent colour">
        <div className="flex gap-2">
          {ACCENTS.map((c) => (
            <button
              key={c}
              aria-label={`Accent ${c}`}
              onClick={() => void saveAppearance({ accent: c })}
              className="flex h-8 w-8 items-center justify-center rounded-full transition hover:scale-110"
              style={{
                background: c,
                boxShadow: a.accent === c ? `0 0 0 2px var(--island), 0 0 0 4px ${c}` : undefined,
              }}
            >
              {a.accent === c && <Check size={15} className="text-on-accent" />}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Messages" hint="Bubbles are roomy and friendly; compact fits more on screen.">
        <Segmented
          value={a.density}
          options={[
            { id: 'bubbles', label: 'Bubbles' },
            { id: 'compact', label: 'Compact' },
          ]}
          onChange={(density) => void saveAppearance({ density })}
        />
      </Row>
    </>
  );
}

function PrivacyTab() {
  const settings = useCroc((s) => s.settings);
  const soundPrefs = useUi((s) => s.sounds);
  const blocked = useCroc((s) => s.friends.blocked);
  const client = getClient();
  return (
    <>
      <H sub="Messages and voice are end-to-end encrypted with keys that change constantly. These choices control what you share with others, and how Crocodile gets your attention.">
        Privacy & alerts
      </H>
      <Row label="Status">
        <Segmented
          value={settings.status}
          options={[
            { id: 'online', label: 'Online' },
            { id: 'idle', label: 'Away' },
            { id: 'dnd', label: 'Busy' },
            { id: 'invisible', label: 'Hidden' },
          ]}
          onChange={(st) => void client.setStatus(st)}
        />
      </Row>
      <Row label="Desktop notifications">
        <Toggle
          checked={settings.notifications}
          onChange={(v) => void client.updateSettings({ notifications: v })}
          label="Desktop notifications"
        />
      </Row>
      <Row
        label="Sounds"
        hint="Ringing, people joining and leaving calls, new messages and mentions. Quiet while you're busy."
      >
        <Toggle
          checked={soundPrefs.enabled}
          onChange={(v) => void saveSounds({ enabled: v })}
          label="Sounds"
        />
      </Row>
      {soundPrefs.enabled && (
        <div className="flex items-center gap-3 border-b border-line py-4">
          <Label>Volume · {Math.round(soundPrefs.volume * 100)}%</Label>
          <input
            type="range"
            min={5}
            max={100}
            aria-label="Sound volume"
            value={Math.round(soundPrefs.volume * 100)}
            onChange={(e) => void saveSounds({ volume: Number(e.target.value) / 100 })}
            onPointerUp={() => playSound('message')}
            className="flex-1 accent-[var(--accent)]"
          />
          <Button variant="secondary" className="h-8 text-xs" onClick={() => playSound('ring')}>
            Play
          </Button>
        </div>
      )}
      <h3 className="mb-2 mt-8 text-lg font-bold">Blocked</h3>
      <Card className="py-2">
        {blocked.length === 0 && (
          <p className="py-2 text-sm text-muted">You haven't blocked anyone.</p>
        )}
        {blocked.map((u) => (
          <div key={u} className="flex items-center gap-3 py-2">
            <Avatar userId={u} size={30} />
            <span className="flex-1 font-semibold">{client.state.profiles[u]?.username ?? u}</span>
            <Button
              variant="secondary"
              className="h-8 text-xs"
              onClick={() => void client.unblock(u)}
            >
              Unblock
            </Button>
          </div>
        ))}
      </Card>
    </>
  );
}

/** The result of the network check, with a way to run it again. */
function NetworkTest() {
  const network = useCroc((s) => s.network);
  const relayOn = useCroc((s) => s.settings.allowServerRelay);
  const client = getClient();
  const verdict = network?.verdict ?? 'unknown';
  const text = NETWORK_TEXT[verdict];
  const ok = verdict === 'good';
  return (
    <section aria-label="Connection test">
      <Card className="mt-3 flex items-start gap-3">
        <span
          className={cx(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
            ok ? 'bg-accent-soft text-accent' : 'bg-warn/15 text-warn',
          )}
        >
          <Wifi size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-bold">
            {network?.checking && !network.checkedAt ? 'Testing your network…' : text.title}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            {network?.checkedAt ? text.detail : 'Crocodile tests your network when it connects.'}
            {!ok && network?.checkedAt && relayOn ? ' The relay is on.' : ''}
          </p>
          {network?.checks && <NetworkChecklist checks={network.checks} reason={network.reason} />}
          {!ok &&
            network?.checkedAt &&
            !relayOn &&
            (verdict === 'limited' || verdict === 'blocked') && (
              <Button
                className="mt-3 h-9"
                onClick={() => void client.updateSettings({ allowServerRelay: true })}
              >
                Turn on the relay
              </Button>
            )}
        </div>
        <Button
          variant="secondary"
          className="h-9 shrink-0"
          disabled={!!network?.checking}
          onClick={() => void client.checkNetwork(true)}
        >
          {network?.checking ? 'Testing…' : 'Test again'}
        </Button>
      </Card>
    </section>
  );
}

const CHECK_ICON = {
  ok: { Icon: CheckCircle2, className: 'text-accent', label: 'Passed' },
  warn: { Icon: AlertTriangle, className: 'text-warn', label: 'Warning' },
  fail: { Icon: XCircle, className: 'text-danger', label: 'Failed' },
  unknown: { Icon: HelpCircle, className: 'text-faint', label: 'Unknown' },
  info: { Icon: Info, className: 'text-faint', label: 'Information' },
} as const;

/** What the network check looked at, one line per check, and why it decided what it did. */
function NetworkChecklist({ checks, reason }: { checks: NetworkCheckItem[]; reason?: string }) {
  return (
    <div className="mt-3 rounded-2xl border border-line p-3">
      <ul aria-label="What was checked" className="space-y-2">
        {checks.map((c) => {
          const { Icon, className, label } = CHECK_ICON[c.status];
          return (
            <li key={c.id} className="flex gap-2.5 text-xs">
              <Icon size={15} className={cx('mt-px shrink-0', className)} aria-label={label} />
              <div>
                <div className="font-semibold text-text">{c.label}</div>
                <div className="leading-relaxed text-muted">{c.detail}</div>
              </div>
            </li>
          );
        })}
      </ul>
      {reason && (
        <p className="mt-3 border-t border-line pt-2 text-xs leading-relaxed text-text-2">
          <span className="font-semibold">Result: </span>
          {reason}
        </p>
      )}
    </div>
  );
}

function ConnectionTab() {
  const server = useCroc((s) => s.server);
  const servers = useCroc((s) => s.servers);
  const link = useCroc((s) => s.link);
  const settings = useCroc((s) => s.settings);
  const preferred = settings.preferredServers;
  const [url, setUrl] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const client = getClient();
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await client.refreshServers().catch(() => {});
    setRefreshing(false);
  }, [client]);
  // Live numbers while this tab is open: the list on opening, the connected
  // server's round trip every few seconds.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void client.measureLatency().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [client, refresh]);
  const standby = servers.find((s) => s.info.id !== server?.info.id && Number.isFinite(s.rttMs));
  return (
    <>
      <H sub="Coordination servers are run by volunteers. They introduce you to people and pick who hosts a call — they can't read your messages or voice, which are end-to-end encrypted. Crocodile uses the fastest one and keeps the runner-up on standby.">
        Network
      </H>
      <Card className="flex items-center gap-3">
        <span
          className={cx(
            'flex h-10 w-10 items-center justify-center rounded-xl',
            link === 'connected' ? 'bg-accent-soft text-accent' : 'bg-warn/15 text-warn',
          )}
        >
          <Server size={19} />
        </span>
        <div>
          <div className="font-bold">
            {server?.info.name ?? (link === 'offline' ? 'Not connected' : 'Connecting…')}
          </div>
          <div className="text-xs text-muted">
            {server ? `${server.info.url} · ${Math.round(server.rttMs)} ms` : link}
          </div>
        </div>
        <Button
          variant="secondary"
          className="ml-auto h-9"
          onClick={() => client.link?.reconnect()}
        >
          Reconnect
        </Button>
      </Card>
      <NetworkTest />
      {server && <OperatorLine contact={server.operator?.contact} />}

      <div className="mb-2 mt-8 flex items-center justify-between">
        <h3 className="text-lg font-bold">
          Public servers{servers.length > 0 ? ` · ${servers.length}` : ''}
        </h3>
        <Button
          variant="ghost"
          className="h-8 text-xs"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={cx(refreshing && 'animate-spin')} /> Refresh
        </Button>
      </div>
      <p className="mb-2 text-xs text-faint">
        Listed in the server directory. Crocodile picks the fastest; use one to try it first.
      </p>
      {servers.length === 0 ? (
        <p className="text-sm text-muted">
          {refreshing ? 'Measuring servers…' : 'No public servers found.'}
        </p>
      ) : (
        <section aria-label="Public servers">
          <Card className="py-1">
            {servers.map((s) => {
              const reachable = Number.isFinite(s.rttMs);
              const isCurrent = s.info.id === server?.info.id;
              const isFirst = preferred[0] === s.info.url;
              return (
                <div
                  key={s.info.id}
                  role="group"
                  aria-label={s.info.name}
                  className="flex items-center gap-3 border-b border-line py-2.5 text-sm last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{s.info.name}</span>
                      {isCurrent && (
                        <span className="rounded-full bg-accent-soft px-2 text-[11px] font-bold text-accent">
                          Using
                        </span>
                      )}
                      {s === standby && (
                        <span className="rounded-full bg-raised px-2 text-[11px] font-bold text-muted">
                          Standby
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-faint">
                      {[
                        s.info.region,
                        `${Math.round(s.load * 100)}% full`,
                        /^\d/.test(s.info.version) ? `v${s.info.version}` : s.info.version,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <span className={cx('tabular-nums', reachable ? 'text-muted' : 'text-danger')}>
                    {reachable ? `${Math.round(s.rttMs)} ms` : 'Unreachable'}
                  </span>
                  <Button
                    variant="secondary"
                    className="h-8 w-20 text-xs"
                    disabled={!reachable || isCurrent || isFirst}
                    onClick={() => void client.preferServer(s.info.url)}
                  >
                    {isFirst ? 'Preferred' : 'Use'}
                  </Button>
                </div>
              );
            })}
          </Card>
        </section>
      )}

      <h3 className="mb-1 mt-8 text-lg font-bold">When someone is offline</h3>
      <Row
        label="Hold my messages on a server until they're back"
        hint="Your messages always wait on your device and go out peer-to-peer when you and the other person are online at the same time. With this on, a direct message can also wait on a coordination server, sealed so only the recipient's devices can open it, for up to a few days. The server sees who wrote to whom and when, never what."
      >
        <Toggle
          checked={settings.useMailbox}
          onChange={(v) => void client.updateSettings({ useMailbox: v })}
          label="Hold my messages on a server"
        />
      </Row>

      <h3 className="mb-1 mt-8 text-lg font-bold">When a direct connection isn't possible</h3>
      <Row
        label="Relay through a coordination server"
        hint="Some networks (strict corporate or mobile carriers) block direct connections. With this on, Crocodile can pass your already-encrypted voice and messages through a volunteer server — it still can't read them. Limited to an hour at a time and to a few people per server."
      >
        <Toggle
          checked={settings.allowServerRelay}
          onChange={(v) => void client.updateSettings({ allowServerRelay: v })}
          label="Relay through a coordination server"
        />
      </Row>
      <Row
        label="Let my device host calls and chats"
        hint="When your connection is the best in a group, your device forwards the group's encrypted streams. It can never read them. Turn off on metered connections."
      >
        <Toggle
          checked={settings.allowHosting}
          onChange={(v) => void client.updateSettings({ allowHosting: v })}
          label="Let my device host"
        />
      </Row>
      <Row label="Upload speed" hint="Helps pick the best host. Leave on unknown if unsure.">
        <div className="w-48">
          <Select
            value={String(settings.uplinkKbps ?? '')}
            onChange={(v) => void client.updateSettings({ uplinkKbps: v ? Number(v) : undefined })}
          >
            <option value="">Unknown</option>
            <option value="1000">Under 2 Mbit/s</option>
            <option value="5000">2–10 Mbit/s</option>
            <option value="20000">10–50 Mbit/s</option>
            <option value="100000">Over 50 Mbit/s</option>
          </Select>
        </div>
      </Row>

      <h3 className="mb-1 mt-8 text-lg font-bold">Preferred servers</h3>
      <p className="mb-3 text-sm text-muted">
        Tried before the public list. Useful for private or LAN servers.
      </p>
      {preferred.map((p) => (
        <div key={p} className="flex items-center gap-2 py-1 text-sm">
          <span className="flex-1 font-mono">{p}</span>
          <button
            className="text-xs font-semibold text-danger hover:underline"
            onClick={() =>
              void client.updateSettings({ preferredServers: preferred.filter((x) => x !== p) })
            }
          >
            Remove
          </button>
        </div>
      ))}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const clean = url.trim().replace(/\/$/, '');
          if (!/^https?:\/\//.test(clean))
            return client.reportError('Server addresses start with http:// or https://');
          void client.updateSettings({ preferredServers: [...preferred, clean] });
          setUrl('');
        }}
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://croc.example.org"
        />
        <Button type="submit">Add</Button>
      </form>
    </>
  );
}

/** Who runs the connected server, as the server itself says. */
function OperatorLine({ contact }: { contact?: string }) {
  if (!contact)
    return <p className="mt-2 text-xs text-faint">This server doesn&apos;t say who runs it.</p>;
  const isPage = contact.startsWith('https://');
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted">
      Run by, as the server says:{' '}
      {isPage ? (
        <button
          type="button"
          className="selectable text-accent hover:underline"
          onClick={() => openLink(contact)}
        >
          {contact}
        </button>
      ) : (
        <span className="selectable font-mono">{contact}</span>
      )}
      {!isPage && (
        <Button variant="ghost" className="h-7 text-xs" onClick={() => void copyText(contact)}>
          <Copy size={13} /> Copy
        </Button>
      )}
    </p>
  );
}

function HostTab() {
  const [settings, setSettings] = useState<CoordinatorSettings | null>(null);
  const [status, setStatus] = useState<CoordinatorStatus>({ state: 'stopped' });
  const [confirming, setConfirming] = useState(false);
  const [contact, setContact] = useState('');
  const contactValid = !contact.trim() || isOperatorContact(contact.trim());
  useEffect(() => {
    if (!desktop) return;
    void desktop.coordinator.get().then((r) => {
      setSettings(r.settings);
      setContact(r.settings.contact ?? '');
      setStatus(r.status);
    });
    return desktop.coordinator.onStatus(setStatus);
  }, []);
  if (!desktop) return <p className="text-muted">Hosting a server needs the desktop app.</p>;
  if (!settings) return null;
  const update = async (patch: Partial<CoordinatorSettings>) =>
    setSettings(await desktop!.coordinator.set(patch));
  return (
    <>
      <H sub="Help the network by running a coordination server on this computer. It introduces people, picks call hosts and keeps a copy of the network's account records. It can't read messages or calls: they are end-to-end encrypted.">
        Host a server
      </H>
      <Card className="mb-6 flex items-center gap-3 text-sm">
        <span
          className={cx(
            'h-2.5 w-2.5 rounded-full',
            status.state === 'running'
              ? 'live-dot bg-online'
              : status.state === 'error'
                ? 'bg-danger'
                : 'bg-faint',
          )}
        />
        {status.state === 'running' ? (
          <span>
            Running at <span className="font-mono">{status.url}</span> · {status.users}{' '}
            {status.users === 1 ? 'person' : 'people'} · {status.peers} other server
            {status.peers === 1 ? '' : 's'}
            {status.announced ? ' · listed publicly' : ''}
          </span>
        ) : status.state === 'error' ? (
          <span className="text-danger">{status.message}</span>
        ) : (
          <span className="capitalize text-muted">{status.state}</span>
        )}
      </Card>
      {status.state === 'running' && (
        <Card className="mb-4 text-sm">
          <div className="font-bold">Share this address</div>
          <p className="mt-1 text-muted">
            People on your network add it under Settings → Network → Preferred servers (or when the
            app says it can't find a server). For people elsewhere, forward TCP+UDP {settings.port}{' '}
            and UDP {settings.port + 1}
            {settings.relay &&
              ` (and UDP ${relayPorts(settings).min}-${relayPorts(settings).max} for the relay)`}{' '}
            on your router and share your public address.
          </p>
          <div className="mt-2 space-y-1">
            {(status.publicUrl ? [status.publicUrl, ...status.lanUrls] : status.lanUrls).map(
              (u) => (
                <div key={u} className="flex items-center gap-2">
                  <span className="selectable flex-1 font-mono">{u}</span>
                  <Button variant="ghost" className="h-8 text-xs" onClick={() => void copyText(u)}>
                    <Copy size={14} /> Copy
                  </Button>
                </div>
              ),
            )}
          </div>
        </Card>
      )}
      <Row
        label="Run a coordination server"
        hint={
          <>
            What running a server means for you, and a privacy notice you can adapt:{' '}
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => openLink(HOSTING_GUIDE_URL)}
            >
              hosting guide
            </button>
            .
          </>
        }
      >
        <Toggle
          checked={settings.enabled || confirming}
          onChange={(v) => {
            setConfirming(v);
            if (!v) void update({ enabled: false });
          }}
          label="Run a coordination server"
        />
      </Row>
      {confirming && (
        <section aria-label="Before you run a server">
          <Card className="mb-4 mt-3 text-sm">
            <div className="font-bold">Before you run a server</div>
            <p className="mt-1 text-muted">
              Your server joins the Crocodile network and keeps a copy of everyone&apos;s account
              records: profiles, friend lists, spaces and memberships. It also sees who is online
              and who calls whom, never what they say. If other people use your server, privacy laws
              such as the GDPR can make you responsible for that data.
            </p>
            <label className="mt-3 block">
              <Label>Operator contact (required)</Label>
              <Input
                value={contact}
                placeholder="you@example.org or https://example.org/privacy"
                aria-invalid={!contactValid}
                onChange={(e) => setContact(e.target.value)}
              />
            </label>
            <p className={cx('mt-1.5 text-xs', contactValid ? 'text-faint' : 'text-danger')}>
              {contactValid
                ? 'How people using your server can reach you. Everyone connected to it sees this.'
                : 'Enter an email address or a page starting with https://.'}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                disabled={!contact.trim() || !contactValid}
                onClick={async () => {
                  await update({ contact: contact.trim(), enabled: true });
                  setConfirming(false);
                }}
              >
                Run server
              </Button>
            </div>
          </Card>
        </section>
      )}
      <div className="grid grid-cols-2 gap-4 py-4">
        <div>
          <Label>Server name</Label>
          <Input
            value={settings.name}
            maxLength={64}
            onChange={(e) => setSettings({ ...settings, name: e.target.value })}
            onBlur={() => void update({ name: settings.name })}
          />
        </div>
        <div>
          <Label>Port (TCP + UDP)</Label>
          <Input
            type="number"
            value={settings.port}
            onChange={(e) => setSettings({ ...settings, port: Number(e.target.value) })}
            onBlur={() => void update({ port: settings.port })}
          />
        </div>
      </div>
      <div className="pb-4">
        <Label>Public address (optional)</Label>
        <Input
          value={settings.publicUrl ?? ''}
          placeholder="http://203.0.113.7:7443 or https://croc.example.org"
          onChange={(e) => setSettings({ ...settings, publicUrl: e.target.value })}
          onBlur={() => void update({ publicUrl: settings.publicUrl?.trim() || undefined })}
        />
        <p className="mt-1.5 text-xs text-faint">
          To serve the internet, forward the port on your router. Without it, the server works on
          your local network.
        </p>
      </div>
      <div className={cx('pb-4', confirming && 'hidden')}>
        <label>
          <Label>Operator contact (required)</Label>
          <Input
            value={contact}
            placeholder="you@example.org or https://example.org/privacy"
            aria-invalid={!contactValid}
            onChange={(e) => setContact(e.target.value)}
            onBlur={() => {
              if (contact.trim() && contactValid) void update({ contact: contact.trim() });
            }}
          />
        </label>
        <p className={cx('mt-1.5 text-xs', contactValid ? 'text-faint' : 'text-danger')}>
          {contactValid
            ? 'How people using your server can reach you: an email address, or a web page such as your privacy notice. The app shows it to everyone connected to your server.'
            : 'Enter an email address or a page starting with https://.'}
        </p>
      </div>
      <Row
        label="List in the server directory"
        hint="The directory is the public phone book of coordination servers that apps use to find the fastest one. Requires a public address: anyone may then use your server."
      >
        <Toggle
          checked={settings.announce}
          onChange={(v) => void update({ announce: v })}
          label="List in the server directory"
        />
      </Row>
      <Row
        label="Offer a relay"
        hint="Lets people whose networks block direct connections pass their encrypted traffic through you, up to an hour at a time. Uses about 100 kbit/s per person."
      >
        <Toggle
          checked={settings.relay}
          onChange={(v) => void update({ relay: v })}
          label="Offer a relay"
        />
      </Row>
      {settings.relay && (
        <Row label="Relay capacity" hint="Maximum people relaying through this server at once.">
          <Input
            type="number"
            min={1}
            max={100}
            className="w-24"
            value={settings.relayMaxUsers}
            onChange={(e) => setSettings({ ...settings, relayMaxUsers: Number(e.target.value) })}
            onBlur={() => void update({ relayMaxUsers: settings.relayMaxUsers })}
          />
        </Row>
      )}
      <Row
        label="Keep mail for offline people"
        hint="Holds sealed direct messages for people who opted in, until the recipient comes online (at most 3 days). Uses a little disk space; content is unreadable to you."
      >
        <Toggle
          checked={settings.mailbox}
          onChange={(v) => void update({ mailbox: v })}
          label="Keep mail for offline people"
        />
      </Row>
    </>
  );
}

/** Copies a bug-report summary (no messages or keys) to the clipboard. */
function DiagnosticsButton() {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      title="Versions, connection state and recent log lines for a bug report. No messages or keys."
      onClick={async () => {
        await copyText(await diagnostics());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy diagnostics'}
    </Button>
  );
}

const ABOUT_FEATURES = [
  {
    icon: ShieldCheck,
    title: 'End-to-end encrypted',
    text: 'Messages and calls are encrypted on your device, with ratcheting keys and post-quantum key exchange.',
  },
  {
    icon: Users,
    title: 'Peer-to-peer',
    text: 'Voice and text go straight between people. In groups the best-connected member hosts, with a runner-up on standby.',
  },
  {
    icon: Server,
    title: 'Volunteer servers',
    text: "Coordination servers only introduce people and pick call hosts. They can't read what you say.",
  },
];

/** Look for a new version, download it, restart into it. */
function UpdatesCard() {
  const update = useUi((s) => s.update);
  if (update.state === 'unsupported' || !desktop) return null;
  const check = () => void desktop?.updates.check();
  let text: ReactNode;
  let action: ReactNode = (
    <Button variant="secondary" onClick={check} disabled={update.state === 'checking'}>
      <RefreshCw size={15} className={cx(update.state === 'checking' && 'animate-spin')} />
      Check for updates
    </Button>
  );
  switch (update.state) {
    case 'idle':
      text = 'Crocodile looks for new versions now and then and asks before installing one.';
      break;
    case 'checking':
      text = 'Looking for a new version…';
      break;
    case 'current':
      text = `You have the latest version (checked ${stampOf(update.checkedAt).replace(
        /^(Today|Yesterday)/,
        (d) => d.toLowerCase(),
      )}).`;
      break;
    case 'available':
      text =
        update.how === 'install'
          ? `Version ${update.version} is out.`
          : `Version ${update.version} is out. This copy can't update itself; download the new version from the release page.`;
      action = (
        <Button onClick={downloadUpdate}>
          <ArrowDownCircle size={15} />
          {update.how === 'install' ? 'Download and install' : 'Open download page'}
        </Button>
      );
      break;
    case 'downloading':
      text = `Downloading version ${update.version}…`;
      action = null;
      break;
    case 'ready':
      text =
        update.after === 'open'
          ? `Version ${update.version} is downloaded. Crocodile quits and opens it; drag Crocodile into Applications to replace this version.`
          : `Version ${update.version} is downloaded. Restart Crocodile to start using it.`;
      action = (
        <Button onClick={installUpdate}>
          <RotateCw size={15} />
          {update.after === 'open' ? 'Quit and install' : 'Restart to update'}
        </Button>
      );
      break;
    case 'error':
      text = update.version
        ? `Version ${update.version} couldn't be installed: ${update.message}`
        : `Couldn't look for updates: ${update.message}`;
      break;
  }
  return (
    <section aria-label="Updates">
      <Card className="mb-3 text-sm leading-relaxed text-text-2">
        <h3 className="flex items-center gap-2 text-base font-bold text-text">
          <ArrowDownCircle size={16} className="text-accent" /> Updates
        </h3>
        <p className="mt-1" role="status">
          {text}
        </p>
        {update.state === 'downloading' && (
          <div
            role="progressbar"
            aria-label="Download progress"
            aria-valuenow={update.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-3 h-2 overflow-hidden rounded-full bg-raised"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${update.percent}%` }}
            />
          </div>
        )}
        {action && <div className="flex flex-wrap gap-2 pt-3">{action}</div>}
      </Card>
    </section>
  );
}

function AboutTab() {
  const version = useUi((s) => s.appVersion);
  return (
    <>
      <div className="flex flex-col items-center pb-7 pt-2 text-center">
        <Logo size={88} className="drop-shadow-[0_14px_28px_var(--accent-soft)]" />
        <h2 className="mt-4 text-3xl font-extrabold tracking-tight">Crocodile</h2>
        <p className="mt-1 text-sm text-muted">
          Peer-to-peer, end-to-end encrypted voice and text chat.
        </p>
        <span className="mt-3 rounded-full bg-accent-soft px-3 py-1 text-xs font-bold text-accent">
          Version {version} · beta
        </span>
      </div>
      <UpdatesCard />
      <div className="grid grid-cols-3 gap-3">
        {ABOUT_FEATURES.map(({ icon: Icon, title, text }) => (
          <Card key={title} className="p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Icon size={18} />
            </span>
            <div className="mt-3 text-sm font-bold">{title}</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{text}</p>
          </Card>
        ))}
      </div>
      <Card className="mt-3 text-sm leading-relaxed text-text-2">
        <p>
          Crocodile is free software, licensed under the GNU Affero General Public License v3; the
          protocol and crypto libraries under Apache-2.0. Commercial licences are available from the
          maintainer.
        </p>
        <div className="flex flex-wrap gap-2 pt-3">
          <Button variant="secondary" onClick={() => openLink(WEBSITE_URL)}>
            <Globe size={15} /> Website
          </Button>
          <Button variant="secondary" onClick={() => openLink(SOURCE_URL)}>
            <Code size={15} /> Source code
          </Button>
          <Button variant="ghost" onClick={() => openLink(`${SOURCE_URL}/blob/main/LICENSE`)}>
            License
          </Button>
          <DiagnosticsButton />
        </div>
      </Card>
      <section aria-label="Support Crocodile">
        <Card className="mt-3 text-sm leading-relaxed text-text-2">
          <h3 className="flex items-center gap-2 text-base font-bold text-text">
            <Heart size={16} className="text-accent" /> Support Crocodile
          </h3>
          <p className="mt-1">
            Crocodile has no ads, no tracking and no paid features. Donations pay for the main
            server and development, and everyone gets the same app whether they give or not.
          </p>
          <div className="flex flex-wrap gap-2 pt-3">
            <Button variant="secondary" onClick={() => openLink(SPONSORS_URL)}>
              <Heart size={15} /> GitHub Sponsors
            </Button>
            <Button variant="secondary" onClick={() => openLink(KOFI_URL)}>
              <Coffee size={15} /> Ko-fi
            </Button>
          </div>
        </Card>
      </section>
    </>
  );
}
