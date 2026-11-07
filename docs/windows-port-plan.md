# Porting Threadbear to Windows (and Linux): scope and plan

Scoped 6 Nov 2026. The sections down to "Decisions needed from you" are the
scope as it was first written, before anything was built; the run log after
them says what was built and what was found. The numbers for tokens and time
are estimates, and the section "How the estimates were worked out" says how.

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
- **Not checked** (at that point; the review below says what changed): an
  arm64 build (it needs the MSVC arm64 tools and the Rust target, and the
  workflow does it), the workflows on GitHub (nothing was pushed, so none had
  run), signing with a real Azure account, SmartScreen, the missing-WebView2
  message, and the first-run dialog and the tray menu item (not clicked, to
  leave the desktop alone).
- **Release pipeline**, from npad's (as first written; the review below
  changed the order): `windows.yml` (runner tests and desktop checks, also
  called first by a release), `installers.yml` (builds the packages, optional
  Azure Artifact Signing through OIDC), `release.yml` (`v*.*.*` tags, a dry run
  with `-f version=`, validate, `CHECKSUMS.txt`, a draft release made public
  last). The version is
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

### The adversarial review, and what it changed (6 Nov 2026, later)

The branch was pushed to the fork, and its first `windows` run failed. Six
reviewers then each read one area for what was wrong, not for what was right:
the runner's Windows code, whether the runner-only PR would change anything on
a Mac or Linux, the desktop app and shell, the CI and release set-up, the
installers, and the docs and method. Five agents fixed what held up, each one
reproducing a problem before fixing it and adding a test that fails without the
fix. What the review found, and what was done:

