# Threadbear desktop

The Windows (and, later, Linux) app: TypeScript and React in a web view,
talking to the runner over the protocol in `docs/protocol.md`. The plan and
the reasons are in `docs/windows-port-plan.md`.

## How it fits together

- `src/core/`: `rpc.ts` (JSON-RPC client with reconnects), `store.ts` (the
  thread list, the open thread, actions), `model.ts` (a thread's events as
  transcript rows), `types.ts` (the runner's own `protocol.ts`, shared).
- `src/ui/`: the window. `App.tsx` is the rail, sidebar and main area;
  `Sidebar.tsx`, `ThreadView.tsx`, `Transcript.tsx`, `Composer.tsx`, `Cards.tsx`.
- It reuses the website's plain view logic: `web/src/sections.ts` (which
  thread goes under which heading), `turns.ts` (a finished turn folds to
  "Worked for 4m 12s") and `format.ts`. Change those with the Mac and iPhone
  copies, not here.
- `bridge/bridge.ts`: a loopback server that serves the built UI and passes
  its WebSocket on to the runner, doing the token handshake itself so the page
  never holds the token. It also sets the page's content security policy
  (nothing is loaded from outside the bridge except the update check's call to
  api.github.com, so a picture in an agent's Markdown is never fetched; the
  page draws its description instead). The settings it reads from the
  environment are listed at the top of the file.
- `src-tauri/`: the Tauri shell. It starts the bridge, opens the window on it,
  keeps a tray icon, shows toasts, picks folders and opens links in the browser
  (what the page may ask of it is in `capabilities/default.json`). Start-up
  problems (no Node, a bridge that does not come up) are shown in a window
  rather than ending silently.

## Pages and panes

Add a file and it appears; nothing shared needs editing.

- `src/ui/pages/<Name>.tsx` default-exports a `PageDef` (`registry.ts`): an
  icon in the rail, an optional list column (`Sidebar`) and the page (`Main`).
  The route is `#/<id>`.
- `src/ui/panes/<Name>.tsx` default-exports a `PaneDef`: a tab in an open
  thread's side pane. `available(thread)` hides it for a thread with nothing
  for it; `badge(thread)` puts a number on it.

Talk to the runner with `store.rpc.request(method, params)` and
`store.rpc.on(notification, handler)`. Keep a page's own state, hooks and CSS in
its own file (a `<Name>.css` imported by it). The types for every request and
event are in `runner/src/protocol.ts`.

## Seeing it

```
node scripts/dev-stack.mjs --id a      # mock runner + build + bridge; prints the address
```

then drive it with `scripts/browser.mjs` (headless Edge, a temp profile):
see its header. `window.__store` is the same store the page uses. The mock
runner (`app/Tools/mock-runner`) serves fixture threads, projects and
schedules; it won't have every method, so a page must show a plain error and
carry on when the runner says `-32601`.

Type checks: `npx tsc --noEmit -p .`

Tests: `npm test` runs the logic tests in `src/` and the bridge tests in
`bridge/`, which start the real bridge on free ports with a throwaway data
folder and a stand-in runner. Nothing touches the real runner or its folder.

## The window's address

The window keeps its saved state (theme, sidebar width, the update check's off
switch, the tour being done) under the address it is served from, so the shell
gives the bridge the same port every launch: one in 50000 to 59999 taken from the
user name, or `THREADBEAR_DESKTOP_PORT` (`0` for any free port, which also means
nothing is kept between runs and the daily check never runs). If that port is busy the bridge uses another for
that run, the saved state is not there for it, and the daily update check waits
for the next start instead of overruling a choice it cannot see.

To use the vite dev server (`npm run dev`, port 5183) with a bridge started by
hand, start the bridge with `THREADBEAR_BRIDGE_DEV=1`; otherwise that origin is
not trusted.

## Style

Plain words in the UI, no em dashes, no small labels above headings. Every
control has a `title` (tooltip). Colours come from the variables at the top of
`src/ui/styles.css`; it follows the system's dark or light setting.
