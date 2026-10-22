import { useState } from 'react';
import { Check, ShieldCheck, Smartphone } from 'lucide-react';
import { closeModal, getClient, useCroc } from '../croc';
import { Button, Input, Label, Modal } from '../components/ui';

/** On a signed-in device: enter the code a new device shows, compare, confirm. */
export function LinkDeviceModal() {
  const linking = useCroc((s) => s.linking);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = getClient();
  const step = linking?.role === 'existing' ? linking.step : 'enter';
  const done = () => {
    client.store.set({ linking: null });
    closeModal();
  };
  return (
    <Modal
      icon={<Smartphone size={22} />}
      title="Link another device"
      subtitle="On the new device, open Crocodile and choose “I already use Crocodile” → “Link from another device”. It will show a code."
      onClose={done}
      footer={
        step === 'enter' ? (
          <>
            <Button variant="ghost" onClick={done}>
              Cancel
            </Button>
            <Button
              disabled={code.replace(/[^a-z2-7]/gi, '').length < 8 || busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await client.claimDeviceLink(code);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Continue
            </Button>
          </>
        ) : step === 'confirm' ? (
          <>
            <Button variant="ghost" onClick={done}>
              They don't match
            </Button>
            <Button
              onClick={() => void client.confirmDeviceLink().catch((e) => setError(e.message))}
            >
              <Check size={16} /> They match — link it
            </Button>
          </>
        ) : (
          <Button onClick={done}>Done</Button>
        )
      }
    >
      {step === 'enter' && (
        <>
          <Label>Code shown on the new device</Label>
          <Input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD2345"
            className="text-center font-mono text-lg tracking-[0.3em]"
          />
        </>
      )}
      {step === 'confirm' && linking?.role === 'existing' && (
        <div className="text-center">
          <p className="text-sm text-muted">
            Check that the new device shows exactly this security code:
          </p>
          <div className="selectable mt-4 rounded-2xl bg-accent-soft py-5 font-mono text-4xl font-bold tracking-widest text-accent">
            {linking.securityCode}
          </div>
          <p className="mt-3 text-xs text-faint">
            If the codes differ, someone may be trying to intercept the link. Cancel.
          </p>
        </div>
      )}
      {step === 'sent' && (
        <div className="flex flex-col items-center py-4 text-center">
          <ShieldCheck size={44} className="text-accent" />
          <p className="mt-3 font-semibold">
            Your account was sent to the new device, end-to-end encrypted.
          </p>
          <p className="mt-2 text-sm text-muted">
            Confirm the code on the new device too, if you haven't yet.
          </p>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </Modal>
  );
}
