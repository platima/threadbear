# What Threadbear does on your Mac

Everything Threadbear installs, runs in the background, reads, and talks to
over the network. It's here so you, or the agent installing it for you, can
check the code against it before running anything. If the code does
something that isn't on this list, treat that as a problem and say so.
File references are where to look.

## What setup and install add

- **Git remotes** (`scripts/setup.mjs`, "Your copy"): Mike's repo becomes
  `upstream`. If `gh` is logged in and you cloned rather than forked, setup
  forks the repo to your GitHub account (`gh repo fork --remote`).
- **Packages:** `npm ci` in the repo, in `runner/`, and in each runner
  release. esbuild and fsevents have install scripts.
- **Convex, in your own account:** a login (`~/.convex/config.json`), a
  project with a production deployment, a deploy key, and one environment
  variable (`RUNNER_KEY`). It deploys `convex/` and the `web/` site there.
  A second Mac set up with `--existing` gets none of these: its runner's
  key comes from your first Mac (`tb runner add`), which also writes the
  deployment's address into its `runner.json`.
  If that login goes missing or expires, the Convex panel's Sign in to
  Convex button runs `convex login` again from the runner, which writes
  the same file; you approve it in your browser on auth.convex.dev.
- **Apps:** `~/Applications/Threadbear.app` and
  `~/Applications/Threadbear Runner.app`, both built and signed on your Mac.
- **A LaunchAgent:** `~/Library/LaunchAgents/com.mikerosoft.threadbear.runner.plist`,
  which keeps the runner going while you're logged in. A runner on a Linux
  server (INSTALL.md, section 6) has a systemd user service in its place,
  `~/.config/systemd/user/com.mikerosoft.threadbear.runner.service`, and no
  apps; it converts pictures with ImageMagick and rsvg-convert, and reads
  the account's full name from `getent passwd` rather than `id -F`.
- **A command:** `~/.local/bin/threadbear`.
- **Files:** the data folder `~/Library/Application Support/Threadbear`
  (threads, settings, `secrets/`, runner releases, the pinned release key
  `upstream-signers`, and `sync-sent.json`, hashes of what's already in your
  Convex mirror so a restart sends only what changed, and
  `shared-pools.json`, the last pools your Convex backend had, which every
  runner shares, so one starts with them while the backend can't be reached,
  and `shortcuts.json`, the keyboard shortcuts you've changed in Settings >
  Keyboard, which the app reads and writes and never sends anywhere). In `secrets/`, `asked/` holds the answers you
  type into an agent's secret card, one owner-only file each with a small
  script beside it that prints it for `sudo -A`, removed after 24 hours,
  and `secret-box.key` is the key your phone seals those answers to;
  `made-deploy-keys` lists, by name, the deploy keys this Mac made (setup's
  and the Convex panel's), so `tb runner rotate-owner` can tell them from
  others;
  `convex-key` is this Mac's key for your Convex backend (the deployment's
  `RUNNER_KEY` on your first Mac, a runner key of its own on any other);
  `runners/<id>.token` is another Mac's runner token, if you copied one
  in (only for Settings > Runners > Connect to other machines directly;
  by default another Mac's threads come through your Convex backend, read
  by your first Mac's runner while one is open, and nothing connects to
  that Mac), and `runners/<id>.host` beside it, which you copy in too (`tb pair`
  on that Mac prints both): the only host the app sends that token to.
  The app only reads these, and proves it has the token rather than
  sending it (docs/protocol.md, "Auth"); with no `.host` it dials nowhere;
  `~/Library/Caches/Threadbear/update`;
  `~/Library/Caches/Threadbear/remote` (copies of pictures and files from
  threads on your other Macs, at most 512 MB, unused ones go after 30 days);
  `~/Library/Logs/threadbear-runner.log` and `threadbear-update.log`;
  `~/Library/Logs/Threadbear/hangs` (the last 10 times the app froze: if its
  main thread is stuck for 4 seconds it runs macOS's `sample` on itself, in
  a sandbox, and
  nothing else ever reads these); and `~/ThreadbearThreads`, the default
  folder for new threads. A folder you open from a link in the side pane
  is listed, and watched for changes only while it's showing, and macOS may
  ask for permission the first time that's somewhere like Documents. The runner also runs `vm_stat` and `sw_vers` on a Mac, or reads `/proc/meminfo` and `/etc/os-release` on Linux, for the memory and system figures in the website's Runners view and the Mac app's runner details (`runner/src/runner-stats.ts`), every 5 minutes and while either is open. It also runs `ps`, and `sample` (in a
  sandbox, through `sandbox-exec`) on a thread's own CLI, when a turn has been quiet for a minute,
  to tell a CLI frozen on a macOS prompt from a long job. The sample is a
  temp file, deleted straight after. Taking over from a draining runner
  older than 5 Nov 2026, it runs `lsof` on that runner's pid once, to check
  the connection it's about to send the token over is really that runner's.
  `mac-screen.json` in the data folder
  remembers what it's said about dialogs on the screen (below).

