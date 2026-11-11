import { useEffect } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { sentWords } from './view-logic';

// What happened to the last thing sent: the runner takes a command within a
// second or two while it's online, so "waiting" for longer means the computer
// is asleep or offline. `where` is the runner it went to, as runnerWords says
// it; a caller that can't tell leaves it as "your computer".
export function CommandState({ token, commandId, onDone, where }: { token: string; commandId: Id<'commands'>; onDone: () => void; where?: string }) {
  const c = useQuery(api.phone.command, { token, commandId });
  useEffect(() => {
    if (c?.state !== 'done') return;
    const t = setTimeout(onDone, 1200);
    return () => clearTimeout(t);
  }, [c?.state, onDone]);
  if (!c || c.state === 'done') return null;
  return (
    <div className={`command ${c.state}`}>
      {c.state === 'pending' || c.state === 'taken' ? `${sentWords(c.state, where)}…` : `Didn’t work: ${c.note ?? 'unknown error'}`}
      {c.state === 'failed' ? (
        <button className="link" onClick={onDone}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