- **The CI run was red, and it was a product bug.** GitHub's runners spell TEMP
  as `C:\Users\RUNNER~1\...` (8.3 short form) while git and
  `fs.realpathSync.native` say `C:\Users\runneradmin\...`, and JS
  `fs.realpathSync` keeps the short form, so one folder compared as two: 17
  tests failed (worktree trust, a worktree's subfolder, patch trust). It was
  invisible here because this profile has no short name. The runner now compares
  paths through `realPathSync` in `platform.ts`; the test helper does too.
- **Trust holes.** A trusted patch could run a changed script when it named the
  script as `/c/Users/...`, an 8.3 name, `//localhost/C$/...` or `//?/C:/...`,
  or ran it through `npm.cmd`, `node.exe -e`, `powershell.exe`, `cmd /c x.bat`
  or `py`: the hash did not cover it. The ctime cache could be fooled on NTFS.
  A write to `x.ts::$DATA` skipped the "runs as code" check. All closed.
- **A missing Git Bash made every check pass.** `cmd.exe -c "..."` prints a
  banner and exits 0. Now the commands say Git for Windows is needed and fail.
- **Network paths.** Assistant text could make the runner read an SMB path
  (NTLM leak). Refused.
- **The single-instance lock failed open** when PowerShell could not give a
  start time, so two runners could share one data folder.
- **macOS and Linux were changed** by one kill-fallback condition (the
  SIGKILL follow-up) and by `core.autocrlf=false` on the update clone, against
  "nothing changes". Both are Windows-only now.
- **The desktop app** lost all its saved settings on every launch (the window's
  address, hence its local storage, changed each time; that included the update
  check's off switch), its external links were refused by a missing permission
  scope, a malformed request ended the bridge, it reconnected twice a second
  while the runner was down, sent no content security policy (a remote picture
  in agent output could carry data out), ended silently on a setup failure, and
  could leave the bridge running after a crash.
- **The installers** left the runner stopped after an upgrade, shared one folder
  between the setup exe and the MSI without either knowing, corrupted
  non-ASCII PATH entries and `tb.cmd`, stripped licence files, left out
  `docs/protocol.md` (so an installed runner's agents never got the patches
  instruction), and the setup exe's uninstaller did not quit the app.
- **The release flow** published before it had a file to publish, so a failed
  arm64 build left a public x64-only release that the update check would offer;
  the signing identity was in the same job as `npm ci`; actions and the signing
  client were unpinned; checksums came from an unauthenticated `curl`.
- **The docs and the method.** "None fail" was only true here. 122 of the 179
  skipped tests said "Codex is not supported on Windows", which was false. The
  update-check off switch, the dropping of pictures and "links that open" were
  claimed but did not work. The Android scope left out most of what Google
  asks of a new app.

After the fixes (this machine, Windows 11, Node 24): the runner suite is 1,957
tests, 1,892 pass, none fail, 65 are skipped (down from 179) across 125 files,
in about a minute; the desktop has 52 tests (it had 9); `tsc` and `cargo check`
are clean. With TEMP on a real 8.3 alias the 17 CI failures pass. One other
test fails in that setup, `reviews.test.ts` "a shot can be a video or an HTML
page", and only there: Node's `mkdtemp` on Windows refuses a folder whose path
is over about 240 characters (it worked at 230 and failed at 240 when tried),
and the alias's long form in a deep scratch folder was longer than that. It
passes with the normal TEMP and a real data folder's paths are far shorter.

On GitHub's `windows-latest` the first push failed 17 tests, as above. After
the fixes the run was red on one test, the launcher hash test (an agent had
un-skipped it because `shasum` exists in this machine's Git Bash; the runner
image's has none, as the original skip said), and with that skipped again the
run `af7dc302` passed: both jobs, 1,957 tests, 1,890 passed, none failed, 67
skipped. That is the real proof of the 8.3 short-name fix.

The installers were then run, not just compiled, and that found two faults the
agent that wrote them could not have: the MSI's new "Windows 10 1809 or later"
condition used `VersionNT`, which the Windows Installer service reports as 603
(Windows 8.1) on this Windows 11, so it refused every install; and its check
for a setup-exe copy read `HKEY_CURRENT_USER`, which the service does not
resolve to the user's hive for a per-user package (a key made for the test was
"not found"), so the MSI installed straight over a setup-exe copy. The MSI now
reads the build number from the registry and looks for the setup exe's
uninstaller in its default folder (a file search does work), and a probe MSI
confirmed both. In a run on this machine, with the user's PATH value unchanged
(same hash before and after): the setup exe installs, upgrades over itself and
uninstalls; the MSI installs, upgrades over itself and uninstalls; each refuses
with its message while the other's copy is present (the MSI only for a setup-exe
copy in the default folder); `Threadbear.exe --runner --installed`, `--start`,
`--dry-run` and a bad flag give the right answers and exit codes (their output
reaches a redirected file; a terminal prompt returns before a GUI-subsystem
program has printed).

After the port branch went onto the fork's `main` (fast-forward to `6a652705`,
7 Nov), `windows.yml` ran green there and `installers.yml` built the x64 and
arm64 packages on GitHub, unsigned, with the right names and checksums (the
arm64 setup exe, MSI and zip are 35, 40 and 57 MB). The first `windows.yml` run
on `main` failed on a timing assertion in `rpc.test.ts` (the first reconnect gap
was 176 ms against a 40 ms start on that runner), the same commit having passed
on the branch; the assertion was dropped and the floor checks on the later waits
kept.

The release dry run (`gh workflow run release.yml --ref <branch> -f version=v0.1.0`)
was run three times. The first stopped at its first check, as it should: the
changelog heading said `Unreleased`, and a final release needs a date. The second
got past that (on a throwaway branch with a placeholder date, since the real date
is for release day) and failed in the runner tests on `fsutil.test.ts`, which held
a file for 700 ms against retries of about 1.6 s and ran out of room once on a busy
runner; it now holds for 250 ms. The third passed every job: meta, both test jobs,
the x64 and arm64 stage and package jobs, and the publish job, which checked all
six packages, wrote `CHECKSUMS.txt` (six lines, each verified) and the notes
preview, and created no release and no tag. The signing job was skipped.

