# Porting Threadbear to Windows (and Linux): scope and plan

Scoped 6 Nov 2026. Nothing here is built. The numbers for tokens and time are
estimates, and the section "How the estimates were worked out" says how.

## Short answer

- **The runner is the easy half.** It is TypeScript on Node 24, it already runs
  on Linux (INSTALL.md section 6). On this Windows machine, unchanged, its
  typecheck passes and 85% of its unit tests pass (1,312 of 1,539). Windows
  needs a handful of things Linux didn't: process trees, a service, shells,
  signals, links and file permissions. See "What the runner needs".
- **The app is the hard half, and it is a rewrite, not a port.** The Mac app is
  61,000 lines of Swift on SwiftUI, AppKit, WebKit and Quick Look, with a
  further 2,900 in the BearDock package. 102 files import AppKit. Swift builds
  on Windows, but SwiftUI and AppKit don't, so only `ThreadbearCore` (17,600
  lines, Foundation only) carries over, and it has nothing to draw with.
- **Rust is not needed for the runner and doesn't make the UI portable by
  itself.** It is a good fit for a thin desktop shell (tray, notifications,
  runner supervision, the RPC client) and for a small helper that does what
  Node can't on Windows. A Rust shell around a web UI is the cheapest way to
  get Windows and Linux from one codebase.
- **Recommended shape:** keep the runner in TypeScript, add Windows support to
  it first, then build a Tauri 2 desktop app (Rust shell, TypeScript and React
  UI) that talks to the runner over the existing protocol.
- **Rough size:** a daily-usable Windows app is about 1 to 2 million output
  tokens and 4 to 7 weeks of calendar time. Near parity with the Mac app is
  about 2 to 4 million and 2 to 4 months. The runner alone is about 0.3 to 0.6
  million and 1 to 2 weeks.

## What exists today

| Part | Where | Size | Windows story |
|---|---|---|---|
| Runner | `runner/src` | 48,100 lines TS, plus 39,500 of tests (1,500 tests) | Node runs on Windows. Needs the work below. |
| Mac app | `app/Sources/Threadbear` | 43,400 lines Swift | Rewrite. |
| App core | `app/Sources/ThreadbearCore` | 17,600 lines Swift, Foundation only | Protocol models, RPC client, transcript reducer, section rules. Logic to port, not code to reuse. |
| BearDock | `dock/` | 2,900 lines Swift | Replace with a web docking library. |
| iPhone app | `ios/` | 18,800 lines Swift | Not part of this. |
| Website | `web/` | 4,800 lines TS and React | Already a second UI, over Convex rather than the runner's own protocol. |
| Convex backend | `convex/` | 6,400 lines TS | Platform neutral. |
| Protocol | `docs/protocol.md` | 4,300 lines, about 46 request methods | WebSocket JSON-RPC with an HMAC handshake on loopback. Any language can speak it. |
| Mock runner | `app/Tools/mock-runner` | Node | Reusable to build and test a new UI without a real agent. |

Two other facts that shape the plan:

- The same view logic already exists three times: Swift for the Mac
  (`ThreadSections.swift`), Swift for the phone, TypeScript for the web
  (`web/src/sections.ts`, whose header says to change them together). A Rust
  native UI would be a fourth copy. A TypeScript UI shares with `web/` instead.
- The repo took 12 days to reach this size (911 commits, 826 with a Claude
  co-author, about 287,000 lines inserted). Agent throughput is not the limit
  here. Review, decisions and Windows-only debugging are.

## What I measured on this machine

Windows 11, Node 25.2.1, `npm ci` in `runner/`, nothing changed:

- `tsc --noEmit`: passes, no errors.
- `npm test` (unit tests only, 15 second limit per test instead of the
  default 5 minutes, which left the first run stuck for over ten minutes on
  tests waiting for something that never comes): **1,539 tests, 1,312 pass
  (85%), 166 fail, 53 time out, 8 skipped.** About ten minutes to run.
  Failures touch 40 of the 97 test files.

What the failures are, from the error text:

- **Fake CLIs and shell helpers that can't run.** The tests write
  `#!/bin/sh` scripts to stand in for `claude` and `codex` and spawn
  `/bin/sh`, `/bin/bash` or `/bin/sleep`, none of which exist. That accounts
  for most of the 53 time-outs and the Codex adapter and app-server files.
  The fix is a Node-script stand-in, which also helps the Linux runners.
- **Paths.** Expected strings with forward slashes and macOS-style
  `Library/Application Support` folders (`accounts-usage`, `updates`,
  `release`, `runner-keys`, `pair`), and 81 ENOENT errors in all, some of
  them paths that don't exist here and some of them the missing shells above.
