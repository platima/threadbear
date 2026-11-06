import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AppStore, Snapshot } from '../core/store.ts';
import type { Row, ToolData } from '../core/model.ts';
import { fold, workedTitle, type Item } from '../../../web/src/turns.ts';
import { Card } from './Cards.tsx';

const plugins = [remarkGfm];

export const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={plugins} components={{ a: (p) => <a {...p} target="_blank" rel="noopener noreferrer" /> }}>
        {text}
      </Markdown>
    </div>
  );
});

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
                  <button onClick={() => void store.loadEarlier()}>Load earlier messages</button>
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
  if (item.kind === 'message') return <MessageView row={item.m} />;
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
  return (
    <div className="row">
      <div className="worked" onClick={() => toggle(id)}>
        <span>{open.has(id) ? '▾' : '▸'}</span>
        <span>{workedTitle(item.ms)}</span>
      </div>
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

const MessageView = memo(function MessageView({ row, rev }: { row: Row; rev?: number }) {
  void rev;
  if (row.kind === 'user') {
    return (
      <div className="row">
        <div className="bubble">
          {row.text}
          {row.images?.length ? <div className="note">{row.images.length} picture{row.images.length === 1 ? '' : 's'}: {row.images.map((i) => i.path.split(/[\\/]/).pop()).join(', ')}</div> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="row" style={row.narration ? { opacity: 0.75 } : undefined}>
      <Md text={row.text} />
    </div>
  );
});

const Bit = memo(function Bit({ row, open, toggle, store, threadId }: { row: Row; rev: number; open: boolean; toggle: (id: string) => void; store: AppStore; threadId: string }) {
  if (row.kind === 'card') return <Card row={row} store={store} threadId={threadId} />;
  if (row.kind === 'note') return <div className="note">{row.text}</div>;
  if (row.kind === 'error') return <div className="error">{row.text}</div>;
  if (row.kind === 'turnEnd') return <div className={row.outcome === 'failed' ? 'error' : 'note'}>{row.text}</div>;
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