Still unproven, and said so where the docs claim it: the arm64 packages run on
an Arm PC (they were built, not run), the half of `release.yml` that only a tag
runs (the draft release, its comparison with the files, making it public),
real Azure signing and SmartScreen, the installers' action that restarts
a registered runner task and the uninstaller's quit of a running app (the
installers were run for real, into folders of their own, and are covered
below, but with no task registered and no app running), a click on a link, a
dropped picture or a setup-failure dialog in the real window, Windows 10, and anything on
macOS or Linux (the runner changes were read there, and run on Linux under WSL
for the kill fix and for one test helper only).

Left alone on purpose: `handover.ts` can't recognise a runner on Windows
(dormant, as handovers are off), each CLI spawn blocks the event loop for about
200 ms while PowerShell is asked for a start time, `-lc` costs about 410 ms a
command against 45 ms for `-c`, the task XML pins `process.execPath` (an nvm
upgrade breaks it), a clean CLI exit leaves its stragglers (`taskkill /T` needs
the parent, so it wants a Job Object), the staged tree ships `esbuild.exe` and
prettier though only convex's CLI may need them, an unzipped portable copy can
reach MAX_PATH in a deep folder, and a local build embeds the builder's cargo
path in `Threadbear.exe` (use `--remap-path-prefix`; CI builds embed the
runner's, not a person's).

