import { useState } from 'react';
import { REPO, setUpdateCheck, updateCheckOn } from '../../core/updates.ts';
import { isNative } from '../../core/native.ts';
import { APP_VERSION, runUpdateCheck, useAvailableUpdate, useSessionKeepsSettings } from '../update-state.ts';
import { Card, Note } from './ops-ui.tsx';

// About the app itself rather than the runner: its version, and the one
// network call it makes on its own (docs/on-your-mac.md, "On Windows").
export function AppSection() {
  const [on, setOn] = useState(() => updateCheckOn(localStorage));
  const [said, setSaid] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const update = useAvailableUpdate();
  const keeps = useSessionKeepsSettings();
  const toggle = (next: boolean) => {
    const stuck = setUpdateCheck(localStorage, next);
    setUnsaved(!stuck);
    setOn(stuck ? next : updateCheckOn(localStorage));
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
        <input type="checkbox" checked={on} title="Ask GitHub once a day whether a newer release is out" onChange={(e) => toggle(e.target.checked)} />
        <span>Check for a newer release once a day</span>
      </label>
      <Note>
        It asks github.com/{REPO} for its latest release and sends nothing else, so GitHub sees this PC's address. {isNative() ? '' : 'Only the installed app does this.'}
      </Note>
      {unsaved && <Note>This window can't keep the choice, so the daily check stays off. Check now still works.</Note>}
      {isNative() && keeps === false && <Note>This run started without your saved settings, so the daily check is waiting for the next start. Check now still works.</Note>}
      <div className="ops-row">
        <button onClick={() => void check()} disabled={busy} title="Ask GitHub now">
          Check now
        </button>
        {update && (
          <a href={update.page} target="_blank" rel="noopener noreferrer" title="Open the release page in your browser">
            Version {update.version} is out
          </a>
        )}
        {update?.download && (
          <a href={update.download} target="_blank" rel="noopener noreferrer" title="Download the installer for this PC">
            Download the installer
          </a>
        )}
        {said && !update && <Note>{said}</Note>}
      </div>
    </Card>
  );
}