- **Process groups, locks and links** (`proc`, `handover`, `restart`,
  `main`): the real product work in items 1 and 3 below.
- **Git worktrees driven through shell** (`worktrees.test.ts` is the largest
  single cluster).
- **Absolute-path imports.** Thirteen errors from child processes in
  `release.test.ts` import a `d:\...` path, which Windows' module loader
  refuses without a `file://` URL. I didn't trace whether it is the test's
  helper script or product code; `patches.ts` already converts correctly.

So the runner is closer to 85% done than not started. The remaining 15% is
real, and it is where the process and service work sits.

## What the runner needs

Grouped by how much work, with the files that matter.

**Real work (new code):**

1. **Process trees and stopping them** (`proc.ts`, `handover.ts`,
   `stuck-jobs.ts`, `frozen-cli.ts`, `restart.ts`). Today it records process
   groups from `ps` (pgid, start time), signals the group, and uses `lsof` to
   check who holds a socket. Windows has no process groups. The fix is a Job
   Object per CLI (kill-on-close), plus a tree walk by parent pid for the
   stuck-job check. Node can't create Job Objects, so this is the one place a
   small Rust helper (`tb-native`, using the `windows` crate) earns its keep.
   `taskkill /T` is the fallback without it.
2. **A service in place of launchd or systemd** (`scripts/install-runner.sh`,
   652 lines of bash, and `launch.mjs`). Use a Task Scheduler task that runs
   at logon and restarts on failure, running `node launch.mjs` as it does now.
   Write the installer in Node so Windows, Mac and Linux share it, instead of a
   fourth bash branch. `launch.mjs` already supervises and rolls back.
3. **Graceful stop without signals.** `SIGTERM` on Windows is a hard kill, so
   the supervisor's "stop cleanly" and a draining runner's exit need a message
   over the existing IPC or the loopback port instead.
4. **The `current` release link** (`launch.mjs`, `pointCurrent`). Symlinks need
   a privilege on Windows. Use a directory junction or a pointer file. The same
   goes for the `node_modules` link in worktrees.
5. **Shells.** `loginShell()` returns `/bin/zsh -lc`, `/bin/bash -lc` or
   `/bin/sh -lc`. Claude Code on Windows has its own shell story (Git Bash, or
   PowerShell where Git Bash is missing, which I have only from secondary
   sources). Patch actions and project checks need a choice. Git Bash keeps
   every existing command working; the trust code (`script-trust.ts`, 1,500
   lines, and `patch-trust.ts`) understands shell and JavaScript, and would
   treat PowerShell as untrusted until someone writes a parser. That is a
   security decision, not a porting detail.

**Small, mostly mechanical:**

6. Data and config paths. Linux kept the macOS folder names
   (`~/Library/Application Support/Threadbear`). On Windows I'd use
   `%APPDATA%\Threadbear` through one `dataDir()`, and fix the hard-coded
   copies in `runner-keys.ts`, `pair.ts` and the docs.
7. Finding the CLIs: `~/.local/bin/claude` becomes `claude.exe`; a
   `readlink` version probe (`updates/claude.ts`) won't work on an exe; the
   Codex platform map needs a `win32-x64` entry (`adapters/codex/appserver.ts`).
8. File modes (`0o600` secrets, `0o700` helper scripts). NTFS inherits the
   user profile's ACL, which is already user-only, so most of these can be
   no-ops with a check that the folder is under the profile.
9. `presence.ts` (`ioreg`) becomes `GetLastInputInfo`, `runner-stats.ts` and
   `user-name.ts` need Windows branches, `/usr/bin/open` becomes `start`.
10. Images (`images.ts`): `sips` and Quick Look become ImageMagick or `sharp`.
11. Off on Windows, as they are on Linux: `mac-screen.ts`, `secret-check.ts`,
    BrowserBear, ComputerCub.
12. A `tb.cmd` shim and a PATH entry; contributor scripts (`check.sh`,
    `dev-runner.sh`, `worktree-setup.sh`) run under Git Bash, with a Node
    replacement for anything that needs to run for a normal user.
13. A `windows-latest` job in CI. There is none today, which is why nothing has
    caught any of this.

**To verify, not assume:** Codex on Windows. Third-party sources say its native
Windows sandbox is shipped but still marked experimental; I could not confirm
`codex app-server` behaviour. Spike it before promising Codex threads.

## Does it need Rust?

Not the runner. It is 48,000 lines of TypeScript with 39,500 lines of tests,
it drives the Claude Agent SDK (a Node package), and Node already runs on
Windows and Linux. Rewriting it in Rust would cost more than everything else
in this plan combined and gain nothing a user could see. I'd treat that as a
separate project, if ever.