## What runs in the background

- **The runner** listens on `127.0.0.1:8797` only, and needs a token
  (`runner/src/config.ts`). It starts the official `claude` and `codex`
  CLIs for your threads.
- **Agents get full access by default.** Claude runs with
  `bypassPermissions` and Codex with `danger-full-access`. "Ask before
  edits" is a choice for each thread.
- **Your phone and browser can drive the Mac.** A paired iPhone or a
  signed-in browser can start threads in any folder, send messages and
  answer approvals, through your Convex deployment (`runner/src/sync.ts`).
  Those threads start on full access like any other, so treat a pairing like
  a login to the Mac, and so is admin access to your Convex deployment.
  Pairings last 90 days unless set otherwise, at most 365
  (`convex/tokens.ts`); Revoke in Settings › Phone & browser ends one.
- **Following your main** (`runner/src/update.ts`, `app/Sources/Threadbear/AppUpdate.swift`):
  the runner and the app watch your local `main`, and look again every 5
  minutes. Within seconds of it changing, they rebuild themselves from it
  and redeploy your backend, so whatever reaches your `main` runs, with no
  signature check; only Mike's release tags are signed (below). Turn it
  off for both with `followMain: false` in `runner.json` (ask any thread
  to; it left Settings on 2 Nov).
- **Schedule checks** (`runner/src/schedule-check.ts`, experiment
  `scheduleChecks`, off by default): a schedule's check command runs in
  `/bin/sh` before each run, as you, for at most a minute. Each keeps a
  state file in `schedule-checks/` in Threadbear's data folder, and
  beside it what the check last printed (`<id>.<hash>.kept.json`, readable
  only by you) until a run carrying it has been sent, and, while a check
  runs, which runner process is running it (`<id>.running.json`).
