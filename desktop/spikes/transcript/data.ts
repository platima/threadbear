// Synthetic threads for the transcript spike: the mix of rows a long
// Threadbear thread has (short user messages, Markdown replies with lists,
// code and tables, one-line tool calls, some with output, and diffs).

export type Kind = 'user' | 'assistant' | 'tool' | 'diff';
export type Row = { id: number; kind: Kind; text: string };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

const WORDS =
  'the runner thread message tool call file path session agent patch panel build test turn reply queue socket event window sidebar worktree branch commit merge land check'.split(
    ' ',
  );

function words(r: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]);
  return out.join(' ');
}

function sentence(r: () => number): string {
  const s = words(r, 6 + Math.floor(r() * 14));
  return s[0].toUpperCase() + s.slice(1) + '.';
}

function paragraph(r: () => number): string {
  const n = 2 + Math.floor(r() * 4);
  return Array.from({ length: n }, () => sentence(r)).join(' ');
}

export function assistantMarkdown(r: () => number, size: 'short' | 'long'): string {
  const parts: string[] = [paragraph(r)];
  if (size === 'long') {
    parts.push('## ' + words(r, 3));
    parts.push(Array.from({ length: 3 + Math.floor(r() * 5) }, () => '- ' + sentence(r)).join('\n'));
    parts.push('```ts\n' + Array.from({ length: 6 + Math.floor(r() * 10) }, (_, i) => `const v${i} = await run(${i}, "${words(r, 2)}");`).join('\n') + '\n```');
    parts.push('| name | value |\n| --- | --- |\n' + Array.from({ length: 4 }, () => `| ${words(r, 1)} | ${Math.floor(r() * 1000)} |`).join('\n'));
    parts.push(paragraph(r));
  }
  return parts.join('\n\n');
}

export function makeThread(seed: number, count = 4100): Row[] {
  const r = rng(seed);
  const rows: Row[] = [];
  for (let id = 0; id < count; id++) {
    const x = r();
    if (x < 0.1) rows.push({ id, kind: 'user', text: paragraph(r) });
    else if (x < 0.22) rows.push({ id, kind: 'assistant', text: assistantMarkdown(r, 'short') });
    else if (x < 0.3) rows.push({ id, kind: 'assistant', text: assistantMarkdown(r, 'long') });
    else if (x < 0.95) {
      const out = r() < 0.3 ? '\n' + Array.from({ length: 1 + Math.floor(r() * 6) }, () => words(r, 8)).join('\n') : '';
      rows.push({ id, kind: 'tool', text: `Bash  ${words(r, 5)}${out}` });
    } else {
      rows.push({
        id,
        kind: 'diff',
        text: Array.from({ length: 24 }, (_, i) => `${i % 3 === 0 ? '+' : i % 3 === 1 ? '-' : ' '} ${words(r, 7)}`).join('\n'),
      });
    }
  }
  return rows;
}

// A reply that streams in, ~6,000 characters of Markdown.
export function streamingReply(seed: number): string {
  const r = rng(seed);
  let t = '';
  while (t.length < 6000) t += assistantMarkdown(r, 'long') + '\n\n';
  return t.slice(0, 6000);
}
