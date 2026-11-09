import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { errorText, type AppStore, type Snapshot } from '../core/store.ts';
import { isNative, openClaudeLogin } from '../core/native.ts';
import type { Row, ToolData } from '../core/model.ts';
import { sentByAgent, type ImageRef } from '../core/types.ts';
import { RpcError } from '../core/rpc.ts';
import { fold, workedTitle, type Item } from '../../../web/src/turns.ts';
import { Card } from './Cards.tsx';
import { Md } from './thread/Md.tsx';
import { Picture } from './thread/Picture.tsx';
import { dropMarker, splitMarkers } from './thread/text.ts';
import './thread/thread.css';

// Other parts of the window import this from here.
export { Md };

type Entry = { key: string; item?: Item<Row>; stream?: { text: string; reasoning: boolean }; earlier?: true };
const EST = 48;

export function Transcript({ store, snap }: { store: AppStore; snap: Snapshot }) {
  const model = store.model;
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => setOpen((o) => {
    const n = new Set(o);
    if (!n.delete(id)) n.add(id);
    return n;
  }), []);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    if (store.hasEarlier) out.push({ key: 'earlier', earlier: true });
    for (const it of fold(model.rows, model.busy)) {
      const key = it.kind === 'message' ? it.m.id : it.kind === 'tools' ? `t${it.items[0]!.id}` : `w${it.key}`;
      out.push({ key, item: it });
    }
    for (const s of model.streaming.values()) if (s.text) out.push({ key: `s${s.itemId}`, stream: { text: s.text, reasoning: s.type === 'reasoning' } });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.version, snap.selected]);

  const v = useVirtualizer({
    count: entries.length,
    getScrollElement: () => ref.current,
    estimateSize: () => EST,
    overscan: 10,
    getItemKey: (i) => entries[i]!.key,
  });

  // A thread opens at its end.
  useLayoutEffect(() => {
    pinned.current = true;
  }, [snap.selected]);
  const last = entries.at(-1);
  const tailLength = last?.stream?.text.length ?? 0;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, tailLength, snap.selected, open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [snap.selected]);

  return (
    <div
      ref={ref}
      className="scroller"
      data-scroller
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      <div style={{ height: v.getTotalSize(), position: 'relative', width: '100%' }}>
        {v.getVirtualItems().map((vi) => {
          const e = entries[vi.index]!;
          return (
            <div key={vi.key} data-index={vi.index} ref={v.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}>
              {e.earlier ? (
                <div className="loadmore">
                  <button disabled={snap.loadingEarlier} title={snap.loadingEarlier ? 'Loading earlier messages' : 'Load the messages before these'} onClick={() => void store.loadEarlier()}>
                    {snap.loadingEarlier && <span className="spin" aria-hidden="true" />}
                    {snap.loadingEarlier ? 'Loading...' : 'Load earlier messages'}
                  </button>
                </div>
              ) : e.stream ? (
                <div className="row stream">{e.stream.reasoning ? <div className="note">{e.stream.text}</div> : <Md text={e.stream.text} />}</div>
              ) : (
                <ItemView item={e.item!} open={open} toggle={toggle} store={store} threadId={snap.selected!} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ItemView({ item, open, toggle, store, threadId }: { item: Item<Row>; open: Set<string>; toggle: (id: string) => void; store: AppStore; threadId: string }) {
  if (item.kind === 'message') return <MessageView row={item.m} rev={item.m.rev ?? 0} store={store} threadId={threadId} />;
  if (item.kind === 'tools') {
    return (
      <div className="row">
        {item.items.map((r) => (
          <Bit key={r.id} row={r} rev={r.rev ?? 0} open={open.has(r.id)} toggle={toggle} store={store} threadId={threadId} />
        ))}
      </div>
    );
  }
  const id = `w${item.key}`;
  const made = open.has(id) ? [] : picturesOf(item);
  return (
    <div className="row">
      <div className="worked" onClick={() => toggle(id)}>
        <span>{open.has(id) ? '▾' : '▸'}</span>
        <span>{workedTitle(item.ms)}</span>
      </div>
      {made.length > 0 && (
        <div className="tb-pics">
          {made.map((im, i) => (
            <Picture key={im.path + i} store={store} image={im} />
          ))}
        </div>
      )}
      {open.has(id) && (
        <div className="detail">
          {item.items.map((sub, i) => (
            <ItemView key={i} item={sub} open={open} toggle={toggle} store={store} threadId={threadId} />
          ))}
        </div>
      )}
    </div>
  );
}

// The pictures a folded stretch of work made, so they stay in view.
function picturesOf(item: Item<Row>): ImageRef[] {
  if (item.kind === 'message') return [];
  if (item.kind === 'tools') return item.items.flatMap((r) => r.tool?.result?.images ?? []);
  return item.items.flatMap(picturesOf);
}

const MessageView = memo(function MessageView({ row, rev, store, threadId }: { row: Row; rev?: number; store: AppStore; threadId: string }) {
  void rev;
  if (row.kind === 'user') return <UserMessage row={row} store={store} threadId={threadId} />;
  return (
    <div className="row" style={row.narration ? { opacity: 0.75 } : undefined}>
      <Md text={row.text} />
    </div>
  );
});

// What the person wrote. Their own messages that began a turn can be edited:
// the agent forgets everything from there and the new words are sent as if
// the rest had never happened (docs/protocol.md, "Editing a message").
function UserMessage({ row, store, threadId }: { row: Row; store: AppStore; threadId: string }) {
  const [editing, setEditing] = useState(false);
  const canEdit = row.startsTurn === true && (!row.origin || row.origin === 'phone') && !row.reviewId && !sentByAgent(row.text);
  const images = row.images ?? [];
  if (editing) {
    return (
      <div className="row">
        <EditBox row={row} store={store} threadId={threadId} close={() => setEditing(false)} />
      </div>
    );
  }
  return (
    <div className="row">
      <div className="bubblewrap">
        <div className="bubble">
          {splitMarkers(row.text).map((p, i) =>
            typeof p === 'string' ? (
              <span key={i}>{p}</span>
            ) : images[p - 1] ? (
              <span key={i} className="picchip" title={`Picture ${p}`}>
                Picture {p}
              </span>
            ) : (
              <span key={i}>[Picture {p}]</span>
            ),
          )}
          {images.length > 0 && (
            <div className="tb-pics">
              {images.map((im, i) => (
                <Picture key={im.path + i} store={store} image={im} label={`Picture ${i + 1}`} />
              ))}
            </div>
          )}
        </div>
        {canEdit && (
          <button type="button" className="tb-edit" title="Edit this message and send it again" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
    </div>
  );
}

function EditBox({ row, store, threadId, close }: { row: Row; store: AppStore; threadId: string; close: () => void }) {
  const [text, setText] = useState(row.text);
  const [images, setImages] = useState(row.images ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [background, setBackground] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const run = async (stopBackground: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await store.edit(threadId, row.seq, text.trim(), images, stopBackground);
      close();
    } catch (e) {
      // -32050: background work would be stopped. Ask before going on.
      if (e instanceof RpcError && e.code === -32050) setBackground(e.message);
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const ready = !busy && (!!text.trim() || images.length > 0);
  return (
    <div className="tb-editbox">
      <textarea
        ref={area}
        rows={Math.min(12, Math.max(2, text.split('\n').length))}
        value={text}
        disabled={busy}
        title="Your message. Enter saves and sends it again, Escape cancels."
        onChange={(e) => {
          setText(e.target.value);
          setBackground(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (ready) void run(false);
          }
        }}
      />
      {images.length > 0 && (
        <div className="tb-pics">
          {images.map((im, i) => (
            <span key={im.path + i} className="tb-keep">
              <Picture store={store} image={im} label={`Picture ${i + 1}`} />
              <button
                type="button"
                className="tb-x"
                title={`Leave Picture ${i + 1} out`}
                disabled={busy}
                onClick={() => {
                  setImages(images.filter((_, j) => j !== i));
                  setText((x) => dropMarker(x, i + 1));
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="note">The agent forgets everything after this message and its file changes are put back. Changes made by commands are not.</div>
      {background && (
        <div className="tb-warn" role="alert">
          Work is still running in the background, and going back to this message stops it.
          <div className="note">{background}</div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="btns">
        <span className="grow" />
        <button type="button" disabled={busy} title="Leave the message as it was" onClick={close}>
          Cancel
        </button>
        {background ? (
          <button type="button" className="primary" disabled={!ready} title="Stop the background work, go back to this message and send it again" onClick={() => void run(true)}>
            Stop it and send
          </button>
        ) : (
          <button type="button" className="primary" disabled={!ready} title="Go back to this message and send it again" onClick={() => void run(false)}>
            Send again
          </button>
        )}
      </div>
    </div>
  );
}

// A failed turn's error, or a turn's end. When the error was that the login ran
// out, what to do about it comes with it.
function ErrorRow({ row, store, threadId }: { row: Row; store: AppStore; threadId: string }) {
  const failed = row.kind === 'error' || row.outcome === 'failed';
  return (
    <>
      <div className={failed ? 'error' : 'note'}>{row.text}</div>
      {row.errorKind === 'auth' && <AuthHelp store={store} threadId={threadId} />}
    </>
  );
}

// Under a failed turn whose login ran out: a button for each of the two Claude Code
// commands that put it right, which opens a terminal window running it (the installed
// app; the shell decides what is run), or the commands to run by hand in a browser tab.
// Only for a Claude login: another provider's has its own commands.
function AuthHelp({ store, threadId }: { store: AppStore; threadId: string }) {
  const [said, setSaid] = useState<string>();
  const snap = store.getSnapshot();
  const account = snap.accounts.find((a) => a.id === snap.threads.get(threadId)?.accountId);
  if (account && account.provider !== 'claude') return null;
  const run = async (kind: 'login' | 'setup-token') => {
    const problem = await openClaudeLogin(kind, account?.configDir);
    setSaid(
      problem ??
        (kind === 'login'
          ? 'A terminal window opened. Sign in there, then send your message again.'
          : 'A terminal window opened. It prints a token that lasts. To use it, set CLAUDE_CODE_OAUTH_TOKEN to it where the runner starts, and restart the runner. Signing in again is the simpler fix.'),
    );
  };
  const native = isNative();
  return (
    <div className="auth-help">
      {native && (
        <div className="auth-actions">
          <button type="button" title="Open a terminal window and run claude auth login, which signs this login in again" onClick={() => void run('login')}>
            Run claude auth login
          </button>
          <button type="button" className="ghost" title="Open a terminal window and run claude setup-token, which makes a long-lived token for unattended jobs" onClick={() => void run('setup-token')}>
            Run claude setup-token
          </button>
        </div>
      )}
      <div className="note">
        {said ?? (native ? 'These sign this login in again. Then send your message again.' : 'Run `claude auth login` in a terminal to sign this login in again, then send your message again. `claude setup-token` makes a token for unattended jobs.')}
      </div>
    </div>
  );
}

const Bit = memo(function Bit({ row, open, toggle, store, threadId }: { row: Row; rev: number; open: boolean; toggle: (id: string) => void; store: AppStore; threadId: string }) {
  if (row.kind === 'card') return <Card row={row} store={store} threadId={threadId} />;
  if (row.kind === 'review') {
    const review = store.model.reviews.get(row.reviewId ?? '');
    return (
      <div className="toolline" title="A design review the agent asked you to look at">
        <span className="k">review</span>
        <span className="t">{review ? `${review.title} (${review.status})` : row.text}</span>
      </div>
    );
  }
  if (row.kind === 'note') return <div className="note">{row.text}</div>;
  if (row.kind === 'error' || row.kind === 'turnEnd') return <ErrorRow row={row} store={store} threadId={threadId} />;
  if (row.kind === 'reasoning') {
    return (
      <>
        <div className="toolline" onClick={() => toggle(row.id)}>
          <span className="k">thinking</span>
          <span className="t">{row.text.split('\n')[0]}</span>
        </div>
        {open && <div className="detail note">{row.text}</div>}
      </>
    );
  }
  if (row.kind === 'action') {
    return (
      <>
        <div className={`toolline${row.ok ? '' : ' bad'}`} onClick={() => toggle(row.id)}>
          <span className="k">action</span>
          <span className="t">{row.text}</span>
        </div>
        {open && <div className="detail"><pre>{row.detail}</pre></div>}
      </>
    );
  }
  const t = row.tool;
  if (!t) return null;
  return (
    <>
      <div className={`toolline${t.result && !t.result.ok ? ' bad' : ''}`} onClick={() => toggle(row.id)}>
        <span className="k">{t.kind}</span>
        <span className="t">{row.text}</span>
      </div>
      {t.result?.images?.length ? (
        <div className="tb-pics">
          {t.result.images.map((im, i) => (
            <Picture key={im.path + i} store={store} image={im} />
          ))}
        </div>
      ) : null}
      {open && <ToolDetail t={t} />}
    </>
  );
});

function ToolDetail({ t }: { t: ToolData }) {
  const command = typeof t.input.command === 'string' ? t.input.command : undefined;
  return (
    <div className="detail">
      <pre>{command ?? JSON.stringify(t.input, null, 2)}</pre>
      {[...t.diffs].map(([path, hunks]) => (
        <div key={path} className="diff">
          <div className="note">{path}</div>
          <pre>
            {hunks.map((h, i) => (
              <div key={i}>
                <div className="hunk">{`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`}</div>
                {h.lines.map((l, j) => (
                  <div key={j} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
                    {l}
                  </div>
                ))}
              </div>
            ))}
          </pre>
        </div>
      ))}
      {t.result && <pre>{t.result.text || '(no output)'}{t.result.truncated ? '\n... (shortened)' : ''}</pre>}
    </div>
  );
}
