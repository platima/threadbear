import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { HOME_KEY, choiceLabel, terminals, type Target, type TerminalSessions } from '../core/terminals.ts';
import { fontDraft, fontLabel, fontNames, resolveFont, type FontChoice, type FontDraft, type ResolvedFont } from '../core/terminal-font.ts';
import { isNative, openExternal } from '../core/native.ts';
import { Menu, type MenuItem } from './thread/Menu.tsx';
import './thread/terminal.css';

// The Terminal under the thread: a real shell in a pseudo-terminal, drawn by xterm.js. The
// shells live in the bridge (core/terminals.ts, bridge/terminal.ts), one per thread in its
// folder, and carry on while another thread is open; here each shell's xterm is kept too,
// so switching back finds the screen as it was left.

// ---- one xterm per shell ---------------------------------------------------

// `font` is the family and size this screen was last given, so a screen that was out of the page when
// the font changed is given it when it comes back.
type Instance = { term: Terminal; fit: FitAddon; el: HTMLDivElement; refit: () => void; font: string };
const instances = new Map<string, Instance>();

const fontKey = (f: ResolvedFont) => `${f.size}|${f.family}`;

// Gives a screen a font. Only done to one that is in the page: xterm measures a character by
// putting it on screen, and a screen that isn't there measures nothing.
function restyle(inst: Instance, font: ResolvedFont): void {
  if (inst.font === fontKey(font)) return;
  inst.font = fontKey(font);
  inst.term.options.fontFamily = font.family;
  inst.term.options.fontSize = font.size;
}

// The font changed: wait for the browser to have it (a font it must fetch or load first would be
// measured as the one it falls back to, and every cell would be the wrong width), then give it to
// every screen that is showing and fit them again. The latest change wins if several come at once.
let fontRun = 0;
async function applyFont(font: ResolvedFont): Promise<void> {
  const run = ++fontRun;
  try {
    // A glyph from the private use area, which is what a prompt theme draws, makes it look further than Latin letters.
    await Promise.race([document.fonts.load(`${font.size}px ${font.family}`, ' Mg'), new Promise((resolve) => setTimeout(resolve, 1500))]);
  } catch {
    // measured with whatever the browser has
  }
  if (run !== fontRun) return;
  for (const inst of instances.values()) {
    if (!inst.el.isConnected) continue;
    restyle(inst, font);
    inst.refit();
  }
}

// VS Code's terminal colours, which are readable on both a dark and a light background.
const DARK: ITheme = {
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
};
const LIGHT: ITheme = {
  black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
  brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
};

function theme(): ITheme {
  const root = document.documentElement;
  const picked = root.getAttribute('data-theme');
  const dark = picked === 'dark' || (picked !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  const css = getComputedStyle(root);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const accent = v('--accent', '#4d9bff');
  return { ...(dark ? DARK : LIGHT), background: v('--bg-code', dark ? '#151517' : '#f6f6f8'), foreground: v('--text', dark ? '#ececee' : '#1c1c1e'), cursor: accent, cursorAccent: v('--bg-code', '#151517'), selectionBackground: `${accent}55` };
}

// The rail's appearance button and the system's setting both change the colours.
let watching = false;
function watchTheme(): void {
  if (watching) return;
  watching = true;
  const apply = () => {
    for (const i of instances.values()) i.term.options.theme = theme();
  };
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
}

const openLink = (uri: string) => (isNative() ? void openExternal(uri) : void window.open(uri, '_blank', 'noopener,noreferrer'));

// The keys the window keeps for itself or treats as a terminal does on Windows: Ctrl+J shows
// or hides this panel; Ctrl+C copies when something is selected and otherwise interrupts;
// Ctrl+V and Ctrl+Shift+V paste, and Ctrl+Shift+C copies. Returning false hands the key back
// to the page (so Ctrl+J reaches the window's own shortcut, and a paste reaches xterm's).
function keys(term: Terminal, e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return true;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.altKey && !e.shiftKey && (key === 'j' || e.key === '`')) return false;
  if (mod && key === 'c' && (term.hasSelection() || e.shiftKey)) {
    if (term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection());
    term.clearSelection();
    return false;
  }
  if (mod && key === 'v') return false;
  return true;
}

