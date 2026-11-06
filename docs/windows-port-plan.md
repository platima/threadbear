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
