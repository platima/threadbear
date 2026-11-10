import { useEffect, useState } from 'react';
import type { AppStore, Snapshot } from '../../core/store.ts';
import { pairingOffNote } from './devices-words.ts';
import { dateWords } from './ops-format.ts';
import { QrCode } from './qr.tsx';
import { useAction, useRequest } from './ops-rpc.ts';
import type { Device } from './ops-types.ts';
import { Card, Chip, ConfirmBar, Note, Problem } from './ops-ui.tsx';

type Pairing = { kind: 'phone' | 'browser'; name: string; link: string };

export function DevicesSection({ store, snap }: { store: AppStore; snap: Snapshot }) {
  const req = useRequest<{ devices: Device[]; site?: string; reason?: string }>(store, snap.conn, 'devices.list');
  const [devices, setDevices] = useState<Device[]>();
  const [kind, setKind] = useState<'phone' | 'browser'>('phone');
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [pairing, setPairing] = useState<Pairing>();
  const [revoking, setRevoking] = useState<Device>();
  const [copied, setCopied] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const act = useAction();

  useEffect(() => {
    if (req.data) setDevices(req.data.devices);
  }, [req.data]);

  const reason = req.data?.reason;
  const off = !!reason && !req.data?.site;

  const pair = async () => {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      setLocalError('Days needs a whole number from 1 to 365.');
      return;
    }
    setLocalError(undefined);
    const r = await act.run('pair', () => store.rpc.request<{ device: Device; pairingLink?: string; signInLink?: string }>('devices.pair', { kind, ...(name.trim() ? { name: name.trim() } : {}), days: n }));
    if (!r) return;
    setDevices((d) => [r.device, ...(d ?? [])]);
    setName('');
    setCopied(false);
    const link = kind === 'phone' ? r.pairingLink : r.signInLink;
    setPairing(link ? { kind, name: r.device.name, link } : undefined);
    void req.reload();
  };

  const revoke = async (d: Device) => {
    setRevoking(undefined);
    const r = await act.run('revoke', () => store.rpc.request<{ devices: Device[] }>('devices.revoke', { deviceId: d.id }));
    if (r) setDevices(r.devices);
  };

  return (
    <>
      <Problem error={req.error} what="Phones and browsers" />
      {snap.conn !== 'open' && <Note>The runner isn't connected, so there is nothing to pair with yet. Once it is, the button below works.</Note>}
      {off && <Note>{pairingOffNote(reason ?? '')}</Note>}

      <Card>
        <h3>Pair something new</h3>
        <Note>A phone scans a code. A browser signs in through a link. Either one can read your threads until it expires or you sign it out.</Note>
        <div className="ops-row">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'phone' | 'browser')} title="What you are pairing">
            <option value="phone">Phone</option>
            <option value="browser">Browser</option>
          </select>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'phone' ? 'Name (iPhone)' : 'Name (Browser)'} title="A name to tell it apart in the list" />
          <span className="set-inline">
            <input className="set-days" type="number" min={1} max={365} step={1} value={days} onChange={(e) => setDays(e.target.value)} title="How many days until it stops working, 1 to 365" /> days
          </span>
          <button className="primary" onClick={() => void pair()} disabled={act.busy === 'pair' || off || snap.conn !== 'open'} title={snap.conn !== 'open' ? "Not connected to the runner, so there is nothing to pair with yet" : off ? "The sync backend is off, so nothing can pair" : kind === 'phone' ? 'Make a code for a phone to scan' : 'Make a sign-in link for a browser'}>
            {kind === 'phone' ? 'Show a code' : 'Make a link'}
          </button>
        </div>
        {(localError || act.error) && <Note tone="bad">{localError ?? act.error}</Note>}

        {pairing && (
          <div className="set-pairing">
            {pairing.kind === 'phone' ? (
              <>
                <QrCode text={pairing.link} label={`Pairing code for ${pairing.name}`} />
                <div className="set-pairing-text">
                  <p>
                    Open Threadbear on the phone and scan this code. It holds a sign-in for {pairing.name}, so don't share a picture of it. It is shown once and not kept.
                  </p>
                  <button onClick={() => setPairing(undefined)} title="Hide the code and forget it">
                    Done
                  </button>
                </div>
              </>
            ) : (
              <div className="set-pairing-text">
                <p>
                  This link signs {pairing.name} in. It carries the sign-in, so open it only in the browser you mean to use. It is shown once and not kept.
                </p>
                <div className="ops-row">
                  <a className="set-link" href={pairing.link} target="_blank" rel="noopener noreferrer" title="Open the sign-in page in your browser">
                    Open the sign-in page
                  </a>
                  <button
                    onClick={() => {
                      void navigator.clipboard?.writeText(pairing.link).then(() => setCopied(true), () => setCopied(false));
                    }}
                    title="Copy the sign-in link"
                  >
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                  <button onClick={() => setPairing(undefined)} title="Hide the link and forget it">
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card>
        <h3>Paired phones and browsers</h3>
        {revoking && <ConfirmBar text={`Sign out ${revoking.name}? It stops working at its next request and shows its sign-in screen again.`} yes="Sign it out" onYes={() => void revoke(revoking)} onNo={() => setRevoking(undefined)} busy={act.busy === 'revoke'} />}
        {devices?.length ? (
          <div className="set-devices">
            {devices.map((d) => (
              <div className="set-device" key={d.id}>
                <span className="set-device-name">{d.name}</span>
                <Chip>{d.kind === 'phone' ? 'Phone' : 'Browser'}</Chip>
                {d.expired && <Chip tone="warn" title="It stopped working when it expired">Expired</Chip>}
                <span className="ops-sub">
                  Paired {dateWords(d.createdAt)}, {d.expired ? 'expired' : 'expires'} {dateWords(d.expiresAt)}
                </span>
                <span className="ops-spacer" />
                <button className="ghost" onClick={() => setRevoking(d)} disabled={act.busy === 'revoke'} title={`Sign ${d.name} out`}>
                  Sign out
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Note>{req.data || devices ? 'Nothing is paired.' : req.error ? "The list isn't available." : snap.conn === 'open' ? 'Loading...' : 'Waiting for the runner.'}</Note>
        )}
      </Card>
    </>
  );
}