function instanceFor(key: string, sessions: TerminalSessions, font: ResolvedFont): Instance {
  const have = instances.get(key);
  if (have) return have;
  watchTheme();
  const el = document.createElement('div');
  el.className = 'termHost';
  const term = new Terminal({
    fontFamily: font.family,
    fontSize: font.size,
    cursorBlink: true,
    scrollback: 10_000,
    theme: theme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)));
  term.attachCustomKeyEventHandler((e) => keys(term, e));
  term.onData((d) => sessions.input(key, d));
  term.onResize(({ cols, rows }) => sessions.resize(key, cols, rows));
  const refit = () => {
    // Fitting a host that is not showing (zero size) would shrink the shell to nothing.
    if (el.isConnected && el.clientWidth > 40 && el.clientHeight > 20) fit.fit();
  };
  const inst: Instance = { term, fit, el, refit, font: fontKey(font) };
  instances.set(key, inst);
  const sink = {
    write: (d: string) => term.write(d),
    reset: () => term.reset(),
    dispose: () => {
      term.dispose();
      el.remove();
      if (instances.get(key) === inst) instances.delete(key);
    },
  };
  sessions.register(key, sink);
  return inst;
}

// ---- the panel ---------------------------------------------------------------

const HEIGHT_KEY = 'threadbear.terminalHeight';
export const readHeight = (): number => {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(n) && n >= 120 ? n : 280;
  } catch {
    return 280;
  }
};
const clampHeight = (h: number) => Math.max(120, Math.min(h, Math.round(window.innerHeight * 0.75)));

