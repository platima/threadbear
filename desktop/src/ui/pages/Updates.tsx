import { useState } from 'react';
import type { PageDef, PageProps } from '../registry.ts';
import { APP_VERSION, runUpdateCheck, useAvailableUpdate } from '../update-state.ts';
import { CliSection } from '../pages-lib/settings-cli.tsx';
import { Card, Facts, Note } from '../pages-lib/ops-ui.tsx';
import { followingWords, oldRunnerWords, upstreamWords } from '../pages-lib/updates-words.ts';

// What can be updated, in one place (the Mac app's Updates panel): this app, the
// runner behind it, and the Claude Code program the runner starts. The app's own
// update is installing a newer release over it, which this page links to and
// never does for you.
function UpdatesPage({ store, snap }: PageProps) {
  const update = useAvailableUpdate();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();
  const check = async () => {
    setBusy(true);
    setSaid(undefined);
    try {
      const found = await runUpdateCheck(true);
      setSaid(found ? `Version ${found.version} is out.` : "You're on the newest release, or GitHub couldn't be reached.");
    } catch {
      setSaid("The check didn't finish. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };
  const updates = snap.hello?.updates;
  const following = followingWords(updates);
  const old = oldRunnerWords(updates);
  const upstream = upstreamWords(updates?.upstream);
  return (
    <div className="page ops">
      <div className="ops-col">
        <div className="ops-title">
          <h2>Updates</h2>
        </div>

        <Card>
          <h3>This app</h3>
          <Facts
            rows={[
              ['Version', APP_VERSION],
              [
                'Newer release',
                update ? (
                  <a href={update.page} target="_blank" rel="noopener noreferrer" title="Open the release's page in your browser">
                    Version {update.version}
                  </a>
                ) : (
                  'None known'
                ),
              ],
            ]}
          />
          <div className="ops-row">
            <button onClick={() => void check()} disabled={busy} title="Ask GitHub now whether a newer release is out">
              Check now
            </button>
            {update?.download && (
              <a href={update.download} target="_blank" rel="noopener noreferrer" title="Download the installer for this PC. Run it over this copy to update.">
                Download the installer
              </a>
            )}
          </div>
          {said && !update && <Note>{said}</Note>}
          <Note>Updating the app is installing the newer release over this one; nothing is downloaded or installed for you. The daily check can be turned off in Settings, This app.</Note>
        </Card>

        <Card>
          <h3>Runner</h3>
          {snap.hello ? (
            <>
              <Facts rows={[['Version', snap.hello.runnerVersion]]} />
              <Note tone={following.tone}>{following.text}</Note>
              {old && <Note>{old.text}</Note>}
              {updates?.launcherChanged && updates.launcherReason && <Note tone="warn">{updates.launcherReason}</Note>}
            </>
          ) : (
            <Note>Waiting for the runner.</Note>
          )}
        </Card>

        {upstream && (
          <Card>
            <h3>Releases this copy follows</h3>
            <Note tone={upstream.tone}>{upstream.text}</Note>
            {updates?.upstream?.release?.important?.map((i) => (
              <Note key={i.commit} tone="warn">
                Important: {i.why}
              </Note>
            ))}
          </Card>
        )}

        <div className="ops-title">
          <h3>Claude Code</h3>
        </div>
        <CliSection store={store} snap={snap} />
      </div>
    </div>
  );
}

const page: PageDef = {
  id: 'updates',
  title: 'Updates',
  hint: "Whether a newer release of this app is out, how the runner updates, and the Claude Code program's version",
  icon: '⬇︎',
  order: 55,
  Main: UpdatesPage,
};
export default page;