Rust earns its place in two spots:

- **`tb-native`**, about 600 to 1,000 lines: Job Objects, process-tree walks,
  idle time, ACL checks, clipboard images. Built per platform, optional.
- **The desktop shell**, about 3,000 to 5,000 lines: the RPC client and HMAC
  handshake (the shell reads the token file, so the web view never sees it),
  the tray, toast notifications, window state, single instance, `threadbear:`
  links, autostart, starting and watching the runner, and a file watcher.

## UI options

| Option | What it is | For | Against |
|---|---|---|---|
| **A. Tauri 2** (recommended) | Rust shell, TypeScript and React UI in the system web view | Light, one UI for Windows and Linux, shares logic with `web/`, WebView2 is Chromium so it behaves, scriptable with Playwright over CDP | Linux uses WebKitGTK, which is the weak spot (slower, more crashes in reports I found, and a Tauri CEF mode exists as a fallback). Two languages. |
| B. Pure Rust UI (egui, iced, Slint, GPUI) | No web view | Lightest, one language | The transcript is the hard part: 4,000+ rows, streaming Markdown, selectable rich text, diffs, images. Text selection across widgets is poor in these toolkits. Fourth copy of the view logic. Highest risk. |
| C. Electron | Bundled Chromium | Same rendering everywhere, easiest | `docs/plan.md` lists "the Electron app weight" as a reason Threadbear exists. |
| D. Website only | The existing `web/` app over Convex | Cheapest. Useful as soon as the runner works on Windows | Sees only what the phone sees: message text and one line per tool call, no tool output, diffs, patches or side panes. Needs Convex sync on. |

D is also a sensible first milestone: once the runner works on Windows, the
website is already a way to use it.

## Recommended shape

```
runner/          unchanged language, Windows support added (M1)
desktop/
  src-tauri/     Rust: shell, RPC client, tray, notifications, updater (M2)
  src/           TypeScript and React UI (M2, M3)
packages/ui-core TypeScript view logic shared by web/ and desktop/ (M2)
tb-native/       optional Rust helper for Windows process control (M1)
```

`ui-core` is the part that stops a fourth copy: sections, turn folding, the
transcript reducer and the protocol types, ported once from Swift (with the
Swift tests as the oracle) and used by both the website and the desktop app.

## Plan

Estimates are for one person directing several agent sessions in parallel
(the way the repo was built). "Calendar" includes review and Windows-only
debugging. "Output tokens" are what the agents write, including rewrites.
"All tokens" includes context read from cache on every turn, which is most of
the volume and the cheapest part of the bill. All of these are order of
magnitude, within a factor of about 2 either way.

| Milestone | You get | Code | Calendar | Output tokens | All tokens |
|---|---|---|---|---|---|
| **M0** Decide and baseline | Windows CI job, test baseline, two spikes (below), answers to the open questions | 1k | 2 to 4 days | 0.05 to 0.1M | 10 to 20M |
| **M1** Runner on Windows | Runner as a logon task, `tb` working, Claude threads run, website and phone usable as the UI. Codex if the spike passes | 8k touched | 1 to 2 weeks | 0.3 to 0.6M | 40 to 90M |
| **M2** Thin desktop app | Daily-usable: connect, sidebar (inbox, running, snooze, archive), transcript, composer with images, approvals and questions, toasts, tray, folder, account and model chips, runner start and stop | 20k | 2 to 4 weeks | 0.5 to 1.0M | 75 to 150M |
| **M3** Near parity | Highlights and the side pane, patches and action chips, projects, schedules, usage, other machines, phone pairing, settings, design reviews, subagents, docking, shortcuts, first-run tour | 36k | 4 to 8 weeks | 0.9 to 1.8M | 130 to 270M |
| **M4** Ship it | Installer, code signing, update path, Windows install guide for an agent, doc updates, Sentry, perf run, scripted-UI harness | 6k | 1 to 2 weeks, overlapping M3 | 0.15 to 0.3M | 25 to 45M |
| **M5** Linux app | `.deb` or AppImage, systemd already done, WebKitGTK tuning or CEF | 3k | 1 to 2 weeks | 0.1 to 0.2M | 15 to 30M |

Running totals:

- **Usable on Windows (M0 to M2):** about 0.85 to 1.7M output, 125 to 260M
  all tokens, 4 to 7 weeks.
- **Near parity and shipped (M0 to M4):** about 1.9 to 3.8M output, 280 to
  575M all tokens, 2 to 4 months.
- **Plus Linux (M5):** add about 0.1 to 0.2M and 1 to 2 weeks.

