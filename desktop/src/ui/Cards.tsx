import { useState } from 'react';
import { errorText, type AppStore } from '../core/store.ts';
import type { Row } from '../core/model.ts';

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

function ApprovalCard({ row, store, threadId }: Props) {
  const c = row.card!;
  const { busy, act, error } = useAct();
  if (c.type !== 'approval') return null;
  const done = c.decision !== undefined;
  const command = typeof c.input.command === 'string' ? c.input.command : undefined;
  return (
    <div className={`card${done ? ' done' : ''}`}>
      <h3>{done ? `${c.title} (${c.decision})` : c.title}</h3>
      {!done && <pre>{command ?? JSON.stringify(c.input, null, 2)}</pre>}
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
