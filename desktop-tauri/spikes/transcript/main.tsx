// The transcript spike (docs/windows-port-plan.md, M0). Can a web view hold a
// thread of 4,100 rows to the bars in docs/plan.md: first paint in 100 ms or
// less, a thread switch in 50 ms or less, nothing blocking the main thread
// for 100 ms or more, while a reply streams in at 30 updates a second.
//
// Open it with ?auto=1 and it runs everything and prints the numbers.

import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useVirtualizer } from '@tanstack/react-virtual';
import { makeThread, streamingReply, type Row } from './data.ts';

const EST = { user: 60, assistant: 120, tool: 26, diff: 400 } as const;
const plugins = [remarkGfm];

const css = `
  .row { padding: 4px 16px; max-width: 860px; margin: 0 auto; }
  .user { background: #2c2c2e; border-radius: 10px; padding: 8px 12px; }
  .tool { font: 12px/1.4 ui-monospace, Consolas, monospace; color: #9a9aa0; white-space: pre-wrap; }
  .diff { font: 12px/1.4 ui-monospace, Consolas, monospace; background: #111; padding: 8px; margin: 0; white-space: pre; overflow: hidden; }
  .md p { margin: 0 0 8px; } .md pre { background: #111; padding: 8px; overflow: hidden; }
  .md table { border-collapse: collapse; } .md td, .md th { border: 1px solid #444; padding: 2px 8px; }
  #result { position: fixed; right: 8px; top: 8px; z-index: 10; background: #000c; color: #9f9; font: 11px/1.35 ui-monospace, Consolas, monospace; padding: 8px; max-width: 460px; white-space: pre-wrap; }
`;

const RowView = memo(function RowView({ row }: { row: Row }) {
  if (row.kind === 'user') return <div className="row"><div className="user">{row.text}</div></div>;
  if (row.kind === 'assistant')
    return (
      <div className="row md">
        <Markdown remarkPlugins={plugins}>{row.text}</Markdown>
      </div>
    );
  if (row.kind === 'diff') return <div className="row"><pre className="diff">{row.text}</pre></div>;
  return <div className="row tool">{row.text}</div>;
});