Your own time is mostly decisions at the start, then checking builds on your
machine. Budget an hour or two a day while it runs.

### M0: what to settle first

1. **Transcript spike (2 to 3 days).** A virtualised list in WebView2 against
   the mock runner's synthetic 4,100-row thread, with streaming Markdown at
   30 updates a second. The pass mark is the one already in `docs/plan.md`:
   first paint in 100 ms or less, thread switch in 50 ms or less, no hang over
   100 ms. If it fails, Option A is the wrong call and I'd look at Electron or
   CEF before spending anything on M2.
2. **Codex spike (half a day).** Does `codex app-server` start and complete a
   turn on Windows, and does the sandbox mode the runner expects exist.
3. **Claude Code shell check (half a day).** What shell its Bash tool uses on
   this machine, and how paths with spaces behave (this very repo lives under
   `D:\Repos\Y - Third Party`).
4. **Windows CI job** running typecheck and the unit tests, with a known-failing
   list that shrinks through M1.

## Risks and open questions

- **Transcript performance** is the biggest technical risk, and is why the
  spike comes first.
- **Trust and security model on Windows.** Patches and hooks run commands
  after you trust a folder. The command classifier knows shell and
  JavaScript. Windows adds PowerShell and `.cmd`. Decide: Git Bash only, or
  write a parser, or treat anything else as always untrusted.
- **Loopback and other users.** Windows machines with several sessions (RDP,
  fast user switching) share `127.0.0.1`. The HMAC handshake already means a
  squatter learns nothing, so this is covered, but test it.
- **Updates.** The Mac app and runner "follow main" by building on the user's
  machine. For the runner that is `git`, `node` and `npm`, fine on Windows. For
  a Tauri app it means Rust and the MSVC build tools, which is a lot to ask.
  I'd ship the desktop app as signed prebuilt releases through Tauri's
  updater, and keep the runner on follow-main.
- **Signing.** Unsigned installers get SmartScreen warnings. Options are an
  Authenticode certificate or Azure's signing service. I haven't priced them.
- **Keeping five clients in step.** After this, a protocol change can touch the
  runner, the Mac app, the phone, the website and the desktop app. Shared
  `ui-core` and the existing contract tests (`protocol-check.ts`) are the
  mitigation; budget for it.
- **Safety while testing here.** Process-tree and kill tests run on a
  daily-driver machine. Everything must target pids the test started, ideally
  through the Job Object, never by name.
- **Upstream.** `mikecann/threadbear` is "Mike's own agent app: a runner daemon
  plus a native Mac app". It has no Windows or Linux-app issues or PRs. A
  40,000-line second UI may not be something he wants in the tree. The
  runner changes (M1) are generic and small and would suit PRs; the desktop
  app is better kept in `desktop/` and discussed with him first. Each public
  PR or issue needs your yes.

## How the estimates were worked out

- **Code volume** comes from the Swift sources: the Mac app's views, models and
  logic by area, translated at roughly 0.7 lines of TypeScript per line of
  Swift (SwiftUI is verbose), plus a Rust shell, plus tests at the repo's
  ratios (0.3 for the app, 0.8 for the runner).
- **Output tokens** are code volume times about 25 tokens a line, which covers
  the final text and the rewrites and fixes on the way (about 12 for the
  finished line, doubled for churn), then a spread of 1x to 2x for unknowns.
  Cross-check: the whole repo is about 287,000 inserted lines, or roughly 7M
  output tokens at that rate; this plan's code is about a quarter of that
  (74,000 lines across all milestones).
- **All tokens** is output times 100 to 200, because each turn in a long
  session re-reads its context from cache. It is a larger number but a
  smaller bill per token than output; I haven't converted it to dollars
  because I don't have current rates to hand.
- **Calendar time** leans on the repo's own pace and then adds what that pace
  didn't have to pay for: a second platform to learn, a machine to test on,
  and a web view that must hit a performance bar the native one met.
- **Confidence:** M1 and M4 are fairly well understood. M2 depends on the
  transcript spike. M3 is the loosest, because "near parity" is a long list
  and each Mac panel (the folder browser alone is 1,300 lines) turns out to
  hide its own edge cases.

## Decisions needed from you

1. Is a usable runner on Windows with the website as the UI (M1) enough to
   start, with the desktop app decided after the spikes?
2. Tauri with a web UI, or are you set on a pure Rust UI? If so, I'd want the
   transcript spike done in that toolkit as well before choosing.
3. Git Bash as the one supported shell on Windows for patches and actions?
4. Do you want the runner changes offered upstream as small PRs, and the
   desktop app kept in your fork until Mike has said whether he wants it?
