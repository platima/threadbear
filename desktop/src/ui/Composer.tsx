import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorText, type AppStore, type Snapshot } from '../core/store.ts';
import { agentsStillWorking, type EffortLevel, type ImageRef, type PermissionMode } from '../core/types.ts';
import { AsksCard, DoneCard, pickedAnswers, useAsksDraft } from './thread/Dock.tsx';
import { ReviewCard } from './thread/ReviewCard.tsx';
import { EffortMenu, ModeMenu, ModelMenu } from './thread/Controls.tsx';
import { answerMessage, dropMarker, insertMarker } from './thread/text.ts';
import './thread/thread.css';
import { isNative, pickFolder } from '../core/native.ts';

// A picture on its way into the next message. Its number is its place in the
// list, which is what the [Picture N] marker in the text means.
type Att = { id: string; name: string; preview: string; status: 'sending' | 'ready'; ref?: ImageRef };
type Draft = { text: string; atts: Att[] };

const MAX_PICTURE = 20 * 1024 * 1024;
let attSeq = 0;
// Which draft a send belongs to: a thread's id, or this for the new thread page.
const NEW_THREAD = 'new thread page';

export function Composer({ store, snap, busy = false }: { store: AppStore; snap: Snapshot; busy?: boolean }) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Att[]>([]);
  const [cwd, setCwd] = useState('');
  const [accountId, setAccountId] = useState('');
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<EffortLevel>();
  const [mode, setMode] = useState<PermissionMode>('ask');
  // The drafts being sent just now. A send belongs to the thread it started
  // in: moving to another thread meanwhile neither locks that one nor lets the
  // answer to the first change it.
  const [sendingKeys, setSendingKeys] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [answered, setAnswered] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const caret = useRef<number | undefined>(undefined);
  const existing = snap.selected;
  const t = existing ? snap.threads.get(existing) : undefined;
  const defaults = snap.hello?.defaults;
  const online = snap.conn === 'open';
  const sending = sendingKeys.has(existing ?? NEW_THREAD);

  // Each thread keeps its own draft, words and pictures, until it is sent.
  const drafts = useRef(new Map<string | undefined, Draft>());
  const was = useRef(existing);
  const latest = useRef<Draft>({ text, atts });
  latest.current = { text, atts };
  useEffect(() => {
    drafts.current.set(was.current, latest.current);
    was.current = existing;
    const d = drafts.current.get(existing);
    setText(d?.text ?? '');
    setAtts(d?.atts ?? []);
    setError(undefined);
    area.current?.focus();
  }, [existing]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useLayoutEffect(() => {
    if (caret.current !== undefined && area.current) {
      area.current.focus();
      area.current.setSelectionRange(caret.current, caret.current);
      caret.current = undefined;
    }
  });

  // ---- what is waiting at the bottom of the thread ---------------------------

  const waitingCard = useMemo(() => !!store.model.pending(), [store, snap.version, existing]);
  const reviews = useMemo(() => (existing ? store.model.pendingReviews() : []), [store, snap.version, existing]);
  const asksKey = t ? `${t.id}:${t.asksSeq ?? ''}` : '';
  const showAsks = !!t && !busy && !waitingCard && t.needs === 'you' && !!t.asks?.length && answered !== asksKey;
  const showDone = !!t && !busy && !waitingCard && !showAsks && t.needs === 'nothing' && !t.archivedAt && !agentsStillWorking(t.background) && !reviews.length;
  const next = showDone ? (store.model.lastEnd?.next ?? []) : [];
  const asksApi = useAsksDraft(asksKey);
  const picked = showAsks ? pickedAnswers(t!.asks!, asksApi.draft) : [];

  // ---- pictures ---------------------------------------------------------------

  // An upload finishes (or fails) after the person may have moved to another
  // thread: then it is that thread's saved draft that changes.
  const patchAtt = (key: string | undefined, id: string, patch: Partial<Att>) => {
    if (key === was.current) setAtts((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    else {
      const d = drafts.current.get(key);
      if (d) d.atts = d.atts.map((a) => (a.id === id ? { ...a, ...patch } : a));
    }
  };

  const failAtt = (key: string | undefined, id: string) => {
    if (key === was.current) {
      const i = latest.current.atts.findIndex((a) => a.id === id);
      if (i < 0) return;
      setAtts((list) => list.filter((a) => a.id !== id));
      setText((x) => dropMarker(x, i + 1));
      return;
    }
    const d = drafts.current.get(key);
    const i = d?.atts.findIndex((a) => a.id === id) ?? -1;
    if (!d || i < 0) return;
    d.atts = d.atts.filter((a) => a.id !== id);
    d.text = dropMarker(d.text, i + 1);
  };

  const addFiles = (list: File[]) => {
    const pictures = list.filter((f) => f.type.startsWith('image/'));
    if (!pictures.length) return;
    setError(undefined);
    const key = was.current;
    let count = latest.current.atts.length;
    let words = latest.current.text;
    let at = area.current ? [area.current.selectionStart, area.current.selectionEnd] : [words.length, words.length];
    const added: Att[] = [];
    for (const file of pictures) {
      if (file.size > MAX_PICTURE) {
        setError(`${file.name || 'That picture'} is over 20 MB.`);
        continue;
      }
      const att: Att = { id: `a${++attSeq}`, name: file.name || 'Pasted picture', preview: URL.createObjectURL(file), status: 'sending' };
      added.push(att);
      count++;
      const put = insertMarker(words, at[0]!, at[1]!, count);
      words = put.text;
      at = [put.caret, put.caret];
      store
        .importImage(file)
        .then((ref) => patchAtt(key, att.id, { status: 'ready', ref }))
        .catch((e: unknown) => {
          setError(errorText(e));
          URL.revokeObjectURL(att.preview);
          failAtt(key, att.id);
        });
    }
    if (!added.length) return;
    setAtts((a) => [...a, ...added]);
    setText(words);
    caret.current = at[0];
  };

  const removeAtt = (index: number) => {
    const a = atts[index];
    if (!a) return;
    URL.revokeObjectURL(a.preview);
    setAtts(atts.filter((_, i) => i !== index));
    setText((x) => dropMarker(x, index + 1));
  };

  // ---- sending ----------------------------------------------------------------

  const typed = text.trim();
  const uploading = atts.some((a) => a.status === 'sending');
  const canSend = (!!typed || picked.length > 0 || atts.length > 0) && !sending && !uploading && online;

  const send = async () => {
    if (!canSend) return;
    const ready = atts.flatMap((a) => (a.ref ? [a.ref] : []));
    const body = picked.length ? answerMessage(t!.asks!.length, picked, typed) : typed;
    const key = existing ?? NEW_THREAD;
    const sentFrom = asksKey;
    const mine = atts;
    const setBusy = (on: boolean) =>
      setSendingKeys((keys) => {
        const next = new Set(keys);
        if (on) next.add(key);
        else next.delete(key);
        return next;
      });
    // Still looking at the thread it was sent from? (A new thread is opened by
    // the send itself, so for that one the page has already moved on.)
    const here = () => was.current === existing;
    setBusy(true);
    setError(undefined);
    try {
      if (existing) await store.send(existing, body, ready, picked.map(({ action, answer }) => ({ action, answer })));
      else await store.create(body, { cwd: cwd.trim() || defaults?.cwd, accountId: accountId || undefined, model, effort, permissionMode: mode, images: ready });
      for (const a of mine) URL.revokeObjectURL(a.preview);
      drafts.current.delete(existing);
      if (here()) {
        setText('');
        setAtts([]);
        if (picked.length) {
          setAnswered(sentFrom);
          asksApi.clear();
        }
      }
    } catch (e) {
      if (here()) setError(errorText(e));
      else store.notify('error', errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const change = (patch: Record<string, unknown>) => {
    if (!existing) return;
    setError(undefined);
    store.update(existing, patch).catch((e: unknown) => setError(errorText(e)));
  };

  // ---- choices ----------------------------------------------------------------

  const account = snap.accounts.find((a) => a.id === (existing ? t?.accountId : accountId || defaults?.accountId));
  const newDefaultModel = account ? (defaults?.models?.[account.provider] ?? account.defaultModel) : undefined;

  return (
    <div className="composer">
      <div
        className={`box joined${dragging ? ' drag' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            addFiles([...e.dataTransfer.files]);
          }
        }}
      >
        {existing && t && (reviews.length > 0 || showAsks || showDone) && (
          <div className={`tb-dock${reviews.length ? ' with-review' : ''}`}>
            {reviews.map((r) => (
              <ReviewCard key={r.id} store={store} threadId={t.id} review={r} />
            ))}
            {showAsks && <AsksCard store={store} thread={t} asks={t.asks!} api={asksApi} send={() => void send()} sending={sending} />}
            {showDone && (
              <DoneCard
                store={store}
                thread={t}
                next={next}
                add={(line) => {
                  setText((x) => (x.trim() ? `${x.replace(/\s+$/, '')}\n\n${line}` : line));
                  caret.current = Number.MAX_SAFE_INTEGER;
                }}
              />
            )}
          </div>
        )}
        {atts.length > 0 && (
          <div className="tb-thumbs">
            {atts.map((a, i) => (
              <div key={a.id} className={`tb-thumb${a.status === 'sending' ? ' wait' : ''}`} title={`${a.name}, Picture ${i + 1}${a.status === 'sending' ? ' (adding)' : ''}`}>
                <img src={a.preview} alt={a.name} />
                <span className="tb-n">{i + 1}</span>
                <button type="button" className="tb-x" title={`Remove Picture ${i + 1}`} onClick={() => removeAtt(i)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          title={existing ? 'Your message. Enter sends, Shift and Enter makes a new line. Paste or drop pictures here.' : 'What you would like done. Enter sends. Paste or drop pictures here.'}
          placeholder={existing ? (showAsks ? 'Reply, or pick above' : 'Message') : 'What would you like done?'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pics = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (pics.length) {
              e.preventDefault();
              addFiles(pics);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="bar">
          <input
            ref={files}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <button type="button" className="ghost tb-add" title="Add a picture. You can also paste or drop one." onClick={() => files.current?.click()}>
            +
          </button>
          {!existing && (
            <>
              <input title="The folder it works in" placeholder={defaults?.cwd ?? 'Folder'} value={cwd} onChange={(e) => setCwd(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
              {isNative() && (
                <button
                  title="Choose the folder in a window"
                  onClick={() => void pickFolder(cwd.trim() || defaults?.cwd).then((p) => p && setCwd(p))}
                >
                  Browse
                </button>
              )}
              <select
                title="Which login it uses"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setModel(undefined);
                  setEffort(undefined);
                }}
              >
                <option value="">Login: {snap.accounts.find((a) => a.id === defaults?.accountId)?.title ?? defaults?.accountId ?? 'default'}</option>
                {snap.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </>
          )}
          {existing && t ? (
            <>
              <ModelMenu account={account} provider={t.provider} model={t.model} inUse={t.modelInUse} disabled={!online} offline={!online} onPick={(id) => change({ model: id })} />
              <EffortMenu account={account} model={t.model} inUse={t.modelInUse} effort={t.effort} now={t.effortInUse ?? account?.defaultEffort ?? defaults?.efforts?.[t.provider]} disabled={!online} onPick={(level) => change({ effort: level })} />
              <ModeMenu mode={t.permissionMode} disabled={!online} onPick={(m) => change({ permissionMode: m })} />
            </>
          ) : (
            <>
              <ModelMenu account={account} provider={account?.provider} model={model} inUse={newDefaultModel} offline={!online} onPick={(id) => { setModel(id ?? undefined); setEffort(undefined); }} />
              <EffortMenu account={account} model={model} inUse={newDefaultModel} effort={effort} now={account?.defaultEffort ?? (account ? defaults?.efforts?.[account.provider] : undefined)} onPick={(l) => setEffort(l ?? undefined)} />
              <ModeMenu mode={mode} onPick={setMode} />
            </>
          )}
          <span className="grow" />
          {error && (
            <span className="error" title={error}>
              {error}
            </span>
          )}
          {existing && busy && (
            <button type="button" title="Stop the agent's turn" onClick={() => void store.interrupt(existing).catch((e: unknown) => setError(errorText(e)))}>
              Stop
            </button>
          )}
          <button type="button" className="primary" disabled={!canSend} title={uploading ? 'Waiting for the pictures to be added' : existing && busy ? 'Send this into the turn that is running' : 'Send'} onClick={() => void send()}>
            {existing && busy ? 'Send now' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
