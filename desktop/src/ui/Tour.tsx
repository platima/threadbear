import { useState } from 'react';
import type { AppStore, Snapshot } from '../core/store.ts';

// A short first-run tour: a card in the corner that walks through the window
// using the runner's sample threads (made-up exchanges, no model involved).
// It starts by itself once, on a window with no threads, and again from the
// shortcuts list.

type Step = { title: string; body: string; go?: 'threads' | 'rail'; openNeedsYou?: boolean };

const STEPS: Step[] = [
  { title: 'Welcome to Threadbear', body: 'Threads are conversations with an agent. Each one runs in a folder on this PC and keeps going while you do something else. This tour uses three made-up threads, which it will add now and offer to remove at the end.' },
  { title: 'The inbox', body: 'The sidebar puts the threads that need you in the Inbox, the ones working in Running, and the ones you have put away under Hibernating and Archived. A coloured dot says which is which: orange needs you, green is working, blue is unread.', go: 'threads' },
  { title: 'Questions at the bottom', body: 'When an agent needs something from you, its questions sit joined to the message box. Pick an answer or write your own, then send. This sample is waiting on one.', go: 'threads', openNeedsYou: true },
  { title: 'The side pane', body: 'The buttons above a thread open its side pane: what the agent made and pinned (Highlights), buttons a project adds (Actions), sub-agents, and a browser for the thread\'s folder (Files).', go: 'threads' },
  { title: 'The rail', body: 'The strip on the left switches between Threads, Projects, Schedules, Usage, Runners and Settings. Ctrl+1 to Ctrl+9 jump to them, and Ctrl+/ lists every shortcut.', go: 'rail' },
];

export const TOUR_KEY = 'threadbear.tourDone';

export function Tour({ store, snap, close }: { store: AppStore; snap: Snapshot; close: () => void }) {
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;
  const sep = (snap.hello?.defaults.cwd ?? '').includes('\\') ? '\\' : '/';
  const cwd = `${snap.hello?.defaults.cwd ?? ''}${sep}Welcome`;

  const finish = async (remove: boolean) => {
    setBusy(true);
    try {
      if (remove) await store.rpc.request('threads.samples', { cwd, remove: true });
    } catch (e) {
      setError((e as Error).message);
    }
    try {
      localStorage.setItem(TOUR_KEY, '1');
    } catch {
      // asked again next time
    }
    close();
  };

  const next = async () => {
    setError(undefined);
    setBusy(true);
    try {
      if (i === 0) await store.rpc.request('threads.samples', { cwd });
      const target = STEPS[i + 1];
      if (target?.openNeedsYou) {
        const t = [...store.getSnapshot().threads.values()].find((x) => x.sample && x.needs === 'you');
        if (t) await store.open(t.id);
      }
      setI(i + 1);
    } catch (e) {
      setError(`Couldn't add the sample threads: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tour" role="dialog" aria-label="Tour">
      <div className="note">
        {i + 1} of {STEPS.length}
      </div>
      <h3>{step.title}</h3>
      <p>{step.body}</p>
      {error && <p className="error">{error}</p>}
      <div className="btns">
        {i > 0 && (
          <button disabled={busy} title="Go back to the previous step of the tour" onClick={() => setI(i - 1)}>
            Back
          </button>
        )}
        <span className="grow" />
        {!last && (
          <button className="ghost" disabled={busy} title="Close the tour" onClick={() => void finish(i > 0)}>
            Skip
          </button>
        )}
        {!last ? (
          <button className="primary" disabled={busy} title="Go on to the next step of the tour" onClick={() => void next()}>
            {i === 0 ? 'Start' : 'Next'}
          </button>
        ) : (
          <>
            <button disabled={busy} title="Keep the sample threads" onClick={() => void finish(false)}>
              Keep the samples
            </button>
            <button className="primary" disabled={busy} title="Delete the sample threads and finish" onClick={() => void finish(true)}>
              Remove them and finish
            </button>
          </>
        )}
      </div>
    </div>
  );
}