A decision for the user: the package redistributes the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`, about 4 MB without its 283 MB native
binary), whose own licence says "All rights reserved" and defers to Anthropic's
legal terms, which say that offering Claude Code in a product is subject to the
Commercial Terms. The package keeps the licence files with it and nothing more
has been decided. The alternative is to install the SDK from npm on the user's
machine at first run (it needs npm or a tarball step and a network), or to ask
Anthropic.

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
| 1. Runner: run on Windows | `runner/src` (25 files, mostly small branches behind `IS_WINDOWS`), the Task Scheduler install, the unit tests made to run on Windows, the `windows` CI job | First cut: 82 files, +1,151 -263 | Yes | **Out of date, and to be cut again before anything is sent.** The first cut is the local branch `pr/windows-runner` (`ea4b296`) on `d488512`, from before the review fixes. Upstream is now 48 commits on (`efc0c9e`) and a merge conflicts in `claude-trust.ts`, `patch-trust.ts`, `schedule-check.ts` and `claude-trust.test.ts`: upstream now JSON-quotes a path that has a backslash in the trust hash input, which the Windows hashing has to be reconciled with. The fork branch has the fixes and passes here and on GitHub's Windows runner (1,957 tests, none fail); the cut has to take the same fixes, be merged with upstream, and be run again on Windows. Not run on a Mac |
| 2. Desktop app for Windows | `desktop/`: the UI, the bridge, the Tauri shell (a window, tray, toasts) | 97 files, about 18.7k lines before the review (8.2k of it lockfiles), mostly UI | Needs 1 (the bridge imports `runner/src/platform.ts`) | Built and checked, except in a real window: nobody has clicked a link, dropped a picture or seen the setup-failure dialog. Raise it with Mike before a PR: it is a second UI for him to look after |
| 3. Windows packages and releases | `installer/`, `installers.yml`, `release.yml`, the version script, the update check | 15 files, about 1.6k lines before the review | Needs 2 | Mostly belongs in the fork: the publisher, the two product GUIDs, the signing set-up and the update check's repository are the maintainer's own (docs/forking.md lists them). Offer it only if he wants Windows downloads from his repo |

The docs are cut with the PR they describe: the "On Windows" section of
`docs/on-your-mac.md` grows a bullet per PR, `docs/forking.md` gets a row per
PR, and INSTALL.md section 7 starts as the checkout steps and gains the
release steps with PR 3. This plan document stays in the fork.

What Mike should know before PR 1:

- Every change is meant to be behind `IS_WINDOWS` or a helper in
  `platform.ts`, so macOS and Linux run exactly as before, but that was read,
  not run, and the first cut was not clean: one kill-fallback condition and a
  `git clone` argument changed for every platform, and the cut carried a
  repo-wide `.gitattributes` (`* text=auto eol=lf`). The first two are fixed in
  the fork branch; the third should be said out loud to Mike or left out.
  `./check.sh` on a Mac is the real test, and I'd ask him to run it.
- It touches about 30 files in `runner/src`, including the patch-trust code. The
  one change there that isn't Windows-only is a message wording: file names in
  patch-trust messages now use forward slashes (a no-op where the separator is
  already `/`).
- The `windows` workflow runs on a push to `main`, and upstream now holds its
  daily release tag until every workflow's latest run on that commit has passed
  (`ciVerdict` in `upstream.ts`). A red or flaky Windows run would hold Mike's
  macOS releases. Give it a path filter (`runner/**`), or make it manual, or
  tell him and let him decide.
- The first cut had no docs. AGENTS.md wants `docs/on-your-mac.md` to list
  what is installed or run in the background (a logon task, `tb.cmd`, a PATH
  change, `powershell.exe`, `taskkill`, `rundll32`), a row in
  `docs/forking.md`, and `docs/protocol.md` fixed where it says the data folder
  is under `~/Library` and a picture path is "on this Mac". Several comments in
  it point at `docs/windows-port-plan.md`, which stays in the fork.
- On Windows the patch hash is built from native separators, so a hash made there
  differs from one made on a Mac for the same patch. Trust is per machine, so it
  doesn't matter yet; `claude-trust.ts` already uses forward slashes and
  `patchHash` could follow.
- A patch whose live command calls a script by a backslash path (`C:\...`) gets
  `command not found` from Git Bash, because bash eats the backslashes. The
  runner doesn't build that command, the patch does, so it was left alone.

A note the user could send Mike, in their own words:

> G'day Mike. I've been porting Threadbear to Windows with Claude Code, mainly
> for my own use. The runner runs there now (all the unit tests pass on my
> Windows machine, and I'm getting the Windows CI job green), and I've built a
> Windows desktop app (Tauri around a React UI) and installers on top. The first
> piece would be a PR against your main that only touches the runner, mostly
> small branches behind a Windows check, plus a Windows CI job. A few things you
> should know: I haven't run it on a Mac, so a `./check.sh` from you would be
> the real test; it adds a `windows` workflow, and your release logic waits for
> every workflow, so I'd scope it to `runner/**` unless you'd rather have it
> run on everything; and it touches the patch-trust code, so I'd want your eyes
> on that part. The desktop app is a bigger thing and I'd only send it if you
> want it in the repo. Let me know either way.
>
> (To be sent only once the Windows job is green on the fork, the PR is cut
> again on your current main, and the user has said yes. The counts in it
> should be checked against that run.)

## Android

Mike has only made an iPhone app, and the user is on Android, so an Android
client is the next thing to scope. Nothing here is built.

What the iPhone app is: 117 Swift files, about 15.9k lines without the tests
(19.7k with them). `ThreadbearKit` (the
models, the Convex transport, the inbox sections, the turn folding, Markdown
blocks, pairing, the push key) is about 5k of it, tests aside. The rest is SwiftUI screens, a
notification service extension that opens the sealed push, and `QuickAsk` (voice
in and out, about 26 files). It talks only to the phone API in `convex/phone.ts`
(docs/convex-backend.md, section 6), never to a runner. `web/` is a React client
of the same API with the same inbox and thread logic in TypeScript (`sections.ts`,
`turns.ts`), already laid out for a phone (the rail becomes a tab bar), about
4.5k lines. `desktop/` shares some of its code, but it speaks the runner's
protocol through a loopback bridge, which a phone cannot reach, so only `web/`
is the starting point for an Android client.

Three ways to do it:

| | What | Reuse | Effort | Catches |
|---|---|---|---|---|
| A. Web app on the phone | An installable web app (PWA) of `web/` | All of it | Days | A phone token lives in the browser; Web Push needs a service worker and the sealed message opened with WebCrypto; no Play Store listing that works for everyone, since each person's site is a different origin |
| **B. Tauri 2 Android** (recommended) | The `web/` UI built into an Android app by Tauri's mobile target, with a Kotlin plugin for Firebase push and the Keystore | Most of `web/` (its Convex client, inbox and turn logic, and screens), and the Rust/Tauri toolchain already here; the pairing, push and camera parts are new | A sideloadable MVP in 1 to 2 weeks; a Play listing takes longer (below) | One more shell to keep, a WebView's feel rather than native, and the deployment address must be set at pairing, not at build time |
| C. Native Kotlin and Compose | Port `ThreadbearKit` and the screens | Only the design | 6 to 10 weeks | A third copy of the inbox and turn logic to keep in step with Swift and TypeScript |

**B in outline.** Pairing as the iPhone does it (a link or QR from the Mac or
Windows app's "Phone and browser" tab, which carries the deployment address and
a phone token), the inbox and sections, the thread with approvals, asks and the
done card, the composer with photos and the camera, and notifications.

**Notifications are the real work.** The iPhone gets a notification sealed with
a 32-byte key only that phone and its backend hold (AES-256-GCM), sent through
Apple by the push relay (docs/push-relay.md). Android needs the same through
Firebase Cloud Messaging: a second sender next to `convex/push.ts` and `relay/`,
a Kotlin service that opens the sealed message, and a Firebase project. The
backend change is more than a field. `phone:registerDevice` takes an
`apnsToken` and an `environment` that is `sandbox` or `production`, the
`devices` table is indexed by `apnsToken`, the relay's `/send` takes a
`deviceToken` and an `environment`, and `push.ts` talks to one `PUSH_RELAY_URL`.
Android needs a platform on the device, routing to a second relay (or a second
kind of send), a second `relayInstall`, and a change to the API version, the
protocol document and the contract tests: an upstream PR of its own, and a
change to Mike's backend. The phone already makes its own 32-byte push key and
sends it with `registerDevice`, so on Android the key is generated by the app,
sent the same way and kept wrapped by a Keystore key (a non-exportable Keystore
key cannot itself be the shared key). Tauri's notification plugin only shows
local notifications, so the receiving side is a Kotlin `FirebaseMessagingService`
(with its manifest entry and Gradle setup) that has to work without the
WebView running. The relay holds the sending key, so whoever publishes the app
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

**What the first draft of this scope left out** (check each against Google's
current rules when the time comes, as they change): Play's required target API
level for new apps; for a new personal developer account, a closed test with a
set number of testers over a set number of days before production access, which
makes "MVP in 1 to 2 weeks" a sideload figure, not a Play one; Google's
identity checks for the account and its developer verification for apps
installed outside Play; the Data safety form and a privacy policy; reviewer
access for an app that is useless without a paired backend; the notification
permission an app has to ask for on Android 13 and later; Doze and the
battery limits some makers add, which delay or drop pushes; and registering
again when Firebase changes the device's token (`onNewToken`). Pairing needs no
App Links: the iPhone pairs through a `threadbear://` link, so Android needs an
intent filter for it or a QR scanner in the app.

**Estimate for B**, on the same footing as the table above: MVP (pair, inbox,
thread, composer, photos, push) 8 to 12k lines (new code, not counting what
`web/` already has), 1 to 2 weeks, 0.25 to 0.5M output tokens, 40 to 90M in all.
That method put M0 to M2 at 4 to 7 weeks, and they took about a day, so it
overstates the time that code takes and says nothing about Google's waiting
periods. For scale, this packaging round moved the weekly allowance by about
one point, and the whole of M0 to M3 by about two, so the MVP is probably 2 to
5 points; that is a guess. Phase 2: a share target
(send a link or picture to a new thread), home-screen widget, and voice (Android's
speech recognition in place of QuickAsk): another 1 to 2 weeks.

Decisions for the user: B or C; whose Firebase and relay; and whether Mike's
backend takes the platform field upstream or the Android build runs against a
fork's backend until then.
