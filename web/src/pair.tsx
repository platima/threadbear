// The app's first screen: which Threadbear to talk to. A pairing link opens it
// here from the camera (the QR code in the Mac or Windows app's Settings, Phone
// and browser, "Pair a phone"), or is pasted. Either way the person is asked
// before anything is kept, because the token goes to the address in the link.
import { useEffect, useState } from 'react';
import { savePairing, watchLinks } from './deployment';
import { parsePairing, type Pairing } from './pairing';

export function PairScreen({ expired }: { expired?: boolean }) {
  const [text, setText] = useState('');
  const [offer, setOffer] = useState<Pairing | undefined>();
  const [unreadable, setUnreadable] = useState(false);

  // A link that opened the app, or arrived while it was open.
  useEffect(() => {
    watchLinks((url) => {
      const found = parsePairing(url);
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

  if (offer) {
    const host = new URL(offer.url).host;
    return (
      <main className="signin pair">
        <img src="/icon.png" alt="" width={72} height={72} />
        <h1>Pair with {host}?</h1>
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
      <p>On your computer, open Threadbear, then Settings › Phone &amp; browser › Pair a phone. Point this phone’s camera at the code, and open the link it shows.</p>
      <p className="muted small">Or paste the link here, or the website’s sign-in link.</p>
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