export function TerminalDock({ target, close, focusTick }: { target: Target; close: () => void; focusTick: number }) {
  const sessions = terminals();
  const state = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const host = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(readHeight);
  const session = state.sessions.get(target.key);
  const status = session?.status;
  const live = status === 'starting' || status === 'running' || status === 'exited';
  const choice = state.choice;
  const info = state.shells;
  const where = session?.cwd || target.cwd || (target.key === HOME_KEY ? 'your home folder' : '');
  const fontPicked = state.fontChoice;
  const font = resolveFont(fontPicked, state.wtFont, state.wtAnswered);
  // The screens made or fitted later read this, not the font of the render that made the effect.
  const fontNow = useRef(font);
  fontNow.current = font;
  const [draft, showDraft] = useState(fontPicked?.kind === 'custom' ? fontPicked.name : '');
  // The name box's text, held where its own handlers (Escape, then the blur that moving the focus
  // causes straight away) see it as it was just set, before React has drawn it (core/terminal-font.ts).
  const held = useRef<FontDraft | undefined>(undefined);
  const typed = (held.current ??= fontDraft(draft, showDraft));
  const [badName, setBadName] = useState(false);
  const nameBox = useRef<HTMLInputElement>(null);
  const [nameWanted, wantName] = useState(false);

  // Which shells there are, and whether one already runs for this thread (after a reload, or a
  // look at another thread and back). Nothing starts from this.
  useEffect(() => {
    void sessions.loadShells();
  }, [sessions]);
  useEffect(() => {
    sessions.look(target.key);
  }, [sessions, target.key]);

  // The font Windows Terminal is set to, asked for each time the panel opens (the bridge reads its
  // settings then, not at start-up, so a change made there is picked up).
  useEffect(() => {
    sessions.loadFont();
  }, [sessions]);

  // A font chosen, or Windows Terminal's arriving: the screens in the page re-measure and fit again.
  useEffect(() => {
    void applyFont(fontNow.current);
  }, [font.family, font.size]);

  // Picking "A font you name" puts the cursor in the box that then appears.
  useEffect(() => {
    if (!nameWanted) return;
    wantName(false);
    nameBox.current?.focus();
    nameBox.current?.select();
  }, [nameWanted]);

  // Puts this shell's screen in the panel, and keeps it fitted to the panel's size.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    // A thread with no shell shows none: the last thread's screen is taken out (it is kept, to come back to).
    if (!live) {
      el.replaceChildren();
      return;
    }
    const inst = instanceFor(target.key, sessions, fontNow.current);
    if (inst.el.parentElement !== el) el.replaceChildren(inst.el);
    if (!inst.term.element) inst.term.open(inst.el);
    // A screen kept from another thread comes back in the font chosen since.
    restyle(inst, fontNow.current);
    inst.refit();
    const watch = new ResizeObserver(() => inst.refit());
    watch.observe(el);
    return () => watch.disconnect();
  }, [sessions, target.key, live, height]);

  useEffect(() => {
    if (focusTick > 0 && live) instances.get(target.key)?.term.focus();
  }, [focusTick, live, target.key]);

  const begin = () => {
    // The screen is made first so the shell starts at the size it will have.
    const el = host.current;
    if (el) {
      const inst = instanceFor(target.key, sessions, font);
      el.replaceChildren(inst.el);
      if (!inst.term.element) inst.term.open(inst.el);
      restyle(inst, font);
      inst.refit();
      sessions.resize(target.key, inst.term.cols, inst.term.rows);
    }
    sessions.start(target.key, target.cwd, choice);
    setTimeout(() => instances.get(target.key)?.term.focus(), 0);
  };

  const pickDefault = (id: string) => void sessions.setChoice(id);

  const found = state.wtFont;
  const pickFont = (c: FontChoice) => {
    setBadName(false);
    void sessions.setFont(c);
  };
  // The typed name (or comma-separated list of names, as Windows Terminal takes one) is used when
  // Enter is pressed or the box is left. Text with no plain font name in it is not used. It reads
  // the text the draft holds, not the render's: Escape puts the old name back and moves the focus
  // in the same moment, and the blur that causes must not find the edit it is cancelling.
  const commitName = () => {
    if (fontPicked?.kind !== 'custom') return;
    const { name, bad, changed } = typed.commit(fontPicked.name);
    setBadName(bad);
    if (!bad && changed) pickFont({ kind: 'custom', name });
  };
  // Until the bridge has answered, Windows Terminal's font is neither there nor missing.
  const asking = !state.wtAnswered;
  const fontItems: MenuItem[] = [
    // Windows Terminal's own is offered where the bridge found one (so never on Linux), and where it
    // was chosen, to say it has gone (or, before the bridge has answered, that it is being looked for).
    ...(found?.face || fontPicked?.kind === 'wt'
      ? [
          {
            key: 'wt',
            label: 'Same as Windows Terminal',
            note: found?.face ? `${found.faces?.join(', ') ?? found.face}${found.size ? `, ${found.size} pt` : ''}` : asking ? "Reading Windows Terminal's settings" : 'No font is set in Windows Terminal on this PC',
            on: font.kind === 'wt',
            disabled: !found?.face && !asking,
            onPick: () => pickFont({ kind: 'wt' }),
          },
        ]
      : []),
    { key: 'default', label: 'Default', note: "Cascadia Mono or this PC's own monospace font, with a Nerd Font you have installed for the symbols a prompt draws", on: font.kind === 'default', onPick: () => pickFont({ kind: 'default' }) },
    {
      key: 'custom',
      label: 'A font you name',
      note: 'The name of a font installed on this PC',
      on: font.kind === 'custom',
      onPick: () => {
        pickFont({ kind: 'custom', name: fontNames(typed.text) });
        wantName(true);
      },
    },
  ];
  const fontTip =
    font.kind === 'wt'
      ? `The terminal uses the font Windows Terminal is set to (${font.face}), at its size. `
      : font.kind === 'custom'
        ? `The terminal uses the font you named${font.face ? ` (${font.face})` : ''}. `
        : 'The terminal uses its default font. ';

  const drag = (e: React.PointerEvent) => {
    const start = e.clientY;
    const from = height;
    const move = (m: PointerEvent) => setHeight(clampHeight(from - (m.clientY - start)));
    const up = (m: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(clampHeight(from - (m.clientY - start))));
      } catch {
        // not kept
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const wantedLabel = choiceLabel(info, choice);
  const unavailable = info?.unavailable;
  const items = [
    { key: 'auto', label: choiceLabel(info, 'auto'), note: 'The first PowerShell this PC has: 7 if it is installed, otherwise 5.1', on: choice === 'auto', onPick: () => pickDefault('auto') },
    ...(info?.shells ?? []).map((s) => ({ key: s.id, label: s.label, on: choice === s.id, onPick: () => pickDefault(s.id) })),
  ];
  const note = session?.note ?? target.note;

  return (
    <div className="termDock" style={{ height }}>
      <div className="termGrip" onPointerDown={drag} title="Drag to make the terminal taller or shorter" />
      <div className="termHead">
        <b>Terminal</b>
        <span className="termWhere" title={where}>
          {session?.shell ? `${session.shell} in ` : ''}
          {where}
        </span>
        <span className="grow" />
        <Menu
          label={wantedLabel}
          title="The shell a new terminal starts with. Your choice is kept. It applies the next time a shell starts here, and a shell that is running is not changed."
          items={items}
          disabled={!info}
        />
        <Menu
          className="termFontBtn"
          label={<span className="termFontLabel">{fontLabel(font)}</span>}
          title={`${fontTip}Your choice is kept. Symbols from a prompt such as oh-my-posh need a Nerd Font to show.`}
          items={fontItems}
        />
        {fontPicked?.kind === 'custom' && (
          <input
            ref={nameBox}
            className={`termFontName${badName ? ' bad' : ''}`}
            type="text"
            value={draft}
            maxLength={400}
            spellCheck={false}
            placeholder="Font name"
            aria-label="Terminal font name"
            title="The name of a font installed on this PC, for example JetBrainsMono Nerd Font. Name several, separated by commas, as Windows Terminal does: the first draws the text and the others the symbols it lacks. Press Enter to use it, or Escape to put the old name back."
            onChange={(e) => {
              typed.set(e.target.value);
              setBadName(false);
            }}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              else if (e.key === 'Escape') {
                // The old name goes back first, then the focus moves: that makes the box blur at once,
                // and the blur commits what the draft holds by then (see fontDraft).
                setBadName(false);
                typed.cancel(fontPicked.name, () => instances.get(target.key)?.term.focus());
              }
            }}
          />
        )}
        {(status === 'running' || status === 'starting') && (
          <button className="ghost" title="End this shell and anything running in it. You can start a new one." onClick={() => sessions.stop(target.key)}>
            End shell
          </button>
        )}
        <button className="ghost" title="Hide the terminal. Its shells keep running; Ctrl+J brings it back." onClick={close}>
          ✕
        </button>
      </div>
      {note && <div className="termNote">{note}</div>}
      {(badName || font.problem) && (
        <div className="termNote">{badName ? "That isn't a font name the Terminal can use. A name has letters, digits, spaces, hyphens, dots, underscores, brackets, plus signs and ampersands, and is at most 100 characters." : font.problem}</div>
      )}
      <div className="termBody">
        <div className="termSlot" ref={host} />
        {!live && (
          <div className="termEmpty">
            {unavailable ? (
              <>
                <div className="termSorry">{unavailable}</div>
                <button onClick={() => void sessions.loadShells(true)} title="Ask the terminal again which shells this PC has, in case it was only a dropped connection">
                  Try again
                </button>
              </>
            ) : status === 'looking' || (!info && !session) ? (
              <span className="note">Looking for a shell...</span>
            ) : (
              <button className="primary" onClick={begin} title={`Start ${wantedLabel === choiceLabel(info, 'auto') ? 'the default shell' : wantedLabel} in ${where || 'this folder'}`}>
                Start a shell
              </button>
            )}
            {session?.error && <div className="error termSorry">{session.error}</div>}
            {!!info?.notes.length && !unavailable && info.notes.map((n) => <div key={n} className="note">{n}</div>)}
          </div>
        )}
        {status === 'exited' && (
          <div className="termExited">
            <span>{session?.code ? `The shell ended with code ${session.code}.` : 'The shell has ended.'}</span>
            <button onClick={begin} title={`Start a new shell in ${where || 'this folder'}`}>
              New shell
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