- **Keeping the Mac awake** (`runner/src/keep-awake.ts`, experiment
  `keepAwake`, off by default): while a thread is working and for 3
  minutes after, the runner runs macOS's `/usr/bin/caffeinate -i -w
  <runner pid>`, which stops idle sleep only (the display still sleeps
  and the screen still locks). While it does, it reads `pmset -g batt`
  every 2 minutes and lets go on battery below 15%.
- **Mike's releases** (`runner/src/upstream.ts`): every 6 hours it fetches
  `upstream`'s signed `release/*` tags into `refs/threadbear/upstream-incoming/`
  in your checkout, checks each with `ssh-keygen -Y verify` against the
  pinned key (the signature goes in a temp file under `$TMPDIR` for a
  moment), and copies those that pass to `refs/threadbear/upstream/`. It never changes your code by
  itself. Every 5 days, when there's one your copy doesn't have, it starts
  one thread (on your own Claude or Codex login, like any thread) that
  merges it in a worktree, runs the checks and asks you before it lands
  (`runner/src/bring-in.ts`). A release Mike marks important starts one
  straight away. Settings › General › Updates from Mike, or
  `"releases": { "bringIn": 14 }` (or `"important"`, or `"off"`) in
  `runner.json`, changes it. It keeps what it last did in
  `runner/bring-in.json` in the data folder.
- **CLI updates** (`runner/src/updates/`): every hour it checks for new
  Claude Code and Codex versions and installs them. If you don't point it
  at your own Codex, it installs one into the data folder.
  `THREADBEAR_CLI_UPDATES=off` stops this.
- **Small model calls** (`runner/src/models/`): thread titles, filing
  threads into projects (the librarian, every 5 minutes) and similar jobs
  send short excerpts of your threads to `claude -p` on your own logins.
  When a project's notes pass 12,000 characters, the librarian sends them
  the same way to be rewritten shorter, and keeps the old notes in the
  data folder's `project-notes/` (the last 5 for each project).
- **Housekeeping** (`runner/src/housekeeping.ts`): trims logs, deletes
  week-old copies of pictures pasted into drafts (a sent message keeps its
  own copy) and deleted threads after 30 days in the trash. Archived
  threads keep their pictures unless you set `"archivedMediaDays": <days>`
  in `runner.json`.
- **Presence** (`runner/src/presence.ts`): reads how long the keyboard and
  mouse have been idle (`ioreg`), so your phone knows whether you're at
  the Mac.
- **Dialogs on the screen** (`runner/src/mac-screen.ts`): every 2 minutes it
  runs `osascript` to count the windows of macOS's UserNotificationCenter, so
  it can tell you when a dialog has been left waiting. It sees how many, not
  what they say. `THREADBEAR_MAC_SCREEN=off` stops it.
- **Patches** (`.threadbear/patches/`): code from a folder runs only after
  you trust that folder (`runner/src/patch-trust.ts`). A folder's Claude
  Code hooks, other commands and `env` settings in its
  `.claude/settings*.json`, and its `.mcp.json` servers, are held back the
  same way (`runner/src/claude-trust.ts`):
  the runner reads those files and the scripts they name to hash them,
  and keeps what you trusted in the same `patch-trust.json`.
- **Menus on macOS 27.2** (`app/Sources/Threadbear/DragSpace.swift`): every
  5 seconds, and before a button opens a menu, the app asks the window
  server which Spaces its own windows are on, and takes them off the drag
  Space a window drag can leave them on, which hides their menus. A window
  filed under another display's Space than the one it's on (after a
  restart in the background) is put on its own display's. These are
  private window server calls, and they only touch the app's own windows.

## What it reads

- From your Claude and Codex logins: which account each is (the email in
  `~/.claude.json`), a few settings, and the token counts in your session
  transcripts, so it can show how much room each login has
  (`runner/src/accounts.ts`, `runner/src/token-tally.ts`;
  `THREADBEAR_TOKEN_TALLY=off` stops the counting). It never reads or
  copies login tokens or the Keychain.
- Token Stats' files, if you have that app, and any logins you've added
  under `accounts` in its data folder (`claude-1`, `codex-1`...).
- Your first name, from your Mac account's full name (`id -F`), so its
  agents know what to call you (`runner/src/user-name.ts`). It stays in
  the instructions your own threads get.
- Whether it has Full Disk Access, by opening macOS's permissions database
  (`~/Library/Application Support/com.apple.TCC/TCC.db`) and closing it
  again. It never reads it. Without the access macOS refuses, with no prompt.
- Whether `Threadbear.app` is in `/Applications` or `~/Applications`, as a Mac
  without it is probably one nobody sits at.
- The `.env*` files in the folders your threads work in (the folder, the
  folders directly inside it, and up to its repo's root; not `.env.example`
  and the like, your home folder or external drives), and everything in its
  own `secrets/` folder, to know what to take out of text before it goes to
  your Convex deployment (`runner/src/secret-values.ts`). Looked at when a
  folder first turns up, when a thread has just touched a file of secrets
  (including a `.env` in a folder of its choosing), and otherwise at most
  every 5 minutes. Kept in memory, never logged, written down or sent anywhere.

## Who it talks to

| Service | Whose | What goes there |
|---|---|---|
| Your Convex deployment | yours | Thread titles and status, all message text (each message cut at 8,000 characters), one line per tool call, projects, schedules, your logins' emails and usage, whether you're at the Mac, whether this machine is low on memory or disk, and the pictures you paste into a message, up to 10 MB each, so your own website can show them. Those go up as they are, in your deployment's file storage: unlike text, nothing can scrub a secret out of a picture, so a screenshot of something sensitive goes too. `"sync": { "pastedPictures": false }` in `runner.json` keeps them on this Mac. While someone has the website's Runners view open, this machine's CPU, memory and disk use, its processor model, operating system and time since it started, every 10 seconds; with nobody looking, none of that is sent. Photos you send from the phone, deleted once the Mac has fetched them. Pictures and videos agents put in their replies or pin, at most 10 MB each, for the phone to show. Other images only for threads you share by link. Other tool output and files stay on the Mac. Text has known secrets taken out first: see below. |
| Convex (the Convex panel) | yours | Only for a thread in a Convex project, when its Convex panel opens: the runner's Convex CLI asks api.convex.dev for the project's deployments and a deploy key, the runner asks the deployment whether a kept key still works (`/api/check_admin_key`), and the panel loads Convex's embedded dashboard (dashboard-embedded.convex.dev) with that key. Sign in to Convex goes to auth.convex.dev. (`runner/src/convex-keys.ts`) |
| Your other Macs, over ssh | yours | Only when you run `tb runner add <name> --ssh <host>` or `tb runner check --ssh <host>` on your first Mac: it reads that Mac's Threadbear `runner.json`, writes its id and the deployment's address there if it hasn't them, writes its new key into that Mac's `secrets/convex-key`, and looks whether that Mac has a deploy key, Convex panel keys or a Convex login (names only, never a key), through your own ssh setup with agent and port forwarding off (`runner/src/runner-keys.ts`). `tb runner audit` asks this Mac's runner for its threads' last seqs and your deployment for what the main key made. `tb runner rotate-owner` sets env vars on your deployment with your deploy key, and, if you give it a Convex team access token for that run (`CONVEX_TEAM_TOKEN`, never kept), asks api.convex.dev for the deployment's deploy keys (their names and dates) before it rotates. |
| GitHub | Mike's repo | Release tags fetched every 6 hours; the fork at setup |
| GitHub (the Windows app) | the fork's | Only the installed Windows app (see "On Windows"): `api.github.com/repos/<the fork>/releases/latest` once a day, to say in its rail when a newer release is out. A plain request: GitHub sees the PC's address and the app's user agent, and nothing else is sent. Settings, "This app", turns it off. |
| downloads.claude.ai, registry.npmjs.org | Anthropic, npm | CLI version checks and installs; `npm ci` |
| registry.npmjs.org (the Windows runner) | npm | Only a Windows install, on the runner's first start after it is installed or updated: the one tarball of the Claude Agent SDK (about 4 MB) that `runner/package-lock.json` names, checked against the hash in that file before it is unpacked (see "On Windows"). A plain request: npm sees the PC's address. Nothing else is sent. |
| Anthropic, OpenAI | yours | Your threads, through the official CLIs on your own logins. With the `labReview` experiment on (off by default), a thread's code change, with your message and the agent's reply, goes to your other provider's CLI as a review thread, as if you'd started one. After a turn fails because the API couldn't be reached, the runner itself opens (and straight away closes) a connection to api.anthropic.com or chatgpt.com on port 443, at most once a minute, until one opens and the thread carries on. Nothing is sent over it (`runner/src/net-probe.ts`). |
| Mike's push relay | Mike's | Only when a paired iPhone gets a notification. It's sent from your Convex deployment, not the Mac. The text is encrypted for the phone; the relay sees the device token and thread id (`convex/push.ts`, `docs/push-relay.md`). The first time, your deployment registers with it, giving its own address; the relay keeps that address and checks it by posting a one-time code back to your deployment's `/relay/verify` (`convex/http.ts`). |
| A Connectors gateway | whoever runs it | Only if one is set in `runner.json` or `~/.claude.json`. Its `/health` every few minutes (and once more at the end of a turn where a call to one of its services failed, to see if it needs signing in), and for a project with a Notion page, a Notion read or two every 5 minutes for its task board (`runner/src/notion-tasks.ts`), signed with the header the `headersHelper` command in that `connectors` entry prints, which it runs for each read |
| Sentry | Mike's | Nothing from your copy. Only a copy whose `origin` is Mike's own repo reports errors or uploads the app's debug symbols (`runner/src/sentry.ts`, `app/Sources/Threadbear/CrashReporting.swift`, `app/build-app.sh`). The App Store iPhone app sends anonymous crash reports. |

An HTML file opened in the side pane (a mockup or report an agent made,
a page in a project) talks to nothing. It loads through the app's own
`threadbear-preview:` scheme, which serves only that page and the
styles, pictures, fonts and media its markup names in its folder:
never another page, a script file, SVG, a dotfile, a symlink or a file
outside it. Its web view
blocks every other load (a WebKit content rule list, which WebKit keeps
in its own store under `~/Library/WebKit`), sends any connection it would
still make to a closed port on this Mac (127.0.0.1:9) so no name is
looked up, runs none of the page's scripts (unless you choose Run them
over that page, which turns them on for that version of the file only,
remembered by its SHA-256 in the app's settings), has WebRTC off, and doesn't
follow links away from it, submit
forms, open windows or download
(`app/Sources/Threadbear/Views/LocalPreviewSchemeHandler.swift`,
`app/Sources/ThreadbearCore/Support/LocalPreviewSite.swift`).

On the Mac itself, a web link you click in the app first goes to
BrowserBear's socket (`~/Library/Application Support/BrowserBear/browserbear.sock`),
if you have BrowserBear, to ask whether an agent's Chrome tab is already
on that page (`app/Sources/Threadbear/BrowserBear.swift`). Only the link
goes there.

The Browser panel also uses that private socket to list connected Chrome profiles
and the pages agents associate with threads. In an existing profile, frames and
your mouse and keys go through BrowserBear's extension; the page uses Chrome's
original sign-ins. Threadbear does not read Chrome's cookie database or copy
credentials. Frames stay on this Mac, in memory, and are not sent to Convex.
BrowserBear stores thread/tab/profile/target associations and cached page titles in `panel-tabs.json` in
its own folder (0600); it verifies the target before reconnecting after a service
restart. Closing a panel releases its viewport and focus overrides. Chrome's
native-window button pauses panel capture and input for native dialogs.

The optional separate agent Chrome (`browserbear ... --profile agent`) keeps its
existing path: the panel reads `agent/tabs.json` in BrowserBear's folder and connects
to that Chrome's local debugging port. It is real Google Chrome with its own profile
folder; any program on this Mac could reach that port, so it holds only what you
sign it in to (`app/Sources/Threadbear/Views/AgentBrowserPanel.swift`).

Nothing else: no analytics, no ads, no tracking.

## Secrets and your Convex deployment

Before any text goes to your deployment, the runner takes out what it can
recognise (`runner/src/scrub.ts`): shapes of keys and tokens
(`runner/src/redaction.ts`) and the actual values in `.env` files and its own
`secrets/` folder. Your deployment does the shape check again before storing it
(`convex/redaction.ts`), so an older runner can't put a known shape there. Your
own copy on the runner keeps every word. If the check itself fails, that text
isn't sent, and `tb status` says so.

**It isn't a guarantee.** It catches shapes and values it knows, so a secret in
an unfamiliar format can get through, and it can't read pictures at all: any
picture that goes up (ones agents post or pin, and anything in a thread you
share) goes as it is. Scrubbing also can't undo a leak. A key that shows up in
a thread has already been to the AI provider, so rotate it.

**Full sync** is off unless a runner's `runner.json` has `"sync": { "full": true }`.
With it off, tool output, diffs and tool screenshots stay on that runner, and
nothing below happens. With it on, from then on (older tools aren't sent), that
runner also sends each finished tool's output, its full input, its diffs and the
reasoning before it to your deployment, after the same scrubbing, where they're
kept 30 days. This lets you read them from any device while the runner's off. It's
the same not-a-guarantee as above, over much more text. A tool whose command or file
can hold secrets (`.env` files, `env list`, key files: `runner/src/withhold.ts`) sends
nothing of itself, and a runner without an on-device model relies on these checks
alone, which `tb status` says. A tool's screenshots stay on the runner unless you tap
one on the website, which uploads that one for a day.

`runner/scripts/scrub-stored.mjs` runs today's rules over what's already stored,
and only when you run it. Convex backups and snapshot exports keep their copies.

There's also a silent on-device check, off unless `runner.json` has
`secretCheck: { enabled: true }`, on a Mac with Apple Intelligence
(`runner/src/secret-check.ts`). It's an experiment: it builds a small helper the
first time (`<data>/tools/secret-check/`), and on mains power, at background
priority, it passes a sample of tool output and pictures to Apple's on-device
model, and Apple's on-device text recognition for a picture. Nothing leaves the
Mac and it changes nothing that uploads. It keeps counts, and the thread and
sequence number of what it flagged, in `<data>/secret-check.json`. Never the text.

## On Windows

A Windows runner (INSTALL.md, section 7) does the same things as the Mac one,
with these differences. All of it is in `runner/src/platform.ts`,
`win32-hide.ts`, `proc.ts`, `system-tools.ts` and `runner/scripts/` unless
said otherwise.

- **Installed by `runner/scripts/install-windows.mjs`:** a Task Scheduler task,
  "Threadbear Runner (<your Windows user name>)" (one made by an earlier
  version under the plain name is replaced), for the current user at logon (no
  admin rights, hidden, restarted if it fails, which stops when a runner says
  another is already using the data folder), which runs
  `conhost.exe --headless node scripts/windows-run.mjs`. That script keeps the
  runner running from the checkout (or from the installed copy, with the
  `node.exe` that comes in it), waits longer between tries when the runner keeps
  failing, and keeps its own log to about 2 MB. The task is made from an XML
  file that sits in `%TEMP%` as `threadbear-task-<pid>.xml` for a moment. It
  also writes `tb.cmd` to `%LOCALAPPDATA%\Threadbear\bin` (spelling the path
  with `%LOCALAPPDATA%` or `%APPDATA%` where it can, so an accented profile
  name isn't in the file, and switching the console's code page for the length
  of the run where it can't) and adds the folder to the user's PATH. The PATH is
  read from the registry unexpanded, through PowerShell, and written back as an
  expandable string, so the rest of it is left as it was, and it is only
  written when the folder has to be added or taken off; to make Windows tell
  open programs, it sets and clears the user variable `THREADBEAR_PATH_CHANGED`
  for an instant. `--uninstall` removes the task, the file and the PATH entry;
  `--stop` ends the task but leaves it registered; `--start` runs it if it is
  registered and not already running; `--installed` says whether it is.
- **Where things are:** the data folder is `%APPDATA%\Threadbear` (the Mac's
  layout inside it), the runner's log is
  `%LOCALAPPDATA%\Threadbear\Logs\threadbear-runner.log`, and the supervisor's
  is `runner-supervisor.log` beside it, with `runner-supervisor.log.1` once it
  has passed 2 MB. `%APPDATA%` is the roaming folder: on a PC with a roaming
  profile or folder redirection it may be copied to a server, and the runner's
  token and secrets are in it. NTFS gives these files the profile's own
  permissions, so the 0600 and 0700 modes are not set; when `THREADBEAR_HOME`
  is outside the profile the runner says so at startup, as another user of the
  PC may be able to read a folder on another drive.
- **Programs it runs:** `claude.exe` (from `~\.local\bin`; `claude update` on the
  same hourly schedule as on a Mac, which `cliUpdates` in `runner.json` can
  change or turn off), `git`, Git for Windows' `bash.exe` for patch commands and
  checks (found through `CLAUDE_CODE_GIT_BASH_PATH`, the places Git installs
  to, the Git folder of a `git.exe` on the PATH, or Git's `InstallPath` in the
  registry, which it only reads with `reg.exe query`; with none, those commands
  print that Git for Windows is needed and run nothing), `schtasks.exe` and
  `conhost.exe` for the task, `cmd.exe` for `tb.cmd`, `taskkill /T /F` on a
  process it started and still has recorded (only when its recorded start time
  matches, or the child it started hasn't exited, so a reused number is not
  stopped), `powershell.exe`
  to read a process's start time and the PATH, and
  `rundll32.exe url.dll,FileProtocolHandler` to open a web page. Every child is
  started with its console window hidden.
- **The desktop app** (`desktop/src-tauri/`, a Tauri shell) opens a window and
  a tray icon (closing the window keeps it in the tray; Quit in the tray menu
  ends it), keeps one copy running, and remembers the window's place (under
  `%APPDATA%\dev.threadbear.desktop`; the page's own storage is under
  `%LOCALAPPDATA%\dev.threadbear.desktop`, both Tauri's standard places). It
  starts `node desktop/bridge/bridge.ts` on a loopback port and stops it on
  quitting; if the app is killed, the bridge notices and exits by itself. The
  page it shows may pick a folder, show a toast and open an `http`, `https` or
  `mailto` link in your browser, and nothing else (`capabilities/default.json`).
- **The desktop bridge** (`desktop/bridge/bridge.ts`) listens on `127.0.0.1`
  only. The shell gives it one fixed port per Windows user (50000 to 59999,
  chosen from the user name), so the page keeps the same address and its saved
  settings between launches, and a free port instead when that one is taken
  (that launch starts afresh and says so in Settings). It serves the built page
  and passes its WebSocket to the runner, reading `secrets\runner-token` itself
  so the page never holds the token. Any program on the PC can reach a loopback
  port, so it refuses a WebSocket or upload without the key made for that
  launch, and one from any origin but its own (also the vite dev server's, when
  started for development). It sends a Content-Security-Policy that lets the
  page talk only to itself and to `api.github.com` (the update check), and
  shows a remote picture in a message as its description, not as a download.
  Pictures pasted into the composer are saved briefly under
  `%TEMP%\threadbear-uploads` and imported by the runner.
- **Installers** (`installer/`, built by `.github/workflows/installers.yml`
  from `release.yml`): a setup exe (Inno Setup), an MSI (WiX) and a zip, for
  x64 and arm64. They put the app in `%LOCALAPPDATA%\Programs\Threadbear` (or
  Program Files for a system-wide install): `Threadbear.exe`, a pinned
  `node\node.exe` (its SHA-256 is checked at build time, `installer/node.json`),
  the runner's source and its production packages (not the Claude Agent SDK:
  see the next item), the bridge and built UI, the
  guide and a few of the docs the guide points at, `README-WINDOWS.txt` and
  `THIRD-PARTY-NOTICES.txt`. They add a Start menu entry (the setup exe also
  one for the notices, and a desktop shortcut if asked) and an entry in
  Add/Remove Programs (`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`
  and `App Paths`, or `HKLM` for system-wide; the MSI also
  `Software\<publisher>\Threadbear`), and nothing else: no service, no PATH
  change, no file association. An installer replacing a running copy first asks
  the app to quit (`Threadbear.exe --quit`) and ends the runner's task
  (`--runner --stop`), and starts the task again afterwards (`--runner
  --start`) if it is registered; uninstalling does the same quit and stop, then
  runs `--runner --uninstall`. Each installer refuses while a copy from the
  other kind is installed (it reads `HKLM` registry keys and looks for the setup
  exe's uninstaller in `%LOCALAPPDATA%\Programs\Threadbear`; the MSI also reads
  `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` for the Windows build and
  the registry and `%LOCALAPPDATA%\Microsoft\EdgeWebView` for WebView2). The packages are unsigned unless the fork has set up
  Azure Artifact Signing, and the release notes of an unsigned one say so.
- **The Claude Agent SDK is fetched, not shipped.** It is Anthropic's, all
  rights reserved and subject to their terms, so the packages do not carry a
  copy; a Mac gets it from `npm ci`, and a Windows install has no npm. The
  supervisor starts the runner as `node --import scripts/agent-sdk-preload.mjs
  src/main.ts`. That script (`runner/scripts/agent-sdk.mjs`) reads the SDK's
  version, address and hash from `package-lock.json`, and if the SDK isn't in
  `node_modules` next to the runner, downloads that tarball from
  registry.npmjs.org (timeout two minutes), refuses it if it doesn't match the
  hash, unpacks it into `%LOCALAPPDATA%\Threadbear\sdk\<version>` (files and
  folders only; a name that could leave that folder, a link or a device is an
  error) and moves it into place whole, then removes the folders of other
  versions. An import of `@anthropic-ai/claude-agent-sdk` that Node can't find
  the usual way is looked for there (a resolve hook, for that name only). The
  folder is the person's own, so a system-wide install, whose own folder a
  normal user can't write to, works the same. With no network the runner does
  not start, says why in `runner-supervisor.log`, and tries again with longer
  waits; a source checkout with `npm ci` run in it never fetches anything. The
  setup exe's uninstaller deletes that folder; the MSI leaves it, as it does the
  logs and the data.
- **The runner's task is offered, not assumed:** the first time the installed
  app opens, it asks once whether to start the runner when you sign in to
  Windows, and sets that task up (the item above) if you say yes. "No thanks"
  is remembered in `%LOCALAPPDATA%\Threadbear\declined-runner-task`; the tray
  menu's "Start the runner at sign-in..." asks again. Each time the app opens
  with the task registered it runs `--runner --start`, so the runner comes back
  after an update. `Threadbear.exe --runner [--installed | --start | --stop |
  --status | --uninstall | --dry-run]` runs the same script from a terminal or
  an installer (its answer prints to the terminal that started it; an unknown
  flag is refused).
- **The update check** (`desktop/src/core/updates.ts`): the installed app asks
  `api.github.com/repos/<the fork>/releases/latest` once a day (a plain
  request, so GitHub sees the PC's address and the app's user agent, and
  nothing else is sent), keeps the answer in the page's local storage, and
  shows a link to the release in the rail if it is newer, once it has checked
  that the link is a release page of that repository. It downloads nothing.
  Settings, "This app", turns it off, and an off switch it can't read counts as
  off. When the page is on a temporary address (the fixed port was taken) it
  doesn't check by itself, as it can't tell what you chose. A failed check
  waits an hour, then longer, before trying again. A page opened in an ordinary
  browser never asks.
- **Not on Windows:** Threadbear installing or updating Codex (a `codex.exe` on
  the PATH is used if there is one), runner releases and handovers (there is no
  `current` link or `launch.mjs` supervision), `lsof` and `ps` checks (so a CLI
  stuck in a file call isn't spotted, and idle threads whose quiet background
  shells are stuck aren't nudged), the idle check, the screen-dialog and secret
  checks, docker sandboxes, stopping a crashed CLI's leftover tool commands
  (`taskkill /T` needs the parent alive), BrowserBear and ComputerCub.
