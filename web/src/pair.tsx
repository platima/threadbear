// The app's first screen: which Threadbear to talk to. A pairing link opens it
// here from the camera (the QR code in the Mac or Windows app's Settings, Phone
// and browser, "Pair a phone"), or is pasted. Either way the person is asked
// before anything is kept, because the token goes to the address in the link.
import { useEffect, useState } from 'react';
import { note, savePairing, watchLinks } from './deployment';
import { parsePairing, unusualAddress, type Pairing } from './pairing';
import { canScan, scanCode } from './scan';

export function PairScreen({ expired }: { expired?: boolean }) {
  const [text, setText] = useState('');
  const [offer, setOffer] = useState<Pairing | undefined>();
  const [unreadable, setUnreadable] = useState(false);
  // The scanner is open (it covers the app, so the page only waits), and why it would not open.
  const [scanning, setScanning] = useState(false);
  const [scanProblem, setScanProblem] = useState<string | undefined>();

  // A link that opened the app, or arrived while it was open.
  useEffect(() => {
    watchLinks((url) => {
      const found = parsePairing(url);
      // Only its shape goes to the log: the first characters and the length
      note(`a link of ${url.length} characters, beginning ${JSON.stringify(url.slice(0, 14))}, ${found ? 'is' : 'is not'} a pairing`);
      if (found) setOffer(found);
    });
  }, []);

  const read = (value: string) => {
    setText(value);
    const found = parsePairing(value);
    setOffer(found);
    setUnreadable(Boolean(value.trim()) && !found);
  };

  const paste = async () => {
    try {
      read(await navigator.clipboard.readText());
    } catch {
      setUnreadable(true);
    }
  };

  // Google's code scanner over the app. What it reads is treated as a pasted link is: only a
  // Threadbear pairing is offered, and the person is asked before it is kept.
  const scan = async () => {
    setScanning(true);
    setScanProblem(undefined);
    setUnreadable(false);
    try {
      const scanned = await scanCode();
      if ('text' in scanned) {
        // Not put in the box: a code that is not ours (a Wi-Fi code, a menu) has no business there.
        const found = parsePairing(scanned.text);
        setOffer(found);
        setUnreadable(!found);
      }
    } catch (e) {
      setScanProblem(e instanceof Error ? e.message : 'The scanner would not open');
    } finally {
      setScanning(false);
    }
  };

  if (offer) {
    const host = new URL(offer.url).host;
    return (
      <main className="signin pair">
        <img src="/icon.png" alt="" width={72} height={72} />
        <h1 style={{ overflowWrap: 'anywhere' }}>Pair with {host}?</h1>
        {unusualAddress(offer.url) ? (
          <p className="small bad" style={{ overflowWrap: 'anywhere' }}>
            That is not a Convex address: {offer.url}. It can be a backend you host yourself. If you did not set one up, do not pair.
          </p>
        ) : null}
        <p>This phone will show the threads of the Threadbear whose deployment that is, and can send to them. Only pair with one that is yours.</p>
        <p>
          <button className="primary" onClick={() => savePairing(offer)}>Pair</button>{' '}
          <button onClick={() => { setOffer(undefined); setText(''); }}>Not now</button>
        </p>
      </main>
    );
  }

  return (
    <main className="signin pair">
      <img src="/icon.png" alt="" width={72} height={72} />
      <h1>Threadbear</h1>
      <p>{expired ? 'This phone’s pairing has expired or been revoked.' : 'This phone isn’t paired yet.'}</p>
      <p>On your computer, open Threadbear, then Settings › Phone &amp; browser › Pair a phone.</p>
      {canScan() ? (
        <>
          <p>
            <button className="primary" disabled={scanning} onClick={() => void scan()}>{scanning ? 'Scanning…' : 'Scan the code'}</button>
          </p>
          {scanProblem ? <p className="small bad">{scanProblem}</p> : null}
          <p className="muted small">Or point this phone’s camera app at the code and open the link it shows, or paste the link here, or the website’s sign-in link.</p>
        </>
      ) : (
        <>
          <p>Point this phone’s camera at the code, and open the link it shows.</p>
          <p className="muted small">Or paste the link here, or the website’s sign-in link.</p>
        </>
      )}
      <textarea
        value={text}
        onChange={(e) => read(e.target.value)}
        rows={3}
        placeholder="threadbear://pair?url=…"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Pairing link"
      />
      {unreadable ? <p className="small bad">That isn’t a Threadbear pairing link.</p> : null}
      <p>
        <button onClick={() => void paste()}>Paste</button>
      </p>
    </main>
  );
}
