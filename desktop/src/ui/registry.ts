// Pages and thread side panes are found by file name, so each can be added
// without touching anything shared: a file in src/ui/pages/ is a page in the
// rail, a file in src/ui/panes/ is a tab in a thread's side pane. Each
// exports a default PageDef or PaneDef.
import type { ComponentType } from 'react';
import type { AppStore, Snapshot } from '../core/store.ts';
import type { ThreadSummary } from '../core/types.ts';

export type PageProps = {
  store: AppStore;
  snap: Snapshot;
  // Opens a thread on the Threads page.
  openThread: (threadId: string) => void;
};

export type PageDef = {
  id: string; // the route: #/<id>
  title: string; // the page's name
  hint?: string; // a sentence on what the page is for: the rail's tooltip, after the name
  icon: string; // one character or short symbol for the rail
  // False leaves the page's button out of the rail (Connectors, with no gateway set up).
  available?: (snap: Snapshot) => boolean;
  // A dot on the page's rail button, and what its tooltip adds: the accent one for something
  // that is the person's to do, a quiet one for trouble that usually mends itself.
  signal?: (snap: Snapshot) => { dot: 'accent' | 'quiet'; tip: string } | undefined;
  order: number; // rail position, after Threads (0)
  // The list column beside the page, when it has one (a list of projects,
  // of schedules). Without one the page takes the whole width.
  Sidebar?: ComponentType<PageProps>;
  Main: ComponentType<PageProps>;
};

export type PaneProps = {
  store: AppStore;
  snap: Snapshot;
  thread: ThreadSummary;
};

export type PaneDef = {
  id: string;
  title: string;
  hint?: string; // a sentence on what the pane shows: the tab's tooltip, after its name
  order: number;
  // False hides the tab for a thread that has nothing for it.
  available?: (thread: ThreadSummary) => boolean;
  // A number to show on the tab (pending items), if any.
  badge?: (thread: ThreadSummary) => number | undefined;
  Pane: ComponentType<PaneProps>;
};

const pageModules = import.meta.glob<{ default: PageDef }>('./pages/*.tsx', { eager: true });
const paneModules = import.meta.glob<{ default: PaneDef }>('./panes/*.tsx', { eager: true });

// A tooltip that names the thing and says what it is for: "Files: Browse ...".
export const tip = (title: string, hint?: string): string => (hint ? `${title}: ${hint}` : title);

export const PAGES: PageDef[] = Object.values(pageModules)
  .map((m) => m.default)
  .sort((a, b) => a.order - b.order);

export const PANES: PaneDef[] = Object.values(paneModules)
  .map((m) => m.default)
  .sort((a, b) => a.order - b.order);
