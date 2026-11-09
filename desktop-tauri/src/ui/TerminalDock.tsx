import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { HOME_KEY, choiceLabel, terminals, type Target, type TerminalSessions } from '../core/terminals.ts';
import { isNative, openExternal } from '../core/native.ts';
import { Menu } from './thread/Menu.tsx';
import './thread/terminal.css';

// The Terminal under the thread: a real shell in a pseudo-terminal, drawn by xterm.js. The
// shells live in the bridge (core/terminals.ts, bridge/terminal.ts), one per thread in its
// folder, and carry on while another thread is open; here each shell's xterm is kept too,
// so switching back finds the screen as it was left.

// ---- one xterm per shell ---------------------------------------------------

type Instance = { term: Terminal; fit: FitAddon; el: HTMLDivElement; refit: () => void };
const instances = new Map<string, Instance>();

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

function instanceFor(key: string, sessions: TerminalSessions): Instance {
  const have = instances.get(key);
  if (have) return have;
  watchTheme();
  const el = document.createElement('div');
  el.className = 'termHost';
  const term = new Terminal({
    fontFamily: "'Cascadia Mono', Consolas, 'Liberation Mono', Menlo, monospace",
    fontSize: 13,
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
  const inst: Instance = { term, fit, el, refit };
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

  // Which shells there are, and whether one already runs for this thread (after a reload, or a
  // look at another thread and back). Nothing starts from this.
  useEffect(() => {
    void sessions.loadShells();
  }, [sessions]);
  useEffect(() => {
    sessions.look(target.key);
  }, [sessions, target.key]);

  // Puts this shell's screen in the panel, and keeps it fitted to the panel's size.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    // A thread with no shell shows none: the last thread's screen is taken out (it is kept, to come back to).
    if (!live) {
      el.replaceChildren();
      return;
    }
    const inst = instanceFor(target.key, sessions);
    if (inst.el.parentElement !== el) el.replaceChildren(inst.el);
    if (!inst.term.element) inst.term.open(inst.el);
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
      const inst = instanceFor(target.key, sessions);
      el.replaceChildren(inst.el);
      if (!inst.term.element) inst.term.open(inst.el);
      inst.refit();
      sessions.resize(target.key, inst.term.cols, inst.term.rows);
    }
    sessions.start(target.key, target.cwd, choice);
    setTimeout(() => instances.get(target.key)?.term.focus(), 0);
  };

  const pickDefault = (id: string) => void sessions.setChoice(id);

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
