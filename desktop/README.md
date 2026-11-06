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
  never holds the token. The Tauri shell (to come) does the same job in Rust.

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

## Style

Plain words in the UI, no em dashes, no small labels above headings. Every
control has a `title` (tooltip). Colours come from the variables at the top of
`src/ui/styles.css`; it follows the system's dark or light setting.
