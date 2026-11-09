// Every control in the window says what it does: a button, a menu, a link, a field
// has a tooltip, and a tooltip says more than the label it sits on (a button called
// Hibernate that says "Hibernate" tells nobody what hibernating does). The Mac
// app has the same rule (AGENTS.md: every control gets a tooltip).
//
// node --test desktop-tauri/src/ui/tips.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const UI = import.meta.dirname;

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsxFiles(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []));
}

type Control = { where: string; tag: string; title?: string; label: string };

// The opening tag of each control, up to the first > outside braces and quotes.
function controls(): Control[] {
  const found: Control[] = [];
  for (const file of tsxFiles(UI)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/<(button|select|input|textarea|a|summary)\b/g)) {
      let i = m.index! + m[0].length;
      let depth = 0;
      let quote = '';
      for (; i < text.length; i++) {
        const c = text[i]!;
        if (quote) {
          if (c === quote && text[i - 1] !== '\\') quote = '';
        } else if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) break;
      }
      const tag = text.slice(m.index!, i + 1);
      const line = text.slice(0, m.index!).split('\n').length;
      // The tooltip: on the control, or for a tick box or radio button on the label around it.
      let title = /\btitle=(?:"([^"]*)"|\{[^}]*\})/.exec(tag)?.[0];
      if (!title && /type="(checkbox|radio)"|type=\{[^}]*'(checkbox|radio)'/.test(tag)) {
        const before = text.slice(Math.max(0, m.index! - 500), m.index!);
        const label = before.lastIndexOf('<label');
        if (label >= 0 && !before.slice(label).includes('</label>')) title = /\btitle=(?:"([^"]*)"|\{[^}]*\})/.exec(before.slice(label))?.[0];
      }
      if (/\bhidden\b/.test(tag) && /type="file"/.test(tag)) continue; // a file picker the page opens itself
      const literal = title ? /title="([^"]*)"/.exec(title)?.[1] : undefined;
      const label = (/^\s*([^<{]{1,60})/.exec(text.slice(i + 1, i + 200))?.[1] ?? '').replace(/\s+/g, ' ').trim();
      found.push({ where: `${path.relative(UI, file)}:${line}`, tag: tag.replace(/\s+/g, ' ').slice(0, 100), title: title ? (literal ?? '(computed)') : undefined, label });
    }
  }
  return found;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

test('every control has a tooltip', () => {
  const all = controls();
  assert.ok(all.length > 100, `only ${all.length} controls found: is the scan reading the window's files?`);
  const bare = all.filter((c) => c.title === undefined);
  assert.deepEqual(bare.map((c) => `${c.where}  ${c.tag}`), [], 'these have no title=');
});

test('a tooltip says more than the label it sits on, and more than a word or two', () => {
  const weak = controls().filter((c) => {
    if (!c.title || c.title === '(computed)') return false;
    const words = c.title.split(/\s+/).length;
    const same = c.label !== '' && norm(c.title) === norm(c.label);
    return same || words <= 2;
  });
  assert.deepEqual(weak.map((c) => `${c.where}  title="${c.title}"  label="${c.label}"`), []);
});
