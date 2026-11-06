// What sits joined to the composer at the bottom of a thread when the last
// turn ended: the open card of asks (docs/protocol.md, "Needs you"), or the
// done card with its suggested follow-ups.

import { useRef, useState } from 'react';
import { errorText, type AppStore } from '../../core/store.ts';
import type { Ask, OpenAsk, ThreadSummary } from '../../core/types.ts';
import { Md } from './Md.tsx';
import { Menu } from './Menu.tsx';
import { choices, oneLine, type Picked } from './text.ts';
import './thread.css';

// ---- the person's picks on one card of asks, kept by the composer ----------

export type AsksDraft = {
  picks: Record<number, number | 'other'>; // ask index to the option picked, or their own words
  custom: Record<number, string>; // their own words, kept while the box is closed
};

const empty = (): AsksDraft => ({ picks: {}, custom: {} });

// One card's picks. A new card (another asksSeq or thread) starts clean.
export function useAsksDraft(key: string) {
  const [state, setState] = useState<{ key: string; draft: AsksDraft }>({ key, draft: empty() });
  const draft = state.key === key ? state.draft : empty();
  const change = (f: (d: AsksDraft) => AsksDraft) => setState({ key, draft: f(draft) });
  return {
    draft,
    pick: (ask: number, to: number | 'other') =>
      change((d) => {
        const picks = { ...d.picks };
        if (picks[ask] === to) delete picks[ask];
        else picks[ask] = to;
        return { ...d, picks };
      }),
    write: (ask: number, text: string) => change((d) => ({ ...d, custom: { ...d.custom, [ask]: text }, picks: { ...d.picks, [ask]: 'other' } })),
    clear: () => setState({ key, draft: empty() }),
  };
}
export type AsksApi = ReturnType<typeof useAsksDraft>;

// The asks that have an answer, in the card's order.
export function pickedAnswers(asks: Ask[], d: AsksDraft): Picked[] {
  return asks.flatMap((a, i) => {
    const p = d.picks[i];
    if (p === 'other') {
      const own = (d.custom[i] ?? '').trim();
      return own ? [{ index: i, action: a.action, answer: own }] : [];
    }
    const c = p === undefined ? undefined : choices(a)[p];
    return c !== undefined ? [{ index: i, action: a.action, answer: c }] : [];
  });
}

// ---- the card of asks ------------------------------------------------------