5. Windows only, or should M5 (Linux app) be in the commitment?

## Run log

Decisions from the reply to this plan (6 Nov 2026): Claude Code only, no Codex
(so the Codex spike is dropped and Codex stays off on Windows); anything that
is TypeScript stays TypeScript; the run goes up to and including M3, and
stops short of using more than 80% of the monthly allowance.

### M0 results

**Transcript spike: passed.** `desktop/spikes/transcript/` is a virtualised list
(`@tanstack/react-virtual`, `react-markdown`) of 4,101 synthetic rows, with a
6,000 character Markdown reply streaming in at 30 updates a second. Run in a
headless Edge 156 (the same Chromium as the WebView2 runtime on this machine,
156.0.4314.58) at 1280 by 800:

| Bar from `docs/plan.md` | Result |
|---|---|
| First paint in 100 ms or less | 60 ms cold open, 36 ms on a switch |
| Thread switch in 50 ms or less | 36 ms to first paint, 52 ms to settled at the bottom |
| No hang over 100 ms | No long task (50 ms or more) in streaming or a 2 second scroll sweep |
| Streaming | 2.5 ms median, 9.5 ms worst per update; every frame 16.7 ms |
| Memory | 19 MB JS heap |

What it does not cover: the event to row reducer (not written yet), real row
styling, images, and the GPU (headless uses software rendering). The main
thread numbers, which are what this measures, are not affected by that. It
runs the spike again as a regression check once the real transcript exists.

**Windows CI: added.** `.github/workflows/windows.yml` runs the typecheck and
`runner/scripts/test-windows.mjs`. The 57 test files that pass today (656
tests, 19 seconds) are enforced; the 40 in `runner/test/windows-known-failing.txt`
are reported and come off the list as M1 fixes them.

**Claude Code shell check:** folded into the first real turn in M1.

### M1 results (runner on Windows)

- The runner starts from source on Windows, listens on its port, spawns
  `claude.exe` in a thread's folder and carries the CLI's reply back through the
  protocol (tried with no login, which came back as a failed turn with the CLI's
  own message). A turn on a real model has not been run: `claude auth status`
  reads not logged in on this machine.
- What was added: `runner/src/platform.ts` (the places Windows differs),
  `win32-hide.ts` (no console windows for child processes), the Windows
  branches in `proc.ts` (a process tree stopped with `taskkill /T /F`, only when
  the recorded start time matches) and `system-tools.ts` (Git Bash for patch
  actions and checks), `scripts/install-windows.mjs` and `windows-run.mjs` (a
  logon task and its supervisor; dry-run and XML checked, not registered on this
  machine), and a `tb.cmd` shim. Codex is left alone on Windows.
- Unit tests: all 97 files run on Windows, 1,539 tests, 1,383 pass, none fail,
  156 skip with a reason (Codex, the Mac-only features, process groups, lsof
  handovers, the symlinked `current` release); the known-failing list is empty.
  The tests found real bugs, fixed in the runner: git paths in native form,
  drive paths in reply Markdown, `~/rest` always with forward slashes, a `:`
  joined PATH in `restart.ts`, and a CRLF update clone. Checked on Windows
  only: macOS and Linux changes were read, not run.