function Transcript({ rows }: { rows: Row[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: (i) => EST[rows[i].kind],
    overscan: 10,
    getItemKey: (i) => rows[i].id,
  });
  useLayoutEffect(() => {
    v.scrollToIndex(rows.length - 1, { align: 'end' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tail = rows[rows.length - 1].text;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [tail]);
  return (
    <div
      ref={ref}
      data-scroller
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      style={{ height: '100%', overflow: 'auto', contain: 'strict' }}
    >
      <div style={{ height: v.getTotalSize(), position: 'relative', width: '100%' }}>
        {v.getVirtualItems().map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={v.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
          >
            <RowView row={rows[vi.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}

const threads = { A: makeThread(1), B: makeThread(2) };
const reply = streamingReply(3);
type Name = 'A' | 'B';
const ctl: { setName: (n: Name) => void; setTail: (t: string) => void } = { setName: () => {}, setTail: () => {} };

function App() {
  const [name, setName] = useState<Name>('A');
  const [tail, setTail] = useState('');
  ctl.setName = setName;
  ctl.setTail = setTail;
  const rows = useMemo(() => [...threads[name], { id: -1, kind: 'assistant' as const, text: tail }], [name, tail]);
  return <Transcript key={name} rows={rows} />;
}

// ---- measuring -----------------------------------------------------------

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const paint = async () => {
  await frame();
  await frame();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scroller = () => document.querySelector<HTMLDivElement>('[data-scroller]')!;
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;
const r1 = (n: number) => Math.round(n * 10) / 10;

const longtasks: number[] = [];
try {
  new PerformanceObserver((l) => l.getEntries().forEach((e) => longtasks.push(e.duration))).observe({ type: 'longtask', buffered: true });
} catch {
  // not supported: the frame times still show a block
}

function frames() {
  const dts: number[] = [];
  let last = performance.now();
  let on = true;
  const loop = (t: number) => {
    if (!on) return;
    dts.push(t - last);
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return () => {
    on = false;
    return dts;
  };
}

async function untilSettled(): Promise<void> {
  let prev = -1;
  let still = 0;
  while (still < 3) {
    await frame();
    const el = scroller();
    const h = el.scrollHeight;
    const atBottom = h - el.scrollTop - el.clientHeight < 2;
    still = atBottom && h === prev ? still + 1 : 0;
    prev = h;
  }
}

async function open(name: Name): Promise<{ firstPaint: number; settled: number }> {
  const t0 = performance.now();
  flushSync(() => ctl.setName(name));
  await paint();
  const firstPaint = performance.now() - t0;
  await untilSettled();
  return { firstPaint, settled: performance.now() - t0 - 3 * 16 };
}

const stat = (a: number[]) => ({ median: r1(q(a, 0.5)), p95: r1(q(a, 0.95)), max: r1(Math.max(...a)) });

export async function run() {
  const out: Record<string, unknown> = {
    rows: threads.A.length + 1,
    coldOpenMs: (window as unknown as { __coldOpenMs: number }).__coldOpenMs,
    ua: navigator.userAgent,
  };
  await paint();
  await untilSettled();

  const first: number[] = [];
  const settled: number[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await open(i % 2 === 0 ? 'B' : 'A');
    first.push(r.firstPaint);
    settled.push(r.settled);
    await sleep(100);
  }
  out.switchFirstPaintMs = stat(first);
  out.switchSettledMs = stat(settled);

  // Streaming: 30 updates a second for 10 seconds, pinned to the bottom.
  longtasks.length = 0;
  const stop = frames();
  const renders: number[] = [];
  const per = Math.ceil(reply.length / 300);
  for (let n = per; n < reply.length + per; n += per) {
    const t = performance.now();
    flushSync(() => ctl.setTail(reply.slice(0, Math.min(n, reply.length))));
    renders.push(performance.now() - t);
    await sleep(33);
  }
  const sdts = stop();
  out.streamUpdateMs = stat(renders);
  out.streamFrames = { ...stat(sdts), over50: sdts.filter((d) => d > 50).length, over100: sdts.filter((d) => d > 100).length, count: sdts.length };
  out.streamLongTasks = { count: longtasks.length, max: r1(Math.max(0, ...longtasks)) };

  // A sweep from the top to the bottom in 2 seconds.
  longtasks.length = 0;
  const el = scroller();
  el.scrollTop = 0;
  await paint();
  const stop2 = frames();
  const t0 = performance.now();
  for (;;) {
    const f = Math.min(1, (performance.now() - t0) / 2000);
    el.scrollTop = f * (el.scrollHeight - el.clientHeight);
    await frame();
    if (f >= 1) break;
  }
  const dts = stop2();
  out.sweepFrames = { ...stat(dts), over50: dts.filter((d) => d > 50).length, over100: dts.filter((d) => d > 100).length, count: dts.length };
  out.sweepLongTasks = { count: longtasks.length, max: r1(Math.max(0, ...longtasks)) };

  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (mem) out.heapMB = Math.round(mem.usedJSHeapSize / 1048576);
  out.viewport = `${innerWidth}x${innerHeight}`;
  (window as unknown as { __result: unknown }).__result = out;
  const pre = document.getElementById('result');
  if (pre) pre.textContent = JSON.stringify(out, null, 1);
  return out;
}

// ---- page ----------------------------------------------------------------

const style = document.createElement('style');
style.textContent = css;
document.head.append(style);
const panel = document.createElement('pre');
panel.id = 'result';
panel.textContent = 'running...';
document.body.append(panel);
const t0 = performance.now();
createRoot(document.getElementById('root')!).render(<App />);
paint().then(() => {
  (window as unknown as { __coldOpenMs: number }).__coldOpenMs = r1(performance.now() - t0);
  if (location.search.includes('auto')) void run();
});