export function AsksCard({ store, thread, asks, api, send, sending }: { store: AppStore; thread: ThreadSummary; asks: OpenAsk[]; api: AsksApi; send: () => void; sending: boolean }) {
  const [error, setError] = useState<string>();
  // A tick shows at once and is dropped again when the runner answers.
  const [local, setLocal] = useState<Record<number, boolean>>({});
  const live = store.model.ticks.get(thread.asksSeq ?? -1);
  const ticked = (i: number): boolean => local[i] ?? (live ? live.has(i) : asks[i]?.ticked === true);
  const tick = (i: number) => {
    if (thread.asksSeq === undefined) return;
    const to = !ticked(i);
    setLocal((l) => ({ ...l, [i]: to }));
    setError(undefined);
    store
      .tickAsk(thread.id, thread.asksSeq, i, to)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLocal((l) => Object.fromEntries(Object.entries(l).filter(([k]) => Number(k) !== i))));
  };
  return (
    <div className="tb-asks" role="group" aria-label="What the agent needs from you">
      {asks.map((a, i) => (
        <AskRow key={i} store={store} index={i} count={asks.length} ask={a} ticked={ticked(i)} tick={() => tick(i)} api={api} send={send} sending={sending} />
      ))}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function AskRow({ store, index, count, ask, ticked, tick, api, send, sending }: { store: AppStore; index: number; count: number; ask: OpenAsk; ticked: boolean; tick: () => void; api: AsksApi; send: () => void; sending: boolean }) {
  const opts = choices(ask);
  const mine = api.draft.picks[index];
  const box = useRef<HTMLTextAreaElement>(null);
  return (
    <div className={`tb-ask${ticked ? ' ticked' : ''}`}>
      <input type="checkbox" className="tb-tickbox" checked={ticked} onChange={tick} title={ticked ? 'Not dealt with yet' : 'Mark this as dealt with. Nothing is sent.'} aria-label="Dealt with" />
      <div className="tb-ask-body">
        <div className="tb-ask-text">
          {count > 1 && <span className="tb-num">{index + 1}.</span>}
          <Md text={oneLine(ask.action)} />
        </div>
        {ask.why?.trim() && (
          <div className="tb-why">
            <Md text={ask.why.trim()} />
          </div>
        )}
        {ask.where && <div className="note">{ask.where}</div>}
        {!!ask.links?.length && (
          <div className="tb-links">
            {ask.links.map((l) => (
              <LinkButton key={l.url} title={l.title} url={l.url} />
            ))}
          </div>
        )}
        <div className="tb-opts">
          {opts.map((o, n) => (
            <button type="button" key={n} className={`tb-opt${mine === n ? ' on' : ''}`} aria-pressed={mine === n} title={mine === n ? 'Take this answer back' : `Answer: ${o}`} onClick={() => api.pick(index, n)}>
              <span className="tb-radio" />
              <span className="tb-opt-text">
                <span>
                  {o}
                  {ask.suggested === n && <span className="tb-mine">my pick</span>}
                </span>
                {ask.optionNotes?.[n] && <small>{ask.optionNotes[n]}</small>}
              </span>
            </button>
          ))}
          <button
            type="button"
            className={`tb-opt${mine === 'other' ? ' on' : ''}`}
            aria-pressed={mine === 'other'}
            title="Answer in your own words"
            onClick={() => {
              api.pick(index, 'other');
              setTimeout(() => box.current?.focus(), 0);
            }}
          >
            <span className="tb-radio" />
            <span className="tb-opt-text">Something else</span>
          </button>
          {mine === 'other' && (
            <textarea
              ref={box}
              className="tb-own"
              rows={2}
              autoFocus
              disabled={sending}
              title="Your own answer. Enter sends, Shift and Enter makes a new line."
              placeholder="Your own answer"
              value={api.draft.custom[index] ?? ''}
              onChange={(e) => api.write(index, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LinkButton({ title, url }: { title: string; url: string }) {
  const [copied, setCopied] = useState(false);
  if (/^https?:\/\//i.test(url)) {
    return (
      <a className="tb-link" href={url} target="_blank" rel="noopener noreferrer" title={url}>
        {title} ↗
      </a>
    );
  }
  if (url.startsWith('review:')) {
    return (
      <button type="button" className="tb-link" title="Show this design review" onClick={() => document.getElementById(`review-${url.slice(7)}`)?.scrollIntoView({ block: 'nearest' })}>
        {title}
      </button>
    );
  }
  // A file or folder on the runner's machine: a web page can't open it, so the
  // path is copied.
  let path = url.replace(/^file:\/\//i, '');
  try {
    path = decodeURI(path);
  } catch {
    // leave it as written
  }
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return (
    <button
      type="button"
      className="tb-link"
      title={`On the runner's machine: ${path}. Click to copy the path.`}
      onClick={() => {
        void navigator.clipboard?.writeText(path).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Path copied' : title}
    </button>
  );
}

// ---- the done card ---------------------------------------------------------

const VERDICTS: { key: string; label: string; verdict?: 'worked' | 'didntWork' | 'notNeeded'; note: string }[] = [
  { key: 'worked', label: 'It worked', verdict: 'worked', note: 'Archive, and say it did what you wanted' },
  { key: 'didntWork', label: "It didn't work", verdict: 'didntWork', note: 'Archive, and say it fell short' },
  { key: 'notNeeded', label: 'Not needed', verdict: 'notNeeded', note: 'Archive, and say it was not wanted' },
  { key: 'plain', label: 'Just archive', note: 'Archive without saying how it went' },
];

export function DoneCard({ store, thread, next, add }: { store: AppStore; thread: ThreadSummary; next: string[]; add: (text: string) => void }) {
  const [error, setError] = useState<string>();
  const archive = (verdict?: 'worked' | 'didntWork' | 'notNeeded') => {
    setError(undefined);
    store.update(thread.id, { archived: true, archivedBy: 'mike', ...(verdict ? { verdict } : {}) }).catch((e: unknown) => setError(errorText(e)));
  };
  return (
    <div className="tb-done" role="group" aria-label="This turn is finished">
      <div className="tb-done-head">
        <span>Done. Nothing needed from you.</span>
        <span className="grow" />
        {error && <span className="error">{error}</span>}
        <Menu label="Archive" title="Put this thread away" items={VERDICTS.map((v) => ({ key: v.key, label: v.label, note: v.note, onPick: () => archive(v.verdict) }))} />
      </div>
      {next.length > 0 && (
        <div className="tb-next">
          {next.map((n, i) => (
            <button type="button" key={i} className="tb-follow" title="Put this in the message box. It isn't sent until you send it." onClick={() => add(n)}>
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