- Not done, by choice: runner releases, handovers and following `main` (the
  runner runs from the checkout), the Job Object helper (`taskkill /T` stands in,
  so a tool command that outlives a crashed CLI isn't caught), the idle check,
  and picture conversion through ImageMagick (untried).

### M2 and M3 results (the desktop app)

- `desktop/` is a TypeScript and React UI with a small Rust (Tauri 2) shell.
  It reuses the runner's protocol types and the website's section and turn
  logic. Pages: Projects, Schedules, Usage, Runners, Settings (with pools,
  Claude updates and phone pairing). Thread side panes: Highlights, Actions
  (patches and trust), Agents, Files. Thread features: asks and done cards
  joined to the composer, design reviews, pictures (read through `files.read`;
  pasted, dropped or chosen, through the bridge and `media.import`), edit a
  message, model, effort and access menus, rename. Also a shortcuts list, an
  appearance toggle and a first-run tour on the runner's sample threads.
- Checked against the repo's mock runner and against the real runner on Windows
  (its sample threads). The transcript, with 4,100 rows after loading every
  page, opens in 45 to 58 ms and switches in about 30 ms, with no long tasks
  while streaming or scrolling.
- The shell (`desktop/src-tauri/`): a window, a tray icon that keeps the app
  running when the window is closed, one copy at a time, the window's place
  remembered, toasts, a folder picker and links in the browser. It starts the
  Node bridge on a free loopback port and points the window at it, so the runner
  handshake stays in TypeScript. The page may call only the folder picker,
  notifications and opening a link (an unlisted plugin is refused). Release
  build: 5.1 MB, 1 minute 40 seconds. Run once against a mock runner (window
  loaded, connected, key wiped from the address); the tray, toasts and the
  folder dialog were not clicked.
- The bridge needs a key made for each launch on its WebSocket and uploads: any
  program on the PC can reach a loopback port, and Origin is only a browser's
  word. A connection with no key, a wrong one, or no Origin is refused.
- Not done: the Mac app's docking (Mac-only) and the per-ask picture boxes and
  draft autosave of design reviews. The installer and signing came next, and a
  real model turn has run since (both below).

### After M3: upstream merged, a real turn, and M4 (packaging)

Done on 6 Nov 2026, in the same branch.

- **Upstream merged.** 150 commits from `mikecann/threadbear` (to `d488512`),
  with three small conflicts, all in the lines the port had already touched.
  Upstream's new tests came to 1,875 in all, with 28 failing on Windows. They
  are fixed: five real Windows bugs (the patch-trust code lost `/dev/stdin` and
  `/dev/fd` after path normalising, named files with backslashes in messages,
  took a quoted `C:\...` command for something other than a path so the script
  it names was never hashed, didn't count a script a home patch names by a
  drive path as code, and `runCheck` hard-coded `/bin/sh`), and the rest were
  tests assuming a Mac. The run is now 1,883 tests: 1,704 pass, 179 are
  skipped with a reason, none fail, and `windows-known-failing.txt` is still
  empty. The one that mattered most is the quoted drive path: it let a trusted
  patch run a changed script on Windows, and it has its own test now.
- **A real model turn works.** From the staged copy (the installer's layout, its
  own `node.exe`, a temp data folder, a spare port): a Haiku turn ("reply with
  the single word ok") completed in 15 seconds, calling `end_turn` through the
  `threadbear` tool. A Codex turn on the free plan completed in 8 seconds, but
  only with `codexPath` set: the runner looked for a `codex` file beside Node,
  where npm puts a `codex.cmd` it can't start. On Windows it now uses the
  `codex.exe` a native install puts on the PATH, and with none found Codex stays
  off as before.
- **A bug found on the way:** `install-windows.mjs` read the user's PATH with
  `GetEnvironmentVariable`, which expands `%VARIABLES%`, and wrote it back with
  `SetEnvironmentVariable`, which stores the expanded text as a plain string.
  Run on a real PATH it would have rewritten the rest of it. It now reads the
  registry value as stored, writes an expandable string, and writes at all only
  when its own folder has to go on or come off. Checked against a throwaway
  registry key (kind and `%USERPROFILE%` kept).
- **Packages**, named like npad's, `threadbear-v<version>-<type>-win-<arch>`:
  `setup-win-x64.exe` (Inno Setup, per user by default), `msi-win-x64.msi` (WiX 6,
  per user or `ALLUSERS=1`) and `portable-win-x64.zip`, each with a `.sha256`, and
  a `CHECKSUMS.txt` on the release. The same three for `arm64`. They carry the
  shell as `Threadbear.exe`, a pinned Node 24.22.2 (checked against its
  SHA-256 from nodejs.org), the runner's source and production packages, the
  bridge and the built UI, and the guide. The x64 set is 38 MB (setup), 45 MB
  (MSI) and 63 MB (zip); 180 MB unpacked. It was 543 MB until the Agent SDK's
  own 283 MB copy of Claude Code was left out: the runner always passes the
  path of the person's own `claude`.
- **Checked here:** the unsigned and the signed builds; signing with a
  throwaway certificate (the shell, the uninstaller, the setup exe and the MSI
  all carry it, and Windows calls it `UnknownError`, the untrusted root, which
  is the pass condition; the certificate was removed afterwards); the setup exe
  and the MSI installing, upgrading (the setup exe over itself) and uninstalling
  silently into temp folders; both programs inside the zip being x64; the asset
  validation script on the x64 set (it fails on the missing arm64 files, as it
  should); the release notes script on the changelog entry; the shell's command
  switches (`--runner --installed`, `--stop`, `--dry-run`, `--quit`) from the
  staged copy, using its bundled Node; the arm64 package fetch (npm gives the
  arm64 native packages).
- **Not checked:** an arm64 build (it needs the MSVC arm64 tools and the Rust
  target, and the workflow does it), the workflows on GitHub (nothing is pushed,
  so none has run), signing with a real Azure account, SmartScreen, the
  missing-WebView2 message, and the first-run dialog and the tray menu item
  (not clicked, to leave the desktop alone).
- **Release pipeline**, from npad's: `windows.yml` (runner tests and desktop
  checks, also called first by a release), `installers.yml` (one job per
  architecture, optional Azure Artifact Signing through OIDC), `release.yml`
  (`v*.*.*` tags, a dry run with `-f version=`, create release, build,
  validate, `CHECKSUMS.txt`, final notes). The version is
  `desktop/package.json`, kept the same as `Cargo.toml`, `Cargo.lock` and
  `tauri.conf.json` by `desktop/scripts/version.mjs`, and a tag has to equal it.
  `installer/release.sh` checks all that, the changelog's Highlights and the
  type checks before it tags.
- **Updates:** the installed app asks GitHub for the latest release once a day,
  shows a link in the rail when it is newer, and can be told not to in Settings,
  "This app". It installs nothing. The runner is not updated by following
  `main` on Windows; installing the next release over it is the way.
- **To turn real signing on** (the same as npad): an Azure Artifact Signing
  account and certificate profile; an app registration granted "Artifact
  Signing Certificate Profile Signer", with a federated credential bound to the
  GitHub environment `release`; the six `AZURE_*` repository variables named in
  `installers.yml`; and `THREADBEAR_PUBLISHER` if the certificate's subject
  isn't "Platima". Two traps from npad's LESSONS.md: GitHub's OIDC subject is
  name-based unless the repository opts in to the immutable one (Entra's form
  wants the ID-based one), and Entra matches the owner case-sensitively in
  lower case. With none of it set a release still builds, unsigned.

## Upstream pull requests

Scoped on 6 Nov 2026, against `mikecann/threadbear` at `d488512`. Nothing is
pushed or opened; each one waits for a yes, and anything sent goes out as
`Platima <13729856+platima@users.noreply.github.com>` with no other author line.

Mike's rules that apply to all of them (AGENTS.md): the agent-facing byte
budget (`runner/context-budget.json`) is untouched, because no tool, argument
or standing instruction changed (`context-budget.test.ts` passes); the docs have
to stay true (`docs/on-your-mac.md`, `docs/forking.md`, INSTALL.md); errors go
to Sentry only from his release builds, which a Windows runner is not (there is
no `release.json`); UI copy is plain words with no em dashes, and every
control has a tooltip.

| PR | What | Size | Stands alone | Status |
|---|---|---|---|---|
| 1. Runner: run on Windows | `runner/src` (25 files, mostly small branches behind `IS_WINDOWS`), the Task Scheduler install, the unit tests made to run on Windows, the `windows` CI job | 82 files, +1,151 -263 | Yes | Cut as the local branch `pr/windows-runner` (`ea4b296`) on `d488512`: typecheck clean, 1,883 tests, 0 fail on Windows. Not run on a Mac |
| 2. Desktop app for Windows | `desktop/`: the UI, the bridge, the Tauri shell (a window, tray, toasts) | 98 files, about 18.7k lines, mostly UI | Needs 1 (the bridge imports `runner/src/platform.ts`) | Built and checked. Raise it with Mike before a PR: it is a second UI for him to look after |
| 3. Windows packages and releases | `installer/`, `installers.yml`, `release.yml`, the version script, the update check | 11 files, about 1.3k lines | Needs 2 | Mostly belongs in the fork: the publisher, the two product GUIDs, the signing set-up and the update check's repository are the maintainer's own (docs/forking.md lists them). Offer it only if he wants Windows downloads from his repo |

The docs are cut with the PR they describe: the "On Windows" section of
`docs/on-your-mac.md` grows a bullet per PR, `docs/forking.md` gets a row per
PR, and INSTALL.md section 7 starts as the checkout steps and gains the
release steps with PR 3. This plan document stays in the fork.

What Mike should know before PR 1:

- Every change is either behind `IS_WINDOWS` or a helper in `platform.ts`, so
  macOS and Linux should run exactly as before, but that was read, not run.
  `./check.sh` on a Mac is the real test, and I'd ask him to run it.
- It touches 25 files in `runner/src`, including the patch-trust code. The one
  change there that isn't Windows-only is a message wording: file names in
  patch-trust messages now use forward slashes (a no-op where the separator is
  already `/`).
- On Windows the patch hash is built from native separators, so a hash made there
  differs from one made on a Mac for the same patch. Trust is per machine, so it
  doesn't matter yet; `claude-trust.ts` already uses forward slashes and
  `patchHash` could follow.
- A patch whose live command calls a script by a backslash path (`C:\...`) gets
  `command not found` from Git Bash, because bash eats the backslashes. The
  runner doesn't build that command, the patch does, so it was left alone.

A note the user could send Mike, in their own words:

> G'day Mike. I've been porting Threadbear to Windows with Claude Code, mainly
> for my own use. The runner runs there now, with all 97 unit test files passing
> on a Windows CI job, and I've built a Windows desktop app (Tauri around a React
> UI) and installers on top. The first piece is a branch against your main that
> only touches the runner, 82 files, nearly all small branches behind a
> Windows check, and I'd like to send it as a PR if you're happy for me to. I
> haven't run it on a Mac, so a `./check.sh` from you would be the real test.
> The desktop app is a bigger thing and I'd only send it if you want it in the
> repo. Let me know either way.

