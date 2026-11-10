import { useState } from 'react';
import { errorText, type AppStore } from '../core/store.ts';
import type { Row } from '../core/model.ts';
import { stackedAnswer, stackedCalls, tickedCount } from '../core/queued.ts';

// An approval, a question or a secret the agent is waiting on. Once answered
// it stays in the transcript as a quiet line.
type Props = { row: Row; store: AppStore; threadId: string };

export function Card(p: Props) {
  const type = p.row.card!.type;
  if (type === 'approval') return <ApprovalCard {...p} />;
  if (type === 'question') return <QuestionCard {...p} />;
  return <SecretCard {...p} />;
}

function useAct() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, act, error };
}

const payload = (input: Record<string, unknown>) => (typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2));

// A card with calls queued behind it: every call with its tick and cross, then
// Allow (as many as are ticked) and Deny all. Always allow is left out.
function StackedApproval({ c, store, threadId }: { c: Extract<NonNullable<Row['card']>, { type: 'approval' }>; store: AppStore; threadId: string }) {
  const { busy, act, error } = useAct();
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const calls = stackedCalls(c, c.queued ?? []);
  const count = tickedCount(calls, unticked);
  const set = (key: string, ticked: boolean) =>
    setUnticked((was) => {
      const next = new Set(was);
      if (ticked) next.delete(key);
      else next.add(key);
      return next;
    });
  const send = (allow: boolean) => {
    const { decision, queued } = stackedAnswer(calls, unticked, allow);
    return act(() => store.respond(threadId, c.approvalId, decision, { queued }));
  };
  return (
    <div className="card">
      <h3>{calls.length} things the agent wants to do</h3>
      {calls.map((call) => {
        const ticked = !unticked.has(call.key);
        return (
          <div key={call.key} className={`stacked-call${ticked ? '' : ' off'}`}>
            <div className="stacked-head">
              <span className="stacked-title">{call.title}</span>
              <span className="stacked-toggles">
                <button className={ticked ? 'primary' : ''} disabled={busy} aria-pressed={ticked} title="Allow this one" onClick={() => set(call.key, true)}>
                  ✓
                </button>
                <button className={ticked ? '' : 'primary'} disabled={busy} aria-pressed={!ticked} title="Do not allow this one; the agent is told no" onClick={() => set(call.key, false)}>
                  ✕
                </button>
              </span>
            </div>
            <pre>{payload(call.input)}</pre>
          </div>
        );
      })}
      <div className="btns">
        <button className="primary" disabled={busy || count === 0} title={count === calls.length ? 'Let the agent do all of these' : 'Let the agent do the ticked ones; the rest are refused'} onClick={() => void send(true)}>
          Allow {count}
        </button>
        <button disabled={busy} title="Do not let the agent do any of these; it is told no" onClick={() => void send(false)}>
          Deny all
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function ApprovalCard({ row, store, threadId }: Props) {
  const c = row.card!;
  const { busy, act, error } = useAct();
  if (c.type !== 'approval') return null;
  const done = c.decision !== undefined;
  if (!done && c.queued?.length) return <StackedApproval c={c} store={store} threadId={threadId} />;
  return (
    <div className={`card${done ? ' done' : ''}`}>
      <h3>{done ? `${c.title} (${c.decision})` : c.title}</h3>
      {!done && <pre>{payload(c.input)}</pre>}
      {!done && (
        <div className="btns">
          {c.options.includes('allow') && (
            <button className="primary" disabled={busy} title="Let the agent do this once" onClick={() => void act(() => store.respond(threadId, c.approvalId, 'allow'))}>
              Allow
            </button>
          )}
          {c.options.includes('allowAlways') && (
            <button disabled={busy} title="Let the agent do this, and anything like it, for the rest of this thread" onClick={() => void act(() => store.respond(threadId, c.approvalId, 'allowAlways'))}>
              Always allow in this thread
            </button>
          )}
          {c.options.includes('deny') && (
            <button disabled={busy} title="Do not let the agent do this" onClick={() => void act(() => store.respond(threadId, c.approvalId, 'deny'))}>
              Deny
            </button>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function SecretCard({ row, store, threadId }: Props) {
  const c = row.card!;
  const { busy, act, error } = useAct();
  const [value, setValue] = useState('');
  if (c.type !== 'secret') return null;
  const done = c.decision !== undefined;
  return (
    <div className={`card${done ? ' done' : ''}`}>
      <h3>{c.label}</h3>
      <div className="note">{c.reason}</div>
      {!done && (
        <div className="btns">
          <input type="password" autoComplete="off" title="The value the agent asked for. It is not shown or kept in the transcript." placeholder={c.placeholder ?? 'Value'} value={value} onChange={(e) => setValue(e.target.value)} />
          <button className="primary" disabled={busy || !value} title="Give the agent this value" onClick={() => void act(() => store.answerSecret(threadId, c.approvalId, value))}>
            Send
          </button>
          <button disabled={busy} title="Do not give the agent a value" onClick={() => void act(() => store.answerSecret(threadId, c.approvalId))}>
            Decline
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function QuestionCard({ row, store, threadId }: Props) {
  const c = row.card!;
  const { busy, act, error } = useAct();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  if (c.type !== 'question') return null;
  const done = c.decision !== undefined;
  const answers = Object.fromEntries(c.questions.map((q) => [q.question, (picked[q.question] ?? []).join(', ')]));
  const ready = c.questions.every((q) => (picked[q.question] ?? []).length > 0);
  const choose = (q: (typeof c.questions)[number], label: string) => {
    const now = picked[q.question] ?? [];
    const next = q.multiSelect ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label];
    setPicked({ ...picked, [q.question]: next });
  };
  return (
    <div className={`card${done ? ' done' : ''}`}>
      {c.questions.map((q) => (
        <div key={q.question}>
          <h3>
            {q.header ? `${q.header}: ` : ''}
            {q.question}
          </h3>
          {!done &&
            q.options.map((o) => (
              <label key={o.label} className="opt" title={o.description ?? o.label}>
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={q.question} checked={(picked[q.question] ?? []).includes(o.label)} onChange={() => choose(q, o.label)} /> {o.label}
                {o.description && <small>{o.description}</small>}
              </label>
            ))}
        </div>
      ))}
      {done && c.message && <div className="note">{c.message}</div>}
      {!done && (
        <div className="btns">
          <button className="primary" disabled={busy || !ready} title={ready ? 'Send these answers to the agent' : 'Pick an answer for each question first'} onClick={() => void act(() => store.respond(threadId, c.approvalId, 'answered', { answers, message: Object.values(answers).join('; ') }))}>
            Answer
          </button>
          <button disabled={busy} title="Do not answer these questions" onClick={() => void act(() => store.respond(threadId, c.approvalId, 'deny'))}>
            Skip
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
