import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  KeyRound,
  Laptop,
  Lock,
  Radio,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { getClient, useCroc } from '../croc';
import { copyText, imageToDataUrl } from '../lib/format';
import { Button, Input, Label } from './ui';
import { Logo } from './Logo';

type Step = 'welcome' | 'create' | 'returning' | 'link' | 'restore' | 'recovery';

/** First run: no passwords or emails. Pick a name, or bring your account from another device. */
export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome');
  return (
    <div className="flex h-full gap-3 p-3">
      <BrandPanel />
      <div className="island flex flex-1 items-center justify-center">
        <div key={step} className="rise w-[440px] max-w-[90%]">
          {step === 'welcome' && <Welcome go={setStep} />}
          {step === 'create' && <Create go={setStep} />}
          {step === 'returning' && <Returning go={setStep} />}
          {step === 'link' && <LinkFromDevice go={setStep} />}
          {step === 'restore' && <Restore go={setStep} />}
          {step === 'recovery' && <SaveRecovery />}
        </div>
      </div>
    </div>
  );
}

function BrandPanel() {
  return (
    <div
      className="relative hidden w-[40%] max-w-[520px] flex-col justify-between overflow-hidden rounded-[var(--radius)] p-10 text-[#e7f1ea] md:flex"
      style={{ background: 'linear-gradient(160deg, #0f3b2b 0%, #082119 55%, #051410 100%)' }}
    >
      <svg
        className="pointer-events-none absolute inset-x-0 bottom-0 w-full opacity-60"
        viewBox="0 0 400 160"
        preserveAspectRatio="none"
        aria-hidden
      >
        {[0, 1, 2, 3].map((i) => (
          <path
            key={i}
            d={`M0 ${40 + i * 30} C60 ${25 + i * 30} 100 ${55 + i * 30} 160 ${40 + i * 30} S260 ${25 + i * 30} 320 ${40 + i * 30} S380 ${50 + i * 30} 400 ${40 + i * 30}`}
            stroke="#5eead4"
            strokeOpacity={0.35 - i * 0.07}
            strokeWidth={2}
            fill="none"
          />
        ))}
      </svg>
      <div className="flex items-center gap-3">
        <Logo size={44} />
        <span className="text-xl font-extrabold tracking-tight">Crocodile</span>
      </div>
      <div className="relative">
        <h1 className="text-[40px] font-extrabold leading-[1.05] tracking-tight">
          Talk freely.
          <br />
          <span className="text-[#7ee2a8]">Nobody in between.</span>
        </h1>
        <ul className="mt-8 space-y-4 text-[15px] text-[#b9d3c4]">
          <Point icon={<Lock size={18} />}>
            Every word and every voice frame is end-to-end encrypted, with post-quantum key
            exchange.
          </Point>
          <Point icon={<Radio size={18} />}>
            Voice and messages travel directly between you and your friends — never stored on a
            server.
          </Point>
          <Point icon={<Users size={18} />}>
            Rooms for your crew, spaces for your community, calls for two.
          </Point>
        </ul>
      </div>
      <p className="relative text-xs text-[#6f8f80]">
        Coordination servers are run by volunteers and only help you find each other.
      </p>
    </div>
  );
}

function Point({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/10 text-[#7ee2a8]">
        {icon}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}

function Header({ title, text, back }: { title: string; text?: ReactNode; back?: () => void }) {
  return (
    <div className="mb-7">
      {back && (
        <button
          className="mb-5 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-text"
          onClick={back}
        >
          <ArrowLeft size={16} /> Back
        </button>
      )}
      <h2 className="text-[28px] font-extrabold tracking-tight">{title}</h2>
      {text && <p className="mt-2 text-[15px] leading-relaxed text-muted">{text}</p>}
    </div>
  );
}

function Choice({
  icon,
  title,
  text,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-2xl border border-line bg-island-2 p-4 text-left transition hover:border-accent hover:bg-hover"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
        {icon}
      </span>
      <span>
        <span className="block font-bold">{title}</span>
        <span className="block text-sm text-muted">{text}</span>
      </span>
    </button>
  );
}

function Welcome({ go }: { go: (s: Step) => void }) {
  const accountDeleted = useCroc((s) => s.accountDeleted);
  return (
    <>
      <div className="mb-6 md:hidden">
        <Logo size={56} />
      </div>
      {accountDeleted && (
        <p
          role="status"
          className="mb-6 rounded-2xl border border-line bg-island-2 p-4 text-sm text-muted"
        >
          Your account was deleted, and this device has forgotten it.
        </p>
      )}
      <Header
        title="Welcome"
        text="No passwords, emails or phone numbers. Your account is a key that lives on your devices."
      />
      <div className="space-y-3">
        <Choice
          icon={<Sparkles size={20} />}
          title="I'm new here"
          text="Pick a name and start talking"
          onClick={() => go('create')}
        />
        <Choice
          icon={<KeyRound size={20} />}
          title="I already use Crocodile"
          text="Bring your account to this device"
          onClick={() => go('returning')}
        />
      </div>
    </>
  );
}

function Create({ go }: { go: (s: Step) => void }) {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = getClient();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await client.createAccount(name.trim(), avatar);
          go('recovery');
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <Header
        title="What should people call you?"
        text="You can change your name and picture any time."
        back={() => go('welcome')}
      />
      <div className="flex items-center gap-4">
        <label className="group relative flex h-20 w-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-[26px] bg-accent text-3xl font-extrabold text-on-accent">
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            (name.trim()[0] ?? '🐊').toUpperCase()
          )}
          <span className="absolute inset-0 hidden items-center justify-center bg-black/55 text-[11px] font-bold text-white group-hover:flex">
            Photo
          </span>
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setAvatar(await imageToDataUrl(f));
            }}
          />
        </label>
        <div className="flex-1">
          <Label>Display name</Label>
          <Input
            autoFocus
            maxLength={32}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Wally"
          />
        </div>
      </div>
      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      <Button type="submit" className="mt-8 h-12 w-full text-base" disabled={!name.trim() || busy}>
        {busy ? 'Creating your keys…' : 'Continue'}
      </Button>
    </form>
  );
}