## Android

Mike has only made an iPhone app, and the user is on Android, so an Android
client is the next thing to scope. Nothing here is built.

What the iPhone app is: 108 Swift files, about 17k lines. `ThreadbearKit` (the
models, the Convex transport, the inbox sections, the turn folding, Markdown
blocks, pairing, the push key) is about 5k of it, tests aside. The rest is SwiftUI screens, a
notification service extension that opens the sealed push, and `QuickAsk` (voice
in and out, about 26 files). It talks only to the phone API in `convex/phone.ts`
(docs/convex-backend.md, section 6), never to a runner. `web/` is a React client
of the same API with the same inbox and thread logic in TypeScript (`sections.ts`,
`turns.ts`), already laid out for a phone (the rail becomes a tab bar), and
`desktop/` already reuses it.

Three ways to do it:

| | What | Reuse | Effort | Catches |
|---|---|---|---|---|
| A. Web app on the phone | An installable web app (PWA) of `web/` | All of it | Days | A phone token lives in the browser; Web Push needs a service worker and the sealed message opened with WebCrypto; no Play Store listing that works for everyone, since each person's site is a different origin |
| **B. Tauri 2 Android** (recommended) | The `web/` and `desktop/` UI built into an Android app by Tauri's mobile target, with a Kotlin plugin for Firebase push and the Keystore | About 90% of the UI, and the Rust/Tauri toolchain already here | MVP in 1 to 2 weeks | One more shell to keep, a WebView's feel rather than native, and the deployment address must be set at pairing, not at build time |
| C. Native Kotlin and Compose | Port `ThreadbearKit` and the screens | Only the design | 6 to 10 weeks | A third copy of the inbox and turn logic to keep in step with Swift and TypeScript |

