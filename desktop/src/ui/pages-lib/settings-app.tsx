import { useState } from 'react';
import { REPO, setUpdateCheck, updateCheckOn } from '../../core/updates.ts';
import { isNative } from '../../core/native.ts';
import { APP_VERSION, runUpdateCheck, useAvailableUpdate } from '../update-state.ts';
import { Card, Note } from './ops-ui.tsx';

// About the app itself rather than the runner: its version, and the one
// network call it makes on its own (docs/on-your-mac.md, "On Windows").
export function AppSection() {
  const [on, setOn] = useState(() => updateCheckOn(localStorage));
  const [said, setSaid] = useState<string>();
  const [busy, setBusy] = useState(false);
  const update = useAvailableUpdate();
  const toggle = (next: boolean) => {
    setOn(next);
    setUpdateCheck(localStorage, next);
  };
  const check = async () => {
    setBusy(true);
    setSaid(undefined);
    const found = await runUpdateCheck(true);
    setBusy(false);
    setSaid(found ? `Version ${found.version} is out.` : "You're on the newest release, or GitHub couldn't be reached.");
  };
  return (
    <Card>
      <h3>Threadbear for Windows {APP_VERSION}</h3>
      <label className="ops-row" title="Ask GitHub once a day whether a newer release is out. Nothing is downloaded or installed for you.">
        <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
        <span>Check for a newer release once a day</span>
      </label>
      <Note>
        It asks github.com/{REPO} for its latest release and sends nothing else, so GitHub sees this PC's address. {isNative() ? '' : 'Only the installed app does this.'}
      </Note>
      <div className="ops-row">
        <button onClick={() => void check()} disabled={busy} title="Ask GitHub now">
          Check now
        </button>
        {update && (
          <a href={update.page} title="Open the release page in your browser">
            Version {update.version} is out
          </a>
        )}
        {update?.download && (
          <a href={update.download} title="Download the installer for this PC">
            Download the installer
          </a>
        )}
        {said && !update && <Note>{said}</Note>}
      </div>
    </Card>
  );
}