function Returning({ go }: { go: (s: Step) => void }) {
  return (
    <>
      <Header
        title="Welcome back"
        text="How would you like to sign in?"
        back={() => go('welcome')}
      />
      <div className="space-y-3">
        <Choice
          icon={<Laptop size={20} />}
          title="Link from another device"
          text="Approve this device from one that is signed in"
          onClick={() => go('link')}
        />
        <Choice
          icon={<KeyRound size={20} />}
          title="Use my recovery key"
          text="The key you saved when you created your account"
          onClick={() => go('restore')}
        />
      </div>
    </>
  );
}

function LinkFromDevice({ go }: { go: (s: Step) => void }) {
  const linking = useCroc((s) => s.linking);
  const client = getClient();
  useEffect(() => {
    void client.startDeviceLink();
    return () => {
      if (client.state.linking?.step !== 'done') client.cancelDeviceLink();
    };
  }, [client]);
  useEffect(() => {
    if (linking?.role === 'new' && linking.step === 'done') {
      const t = setTimeout(() => client.finishOnboarding(), 600);
      return () => clearTimeout(t);
    }
  }, [linking, client]);

  const l = linking?.role === 'new' ? linking : null;
  return (
    <>
      <Header
        title="Link this device"
        text={
          <>
            On a device where you're signed in, open your account menu and choose{' '}
            <b className="text-text">Link another device</b>, then type this code.
          </>
        }
        back={() => go('returning')}
      />
      {!l || (l.step === 'waiting' && !l.code) ? (
        <div className="h-24 animate-pulse rounded-2xl bg-raised" />
      ) : l.step === 'error' ? (
        <div className="rounded-2xl border border-danger/40 bg-danger/10 p-4 text-sm">
          {l.error}
          <Button
            variant="secondary"
            className="mt-3"
            onClick={() => void client.startDeviceLink()}
          >
            Try again
          </Button>
        </div>
      ) : l.step === 'waiting' ? (
        <div className="selectable rounded-2xl bg-accent-soft py-6 text-center font-mono text-4xl font-bold tracking-[0.25em] text-accent">
          {l.code}
        </div>
      ) : l.step === 'claimed' || l.step === 'confirmed' ? (
        <div className="text-center">
          <p className="text-sm text-muted">
            {l.step === 'claimed'
              ? 'Check that your other device shows exactly this security code, then confirm on both devices.'
              : 'Now confirm on your other device too.'}
          </p>
          <div className="selectable mt-4 rounded-2xl bg-accent-soft py-6 font-mono text-4xl font-bold tracking-widest text-accent">
            {l.securityCode}
          </div>
          {l.step === 'confirmed' && (
            <Button variant="ghost" className="mt-4" onClick={() => go('returning')}>
              Cancel
            </Button>
          )}
          {l.step === 'claimed' && (
            <>
              <p className="mt-3 text-xs text-faint">
                If the codes differ, someone may be trying to intercept the link.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="ghost" onClick={() => go('returning')}>
                  They don't match
                </Button>
                <Button onClick={() => void client.confirmDeviceLink()}>
                  <Check size={16} /> They match
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center py-4 text-center">
          <ShieldCheck size={48} className="text-accent" />
          <p className="mt-3 font-bold">Linked. Welcome back!</p>
        </div>
      )}
      {l?.step === 'waiting' && (
        <p className="mt-4 text-center text-xs text-faint">
          The code expires in 10 minutes. Your account is transferred end-to-end encrypted.
        </p>
      )}
    </>
  );
}

function Restore({ go }: { go: (s: Step) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = getClient();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await client.restoreAccount(key);
          client.finishOnboarding();
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <Header
        title="Recovery key"
        text="Paste the key you saved when you created your account."
        back={() => go('returning')}
      />
      <Label>Recovery key</Label>
      <Input
        autoFocus
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="XXXX-XXXX-…"
        className="font-mono"
      />
      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      <Button
        type="submit"
        className="mt-8 h-12 w-full text-base"
        disabled={key.replace(/[^a-z2-7]/gi, '').length < 50 || busy}
      >
        {busy ? 'Restoring…' : 'Restore'}
      </Button>
    </form>
  );
}

function SaveRecovery() {
  const client = getClient();
  const [recovery] = useState(() => client.recoveryKey());
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Header
        title="Keep your recovery key"
        text={
          <>
            This key <b className="text-text">is</b> your account. You'll need it if you lose all
            your devices. Store it in a password manager or on paper — never share it.
          </>
        }
      />
      <div className="selectable break-all rounded-2xl border border-dashed border-accent/50 bg-accent-soft p-5 text-center font-mono text-[15px] leading-relaxed tracking-wide text-accent">
        {recovery}
      </div>
      <Button
        variant="secondary"
        className="mt-3"
        onClick={async () => {
          await copyText(recovery);
          setCopied(true);
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy key'}
      </Button>
      <label className="mt-6 flex cursor-pointer items-center gap-2.5 text-sm text-text-2">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        I saved my recovery key somewhere safe
      </label>
      <Button
        className="mt-5 h-12 w-full text-base"
        disabled={!saved}
        onClick={() => client.finishOnboarding()}
      >
        Start talking
      </Button>
    </>
  );
}