**B in outline.** Pairing as the iPhone does it (a link or QR from the Mac or
Windows app's "Phone and browser" tab, which carries the deployment address and
a phone token), the inbox and sections, the thread with approvals, asks and the
done card, the composer with photos and the camera, and notifications.

**Notifications are the real work.** The iPhone gets a notification sealed with
a 32-byte key only that phone and its backend hold (AES-256-GCM), sent through
Apple by the push relay (docs/push-relay.md). Android needs the same through
Firebase Cloud Messaging: a second sender next to `convex/push.ts` and `relay/`
(a platform field on `phone:registerDevice`, which is a change to Mike's backend
and the protocol document, so it is an upstream PR of its own), a Kotlin service
that opens the sealed message with a key held in the Android Keystore, and a
Firebase project. The relay holds the sending key, so whoever publishes the app
owns it: the user's Firebase project would send for everyone who installs their
build, or each person runs their own relay as the doc already allows for Apple. A
backend with no relay key at all gets no phone notifications.

**What it would need from the user:** Android Studio (the SDK, the NDK and a JDK,
about 5 GB), the Rust Android targets (`rustup target add aarch64-linux-android
armv7-linux-androideabi x86_64-linux-android i686-linux-android`), a phone with
USB debugging or an emulator (which needs virtualisation switched on), a Firebase
project and its `google-services.json`, and for Play a developer account ($25
once) and an upload key kept somewhere safe. Signing and the Play listing are
the user's to do; the build can produce a signed `.aab` once the key exists.

**Estimate for B**, on the same footing as the table above: MVP (pair, inbox,
thread, composer, photos, push) 8 to 12k lines, 1 to 2 weeks, 0.25 to 0.5M
output tokens, 40 to 90M in all. For scale, this packaging round moved the
weekly allowance by about one point, and the whole of M0 to M3 by about two,
so the MVP is probably 2 to 5 points; that is a guess. Phase 2: a share target
(send a link or picture to a new thread), home-screen widget, and voice (Android's
speech recognition in place of QuickAsk): another 1 to 2 weeks.

Decisions for the user: B or C; whose Firebase and relay; and whether Mike's
backend takes the platform field upstream or the Android build runs against a
fork's backend until then.
