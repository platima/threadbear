// A design review waiting for an answer (docs/protocol.md, "Design reviews"):
// the options' pictures side by side, a pick (or several, or none) with notes
// per option, and a reply box. Sent with reviews.respond.

import { useState } from 'react';
import { errorText, type AppStore } from '../../core/store.ts';
import type { DesignReview, ReviewDraft } from '../../core/types.ts';
import { Picture } from './Picture.tsx';
import './thread.css';

type State = { picked: string[]; none: boolean; notes: Record<string, string>; reply: string };

// What has been typed stays when the person looks at another thread and comes back.
const kept = new Map<string, State>();

function fromDraft(d: ReviewDraft): State {
  return { picked: d.pickedIds ?? (d.pickedId ? [d.pickedId] : []), none: d.none === true, notes: { ...d.notes }, reply: d.reply ?? '' };
}

// The draft the runner takes: picks in the review's option order, notes only
// where something was written.
export function toDraft(review: DesignReview, s: State): ReviewDraft {
  const picked = review.options.map((o) => o.id).filter((id) => s.picked.includes(id));
  const notes = Object.fromEntries(Object.entries(s.notes).filter(([id, t]) => t.trim() && review.options.some((o) => o.id === id)).map(([id, t]) => [id, t.trim()]));
  const reply = s.reply.trim();
  return {
    ...(picked.length ? { pickedId: picked[0], ...(picked.length > 1 ? { pickedIds: picked } : {}) } : {}),
    notes,
    ...(reply ? { reply } : {}),
    ...(s.none && !picked.length ? { none: true as const } : {}),
  };
}

export function canAnswer(d: ReviewDraft): boolean {
  return !!d.pickedId || d.none === true || !!d.reply || Object.keys(d.notes).length > 0;
}

export function ReviewCard({ store, threadId, review }: { store: AppStore; threadId: string; review: DesignReview }) {
  const [s, setS] = useState<State>(() => kept.get(review.id) ?? fromDraft(review.draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const change = (f: (s: State) => State) =>
    setS((old) => {
      const next = f(old);
      kept.set(review.id, next);
      return next;
    });
  const draft = toDraft(review, s);
  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await store.respondReview(threadId, review, draft);
      kept.delete(review.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await store.cancelReview(threadId, review);
      kept.delete(review.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tb-review" id={`review-${review.id}`} role="group" aria-label={`Design review: ${review.title}`}>
      <div className="tb-review-head">
        <b>{review.title}</b>
        {review.note && <span className="note">{review.note}</span>}
      </div>
      <div className="tb-options">
        {review.options.map((o) => {
          const on = s.picked.includes(o.id);
          return (
            <div key={o.id} className={`tb-option${on ? ' on' : ''}`}>
              <Shots store={store} option={o} />
              <div className="tb-option-title">
                <b>
                  {o.id}. {o.title}
                </b>
                {o.url && /^https?:\/\//i.test(o.url) && (
                  <a className="tb-link" href={o.url} target="_blank" rel="noopener noreferrer" title={`Open ${o.url}`}>
                    Open live ↗
                  </a>
                )}
              </div>
              {o.note && <div className="note">{o.note}</div>}
              {o.reference ? (
                <div className="note">For reference. It can't be picked.</div>
              ) : (
                <label className="tb-pickrow" title={on ? `Take back the pick of ${o.id}` : `Pick ${o.id}. You can pick more than one.`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy}
                    onChange={() => change((x) => ({ ...x, none: false, picked: on ? x.picked.filter((p) => p !== o.id) : [...x.picked, o.id] }))}
                  />
                  Pick this one
                </label>
              )}
              <textarea
                rows={2}
                disabled={busy}
                placeholder="Notes on this one"
                title={`Notes on ${o.id}`}
                value={s.notes[o.id] ?? ''}
                onChange={(e) => change((x) => ({ ...x, notes: { ...x.notes, [o.id]: e.target.value } }))}
              />
            </div>
          );
        })}
      </div>
      <div className="tb-review-foot">
        <label className="tb-pickrow" title="None of these will do">
          <input type="checkbox" checked={s.none} disabled={busy} onChange={() => change((x) => ({ ...x, none: !x.none, picked: x.none ? x.picked : [] }))} />
          None of these
        </label>
        <textarea
          className="tb-reply"
          rows={2}
          disabled={busy}
          placeholder="Your reply"
          title="Your reply to the whole review"
          value={s.reply}
          onChange={(e) => change((x) => ({ ...x, reply: e.target.value }))}
        />
        <div className="btns">
          {error && <span className="error">{error}</span>}
          <span className="grow" />
          <button type="button" disabled={busy} title="Close this review without answering. Nothing is sent to the agent." onClick={() => void dismiss()}>
            Dismiss
          </button>
          <button type="button" className="primary" disabled={busy || !canAnswer(draft)} title={canAnswer(draft) ? 'Send your answer to the agent' : 'Pick one, write a note or a reply first'} onClick={() => void send()}>
            Send answer
          </button>
        </div>
      </div>
    </div>
  );
}

// An option's picture, with a way to step through its other shots.
function Shots({ store, option }: { store: AppStore; option: DesignReview['options'][number] }) {
  const shots = option.shots?.length ? option.shots : [{ image: option.image }];
  const [at, setAt] = useState(0);
  const shot = shots[Math.min(at, shots.length - 1)]!;
  return (
    <div className="tb-shots">
      <Picture store={store} image={shot.image} className="tb-shot" label={shot.title ?? option.title} />
      {shots.length > 1 && (
        <div className="tb-shotbar">
          {shots.map((sh, i) => (
            <button type="button" key={i} className={i === at ? 'on' : ''} title={sh.title ? `Show: ${sh.title}` : `Show picture ${i + 1}`} onClick={() => setAt(i)}>
              {sh.title || i + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
