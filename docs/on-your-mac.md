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
- **The same Convex backend, on Windows and Linux** (`scripts/setup-sync.mjs`,
  docs/pairing.md): run by hand from a clone of the repository, never by the
  app or the runner, with `--dry-run` to see the plan first and a "Go ahead?"
  before it does anything. It reads `~/.convex/config.json` only to see whether
  a Convex login is there (it never prints it), reads and merges `sync.url` and
  `sync.name` into `runner.json` (a file it can't read is left alone), and
  writes `secrets/convex-deploy.env` (a deploy key, made by `convex deployment
  token create`), `secrets/convex-key` (the main runner key, also set as
  `RUNNER_KEY` on your deployment) and `secrets/made-deploy-keys` in the data
  folder, with mode 0600 where the system has modes and the profile folder's
  own permissions on Windows (it refuses a data folder outside the profile
  without a yes). In the clone it runs `npm ci` and leaves the `.env.local`
  that `convex dev` writes. It runs the Convex command line (its own
  `node_modules`, logged in through your browser at auth.convex.dev, which the
  command line opens), then `runner/scripts/deploy-backend.mjs`, which unpacks
  the clone's commit with `tar` into a temporary folder, runs `npm ci` there
  and deploys `convex/` and `web/` to your production deployment, taking a
  lock file (`backend.winlock` in the data folder, and for a moment
  `backend.winlock.reclaim` when it takes over one a crash left) on Windows
  while it does. It
  talks to your Convex deployment, api.convex.dev, auth.convex.dev and
  registry.npmjs.org. On Windows it starts npm with `node npm-cli.js` where it
  can, and otherwise `npm.cmd` through `cmd.exe`. At the end it can restart the
  runner (after asking) with `install-windows.mjs --stop` and `--start`, or
  `install-linux.mjs`, but never from inside a Threadbear thread, where it only
  says how (it goes by `THREADBEAR_THREAD_ID` in its environment). On a Mac it
  does nothing and says to use `./threadbear setup`. Self-hosted Convex stays
  Mac-only.
- **Or a self-hosted backend** (`setup --self-hosted`, docs/self-hosting.md;
  Convex cloud is the one we recommend): no Convex login or deploy key.
  Instead two Docker containers, `threadbear-convex` (Convex's open source
  backend) and `threadbear-convex-dashboard`, from pinned
  `ghcr.io/convex/*` images, with the data in the Docker volume
  `threadbear-convex-data`. They listen on this Mac's loopback only
  (ports 13210, 13211 and 16791), and `tailscale serve` puts them on your
  tailnet as `https://<this Mac>.<tailnet>.ts.net` ports 3210 (the API),
  3211 (the website) and 6791 (the dashboard), so nothing is reachable off
  your tailnet. The backend's admin key is in
  `secrets/convex-self-hosted.env`, and setup sets `PUSH_RELAY=off` on it,
  as the push relay only works with Convex cloud. runner.json gets
  `sync.site`, the website's address.
- **Apps:** `~/Applications/Threadbear.app` and
  `~/Applications/Threadbear Runner.app`, both built and signed on your Mac.
  If you turn on the `gpuiApp` experiment and run
  `desktop/scripts/install-app.sh`, also `~/Applications/Threadbear GPUI.app`,
  which keeps its window and panel layout in `desktop-settings.json` and
  `gpui-prefs.json` in the data folder.
- **A LaunchAgent:** `~/Library/LaunchAgents/com.mikerosoft.threadbear.runner.plist`,
  which keeps the runner going while you're logged in. A runner on a Linux
  server (INSTALL.md, section 6) has a systemd user service in its place,
  `~/.config/systemd/user/com.mikerosoft.threadbear.runner.service`, and no
  apps; it converts pictures with ImageMagick and rsvg-convert, and reads
  the account's full name from `getent passwd` rather than `id -F`.
- **A command:** `~/.local/bin/threadbear`.
- **Shells, when you open the Terminal (⌘J):** the app starts your login
  shell (`$SHELL`, else zsh) in a pseudo-terminal, one per thread you open
  it on, in that thread's folder. They're its own child processes: a
  thread's shell stops when the thread is archived or deleted, and all of
  them stop when the app quits (`app/Sources/Threadbear/Views/TerminalPanel.swift`).
- **Files:** the data folder `~/Library/Application Support/Threadbear`
  (threads, settings, `secrets/`, runner releases, the pinned release key
  `upstream-signers`, and `sync-sent.json`, hashes of what's already in your
  Convex mirror so a restart sends only what changed, and
  `shared-pools.json`, the last pools your Convex backend had, which every
  runner shares, so one starts with them while the backend can't be reached,
  and `shortcuts.json`, the keyboard shortcuts you've changed in Settings >
  Keyboard, which the app reads and writes and never sends anywhere,
  `schedule-runs/`, schedule runs your Convex backend hasn't been told
  of yet, a file each, kept only until it has, and
  with the standing instructions experiment on, `instructions.md`, which every
  agent is given, and `instructions.sig`, which says Settings saved it). In `secrets/`, `asked/` holds the answers you
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
  `~/Library/Caches/Threadbear/rich` (pictures of the ```` ```mermaid ```` and
  ```` ```html ```` blocks in replies, and each one's page for the side pane,
  newest 900 files kept). They're drawn on this Mac in web views that load
  nothing from the network: the diagram library, [Pele](https://pele.run/),
  is bundled with the app (`Resources/Rich/pele.js`, MIT), and a block's
  page runs no scripts;
  `~/Library/Logs/threadbear-runner.log` and `threadbear-update.log`;
  `~/Library/Logs/Threadbear/hangs` (the last 10 times the app froze: if its
  main thread is stuck for 4 seconds it runs macOS's `sample` on itself, in
  a sandbox, and notes the main thread's priority, the Mac's load average
  and how long since the last keyboard or mouse input (just how long, never
  what); nothing else ever reads these); and `~/ThreadbearThreads`, the default
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

- **Landing work** (`runner/src/worktrees.ts`): `tb land` keeps an empty
  `threadbear-land.lock` in the repo's common git directory. It runs
  macOS's `lockf` (Linux's `flock`) with a small Node child to hold an OS
  lock from before rebasing until the check and fast-forward finish.
  Another landing waits; exiting, including a crash, releases the lock.
  Beside it, `threadbear-land-times.log` records how long each landing's
  check took (branch, commit, step times, no output), cut back at 1 MiB.
- **The runner** listens on `127.0.0.1:8797` only, and needs a token
  (`runner/src/config.ts`). It starts the official `claude` and `codex`
  CLIs for your threads. Each thread's CLI gets a key of its own in its
  environment (`THREADBEAR_THREAD_KEY`), never the token. When something
  connects, the runner runs `lsof` and `ps` on that one connection to see
  which process it is and whether it's under a thread's CLI
  (`runner/src/peer.ts`, docs/protocol.md "Who's really calling"). On
  Windows it runs `netstat -ano -p tcp` and PowerShell's `Get-CimInstance
  Win32_Process` instead (`runner/src/peer-windows.ts`), about half a second
  for each connection.
- **With the `acpAgents` experiment on** (off by default) it also starts the
  `opencode acp` and Cursor's `agent acp` CLIs for threads on them, runs each
  with `--version` when the runner starts, and runs its own updater
  (`opencode upgrade`, `agent update`) only when you press Update in the app, and each
  live thread on one has a listener on `127.0.0.1` on a port the system picks,
  serving that thread's Threadbear tools, needing a random token made for it.
- **New installs start threads on Auto.** On Auto, Claude runs with its
  safety check approving or blocking each action, and Codex asks before
  edits. An install set up before 9 Nov 2026 keeps starting threads on
  full access (Claude with `bypassPermissions`, Codex with
  `danger-full-access`). `"defaults": { "permissionMode": ... }` in
  `runner.json` (`"full"`, `"auto"` or `"ask"`) sets it, and each thread
  can pick its own. The threads the runner starts by itself (bringing in
  Mike's releases and fixing a failed update to main, both below, and a
  note about this Mac) start on that default too
  (`runner/src/own-threads.ts`); on Ask, or Codex's Auto, what they can't
  do without a yes waits on a card for you.
- **Your phone and browser can drive the Mac.** A paired iPhone or a
  signed-in browser can start threads in any folder, send messages and
  answer approvals, through your Convex deployment (`runner/src/sync.ts`).
  Those threads start on your default mode like any other (full access on
  an older install), and can be switched to full access from there, so
  treat a pairing like a login to the Mac, and so is admin access to your
  Convex deployment.
  Pairings last 90 days unless set otherwise, at most 365
  (`convex/tokens.ts`); Revoke in Settings › Phone & browser ends one.
- **Following your main** (`runner/src/update.ts`, `app/Sources/Threadbear/AppUpdate.swift`):
  the runner and the app watch your local `main`, and look again every 5
  minutes. Within seconds of it changing, they rebuild themselves from it
  and redeploy your backend, so whatever reaches your `main` runs, with no
  signature check; only Mike's release tags are signed (below). Turn it
  off for both with `followMain: false` in `runner.json` (ask any thread
  to; it left Settings on 2 Nov). Around each step of the runner's build
  it reads macOS's sleep count (`pmset -g stats`, which changes nothing),
  so a step that failed while the Mac slept is tried again later (up to
  three times for the same commit) rather than taken as a broken main.
  When the runner can't build your main or deploy your backend, it starts
  a thread by itself, on your default mode with your own Claude or Codex
  login, in the release's checkout (`runner/src/fix-update.ts`). That
  agent reads the output, fixes the cause, lands the fix on your `main`,
  watches the next build and archives itself once it goes through, so you
  only hear about it when it needs you (including a step its mode asks
  you about). A later failure goes to the same thread.
  `followMain: false` turns this off with the rest.
- **Following GitHub on a second machine** (`runner/src/follow-origin.ts`):
  only with `followOrigin: true` in that machine's `runner.json`, which
  nothing sets for you. Every 5 minutes the runner runs `git fetch origin
  main` in its checkout (the only network call it adds, to whatever
  `origin` is), fast-forwards that checkout's `main` when it can, and builds
  and runs `origin/main`, with no signature check. It never resets or
  rewrites anything: a commit made only there stays, and `tb status` says so.
  `tb land` refuses in that repo. If `origin` is Mike's repo rather than
  your own, leave this off.
- **Schedule checks** (`runner/src/schedule-check.ts`, experiment
  `scheduleChecks`, off by default): a schedule's check command runs in
  `/bin/sh` before each run, as you, for at most a minute (or up to five,
  if the schedule says). Each keeps a
  state file (and a note that a held check was told about, `<id>.held`) in `schedule-checks/` in Threadbear's data folder, and
  beside it what the check last printed (`<id>.<hash>.kept.json`, readable
  only by you) until a run carrying it has been sent, and, while a check
  runs, which runner process is running it (`<id>.running.json`).
- **Keeping the Mac awake** (`runner/src/keep-awake.ts`, experiment
  `keepAwake`, off by default): while a thread is working and for 3
  minutes after, the runner runs macOS's `/usr/bin/caffeinate -i -w
  <runner pid>`, which stops idle sleep only (the display still sleeps
  and the screen still locks). While it does, it reads `pmset -g batt`
  every 2 minutes and lets go on battery below 15%.
- **Mike's releases** (`runner/src/upstream.ts`): every 6 hours it lists
  `upstream`'s `release/*` tags, fetches the newest few into a folder of
  their own (`<home>/runner/upstream-fetch`, deleted after each check),
  checks each with `ssh-keygen -Y verify` against the pinned key (the
  signature goes in a temp file under `$TMPDIR` for a moment), fetches
  upstream's `main` with them to check the tag's commit is on it, and
  copies the newest that passes into your checkout, as
  `refs/threadbear/upstream/`. A release's `scripts/release-signers` and
  `scripts/release-keys-revoked` can change the pinned keys
  (`<home>/upstream-signers`, `<home>/upstream-revoked`, and what's waiting
  in `<home>/upstream-keys.json`, changed by one runner at a time under
  `<home>/upstream-keys.lock`): a new key after a week, a revoked one at
  once (`runner/src/release-keys.ts`). It never changes your code by
  itself. Every 5 days, when there's one your copy doesn't have, it starts
  one thread (on your own Claude or Codex login, on your default mode) that
  works out the merge without checking it out (`scripts/merge-preview.sh`,
  in a throwaway repo under `$TMPDIR` it deletes), tells you what it brings
  and asks; it runs nothing from the release (no checks, installs or builds)
  until you say go, then merges, checks and lands
  (`runner/src/bring-in.ts`). A release Mike marks important starts one
  straight away. Settings › General › Updates from Mike, or
  `"releases": { "bringIn": 14 }` (or `"important"`, or `"off"`) in
  `runner.json`, changes it. It keeps what it last did in
  `runner/bring-in.json` in the data folder.
- **CLI updates** (`runner/src/updates/`): every hour it checks for new
  Claude Code and Codex versions and installs them. If you don't point it
  at your own Codex, it installs one into the data folder. It also runs
  any update commands you list under `cliUpdates.extra` in `runner.json`
  (none unless you add them), once a day each, and keeps when each last
  ran in `extra-updates.json` in the data folder.
  `THREADBEAR_CLI_UPDATES=off` stops all of this.
- **Small model calls** (`runner/src/models/`): thread titles, filing
  threads into projects (the librarian, every 5 minutes) and similar jobs
  send short excerpts of your threads to `claude -p` on your own logins.
  When a project's notes pass 12,000 characters, the librarian sends them
  the same way to be rewritten shorter, and keeps the old notes in the
  data folder's `project-notes/` (the last 5 for each project).
  Mike's publishing runner also sends commit messages to Opus through its
  Claude pool when preparing a daily release, to write the plain-language release notes.
  The input includes subjects and bodies of merged commits, including pull requests.
  If that call fails, the signed release still goes out without notes.
- **Housekeeping** (`runner/src/housekeeping.ts`): trims logs, deletes
  week-old copies of pictures pasted into drafts (a sent message keeps its
  own copy) and deleted threads after 30 days in the trash. Archived
  threads keep their pictures unless you set `"archivedMediaDays": <days>`
  in `runner.json`.
- **Moving threads** (the `moveToRunner` experiment, off by default;
  `runner/src/moves.ts`): watches your Convex deployment for threads you've
  moved to or from this machine. One moving away is packed (its folder,
  its Claude transcript, its worktree's git work), sealed to the other
  machine's key, uploaded in pieces and deleted from the deployment once
  it lands; this machine keeps its old copy in `moved/` in the data folder
  for a week. One arriving is unpacked in `moves/` first, and may make a
  worktree for it, write its transcript into a login's Claude folder, and
  `git clone` its repo from `origin` if this machine has no copy.
- **Presence** (`runner/src/presence.ts`): reads how long the keyboard and
  mouse have been idle (`ioreg`), so your phone knows whether you're at
  the Mac.
- **Dialogs on the screen** (`runner/src/mac-screen.ts`): every 2 minutes it
  runs `osascript` to count the windows of macOS's UserNotificationCenter, so
  it can tell you when a dialog has been left waiting. It sees how many, not
  what they say. `THREADBEAR_MAC_SCREEN=off` stops it.
- **Patches** (`.threadbear/patches/`): code from a folder runs only after
  you trust that folder (`runner/src/patch-trust.ts`). A folder's Claude
  Code hooks, other commands, `env` settings and (in Ask and Auto threads)
  permission rules in its `.claude/settings*.json`, its `.mcp.json`
  servers, and hooks in its `.claude/agents`, `skills` and `commands`, are
  held back the same way (`runner/src/claude-trust.ts`): the runner reads
  those files and the scripts they reach to hash them, runs `git ls-files`
  in the folder to find skills in folders under it, and keeps what you
  trusted in the same `patch-trust.json`.
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
- With the `acpAgents` experiment on: whether `~/.opencode/bin/opencode`, an
  `opencode` or `cursor-agent` on your PATH, `~/.local/bin/cursor-agent` and
  `~/.local/bin/agent` exist and where they really lead, and whether
  `~/.cursor/cli-config.json` exists (never opened). OpenCode itself reads
  `~/.config/opencode` and, as it does anywhere, your `~/.claude/skills`; a
  folder's own OpenCode config and plugins are turned off.
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
| Your Convex deployment | yours | Thread titles and status, all message text (each message cut at 8,000 characters), one line per tool call, projects, schedules, your logins' emails and usage, whether you're at the Mac, whether this machine is low on memory or disk, and the pictures you paste into a message, up to 10 MB each, so your own website can show them. Those go up as they are, in your deployment's file storage: unlike text, nothing can scrub a secret out of a picture, so a screenshot of something sensitive goes too. `"sync": { "pastedPictures": false }` in `runner.json` keeps them on this Mac. While someone has the website's Runners view open, this machine's CPU, memory and disk use, its processor model, operating system and time since it started, every 10 seconds; with nobody looking, none of that is sent. Photos you send from the phone, and pictures you send from the Mac app to a thread on another of your Macs, deleted once that Mac has fetched them. Pictures and videos agents put in their replies or pin, at most 10 MB each, for the phone to show. Other images only for threads you share by link. Other tool output and files stay on the Mac, unless you move a thread to another of your machines (the `moveToRunner` experiment): then the whole thread, sealed so only that machine can open it, goes through for as long as the move takes. Text has known secrets taken out first: see below. |
| Convex (the Convex panel) | yours | Only for a thread in a Convex project, when its Convex panel opens: the runner's Convex CLI asks api.convex.dev for the project's deployments and a deploy key, the runner asks the deployment whether a kept key still works (`/api/check_admin_key`), and the panel loads Convex's embedded dashboard (dashboard-embedded.convex.dev) with that key. Sign in to Convex goes to auth.convex.dev. (`runner/src/convex-keys.ts`) |
| Your other Macs, over ssh | yours | Only when you run `tb runner add <name> --ssh <host>` or `tb runner check --ssh <host>` on your first Mac: it reads that Mac's Threadbear `runner.json`, writes its id and the deployment's address there if it hasn't them, writes its new key into that Mac's `secrets/convex-key`, and looks whether that Mac has a deploy key, Convex panel keys or a Convex login (names only, never a key), through your own ssh setup with agent and port forwarding off (`runner/src/runner-keys.ts`). `tb runner audit` asks this Mac's runner for its threads' last seqs and your deployment for what the main key made. `tb runner rotate-owner` sets env vars on your deployment with your deploy key, and, if you give it a Convex team access token for that run (`CONVEX_TEAM_TOKEN`, never kept), asks api.convex.dev for the deployment's deploy keys (their names and dates) before it rotates. |
| GitHub | Mike's repo | Release tags fetched every 6 hours; the fork at setup |
| GitHub (the Windows app) | the fork's | Only the installed Windows app (see "On Windows"): `api.github.com/repos/<the fork>/releases/latest` once a day (the recent releases, `.../releases?per_page=10`, for a copy that is itself a pre-release, since "latest" never includes one), to say in its rail when a newer release is out. A plain request: GitHub sees the PC's address and the app's user agent, and nothing else is sent. Settings, "This app", turns it off. |
| downloads.claude.ai, registry.npmjs.org | Anthropic, npm | CLI version checks and installs; `npm ci` |
| registry.npmjs.org (the Windows runner) | npm | Only a Windows install, on the runner's first start after it is installed or updated: the one tarball of the Claude Agent SDK (about 4 MB) that `runner/package-lock.json` names, checked against the hash in that file before it is unpacked (see "On Windows"). A plain request: npm sees the PC's address. Nothing else is sent. |
| Anthropic, OpenAI | yours | Your threads, through the official CLIs on your own logins. With the `cardReviewer` experiment on (off by default), an approval card in a thread on Auto, with the thread's first and latest messages, goes to Opus through the same CLI so it can decide in your place. With the `labReview` experiment on (off by default), a thread's code change, with your message and the agent's reply, goes to your other provider's CLI as a review thread, as if you'd started one. After a turn fails because the API couldn't be reached, the runner itself opens (and straight away closes) a connection to api.anthropic.com or chatgpt.com on port 443, at most once a minute, until one opens and the thread carries on. Nothing is sent over it (`runner/src/net-probe.ts`). |
| OpenCode's Zen (opencode.ai), models.dev, and whichever providers you've logged it into | theirs | Only with the `acpAgents` experiment on and a thread on OpenCode: that thread's prompts and tool output, through the official CLI, and small jobs' text when a pool of only OpenCode logins is picked for them in Settings |
| Cursor (api2.cursor.sh) | theirs | Only with the `acpAgents` experiment on and a thread on Cursor: the same, on your own login |
| Mike's push relay | Mike's | Only when a paired iPhone or Android phone gets a notification (an Android phone's goes on to Google's Firebase Cloud Messaging, from the relay). It's sent from your Convex deployment, not the Mac. The text is encrypted for the phone; the relay sees the device token and thread id (`convex/push.ts`, `docs/push-relay.md`). The first time, your deployment registers with it, giving its own address; the relay keeps that address and checks it by posting a one-time code back to your deployment's `/relay/verify` (`convex/http.ts`). |
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

The Browser panel also uses that private socket to list the pages agents
associate with threads, ask for a small still of each and bring a page's real
window to the front (`app/Sources/Threadbear/Views/AgentBrowserPanel.swift`).
Threadbear does not read Chrome's cookie database or copy credentials, and
stills stay on this Mac, in memory, not sent to Convex. BrowserBear stores
thread/tab/profile associations in `panel-tabs.json` in its own folder (0600).

The agents' own browser (`browserbear ... --profile agent`) is Helium where it's
installed, else Google Chrome, with its own profile folder; the panel reads
`agent/tabs.json` in BrowserBear's folder for its pages. Any program on this Mac
could reach its local debugging port, so it holds only what you sign it in to.

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
- **The desktop app** (`desktop-tauri/src-tauri/`, a Tauri shell) opens a window and
  a tray icon (closing the window keeps it in the tray; Quit in the tray menu
  ends it), keeps one copy running, and remembers the window's place (under
  `%APPDATA%\dev.threadbear.desktop`; the page's own storage is under
  `%LOCALAPPDATA%\dev.threadbear.desktop`, both Tauri's standard places). It
  starts `node desktop/bridge/bridge.ts` on a loopback port and stops it on
  quitting; if the app is killed, the bridge notices and exits by itself. The
  page it shows may pick a folder, show a toast and open an `http`, `https` or
  `mailto` link in your browser, and nothing else (`capabilities/default.json`).
- **The desktop bridge** (`desktop-tauri/bridge/bridge.ts`) listens on `127.0.0.1`
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
- **The Terminal** (Ctrl+J, under the thread; `desktop-tauri/bridge/terminal.ts` and
  `shells.ts`): the bridge starts a shell of yours in a pseudo-terminal (ConPTY
  on Windows), one per thread you open it on, in that thread's folder, and only
  when you ask for one (Ctrl+J, or Start a shell); looking at threads starts
  nothing. The shells are the bridge's own child processes. A thread's shell
  stops when the thread is archived or deleted, End shell stops one, and all of
  them stop when the app quits (a shell that outlives a page reload is kept by
  the bridge, which is why the window can be reloaded without losing it).
  To list the shells it looks for `pwsh.exe` on the PATH and in `Program Files\PowerShell\7`,
  `powershell.exe` and `cmd.exe` in `System32`, Git for Windows' `bash.exe` as the
  runner does, and, if `System32\wsl.exe` is there, runs `wsl.exe -l -q` to
  list the Linux distributions (a distribution's shell is `wsl.exe -d <name>
  --cd <folder>`). On Linux it reads `$SHELL` and `/etc/shells`. The window can
  only ask for a shell from that list, by its id; it never names a program. The
  choice of default is kept in the page's local storage (Settings, "This app",
  or the menu in the Terminal). On Windows the bridge also reads the font
  Windows Terminal is set to (`desktop-tauri/bridge/windows-terminal-font.ts`),
  so a prompt theme's symbols draw in the Nerd Font you chose there. It does
  this when the Terminal panel opens and when you pick "Same as Windows
  Terminal", not at start-up. It tries Windows Terminal's `settings.json` in
  `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState`,
  then the same under `Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe`, then
  `%LOCALAPPDATA%\Microsoft\Windows Terminal`, and uses the first that is
  there and reads as settings. A file that is missing, can't be read, is over
  2 MB or is not JSON is passed over. From the one it uses it takes the default
  profile's font names (a list, up to six) and size, nothing else. Only those
  names (letters, digits, spaces, hyphens, dots, underscores, brackets, plus
  signs and ampersands, up to 100 characters each) and the size go to the
  window, which uses them to choose the fonts to draw with. The file's text is
  not kept, logged or sent anywhere, and nothing is written to it. The font
  choice (Same as Windows Terminal, Default, or a name you type) is kept in the
  page's local storage as `threadbear.terminalFont`. A shell is given the
  bridge's environment less `THREADBEAR_BRIDGE_KEY` and any thread id, plus
  `TERM`, `COLORTERM` and `TERM_PROGRAM=Threadbear`. It runs what you type, as
  you, with no sandbox, the same as any terminal. Its socket (`/terminal` on the
  bridge) takes the same key and origin checks as the runner's, so another
  program on the PC without the launch key can't open one. Nothing is sent
  anywhere. The pseudo-terminal comes from `@lydell/node-pty` (MIT), a package
  of prebuilt binaries for the platform (nothing is compiled), which on Windows
  includes Microsoft's `conpty.dll` and `OpenConsole.exe` (MIT).
- **Installers** (`installer/`, built by `.github/workflows/installers.yml`
  from `release.yml`): a setup exe (Inno Setup), an MSI (WiX) and a zip, for
  x64 and arm64. They put the app in `%LOCALAPPDATA%\Programs\Threadbear` (or
  Program Files for a system-wide install): `Threadbear.exe`, a pinned
  `node\node.exe` (its SHA-256 is checked at build time, `installer/node.json`),
  the runner's source and its production packages (not the Claude Agent SDK:
  see the next item), the bridge and built UI (with `ws` and the Terminal's
  `@lydell/node-pty` in `desktop-tauri\node_modules`), the
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
  Windows, and sets that task up (the item above) if you say yes. On "No
  thanks" it asks a second question: whether to start the runner only while
  Threadbear is open. Yes makes the same task with no logon trigger
  (`install-windows.mjs --on-demand`), so nothing starts it at sign-in; the app
  starts it when it opens and stops it (`--stop`) when it quits, and
  `--mode` tells the app which kind it is (`sign-in`, `on-demand` or `none`).
  A second "No thanks" is remembered in
  `%LOCALAPPDATA%\Threadbear\declined-runner-task`. The tray menu's "Start the
  runner at sign-in..." and "Start the runner only while Threadbear is open..."
  ask again and switch from one kind to the other, and the connection banner's
  "Start the runner" button starts a set-up runner or, with none, shows the two
  ways to set one up in the window itself (it asks the shell `runner_setup`,
  then `start_runner` with `start`, `on-demand` or `sign-in`, and the shell
  maps each to one fixed option of the same script). When the shell says it
  started the runner, or that it was already running, the window tries to
  connect at once and then every half second for about 20 seconds, with
  "Waiting for the runner to answer..." where the button was; if the runner has
  not answered by then it says so and points at `shell.log`, and goes on
  trying at the usual slower pace. What the shell does about the runner is
  noted, one line each with the time in seconds since 1970, in
  `%LOCALAPPDATA%\Threadbear\shell.log` (`~/.local/state/Threadbear/shell.log`
  on Linux; it starts over past 200 KB and keeps the old one as
  `shell.log.old`), with no text from the window.
  Each time the app opens with the task registered it runs `--runner --start`,
  so the runner comes back after an update. `Threadbear.exe --runner
  [--installed | --start | --stop | --status | --uninstall | --dry-run |
  --on-demand | --mode]` runs the same script from a terminal or an installer
  (its answer prints to the terminal that started it; an unknown flag is
  refused).
- **Exit on close** (Settings, This app): off by default, so closing the window
  leaves the app in the tray. On, closing it ends the app. The choice is the
  file `%LOCALAPPDATA%\Threadbear\exit-on-close`, which is there when it is on
  (the shell reads it when the window is closed). On Linux there is no box:
  closing the window always ends the app there, since making a tray indicator
  does not mean the desktop shows it, and a runner set up to run only while the
  app is open stops with it.
- **The update check** (`desktop-tauri/src/core/updates.ts`): the installed app asks
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
- **Held back on Windows:** two checks rest on file owners and permission bits,
  which Windows doesn't have in that form, so they say no instead of guessing.
  A live patch command or a Claude Code hook that runs a script *outside* the
  repo is refused (`ownedPathProblem` in `shell-allowlist.ts`; scripts in the
  repo are hashed and fine), and Codex's "Always allow" is never offered for a
  command (`ruleMayCover` in `adapters/codex/approvals.ts`), so it asks each
  time. The standing instructions file is not read through a link (Windows has
  no `O_NOFOLLOW`, so `instructions.ts` looks for one by name).
- **Which thread a command comes from, on Windows:** the runner works it out from
  the connection (netstat) and the process's parents (PowerShell), so `tb` run
  with its key wiped, or with the owner's token, from a thread's shell is still
  that thread's and is limited as it is. A process the parents cannot reach
  (one a shell left behind with its parent gone) is the owner's, as on a Mac,
  where a process group can still name it and Windows has none. The check that
  keeps a thread's tools from reading the runner's secrets looks at the
  command's words, as it does on a Mac, with the Windows spellings of the data
  folder added (`$env:THREADBEAR_HOME`, `%THREADBEAR_HOME%`, other case, a UNC
  share of the drive, the short 8.3 names); a shell can still spell a path in
  a way no pattern sees, which SECURITY.md says of the Mac too.
- **Not on Windows:** Threadbear installing or updating Codex (a `codex.exe` on
  the PATH is used if there is one), runner releases and handovers (there is no
  `current` link or `launch.mjs` supervision), `lsof` and `ps` checks for a
  stuck CLI (so a CLI
  stuck in a file call isn't spotted, and idle threads whose quiet background
  shells are stuck aren't nudged), the idle check, the screen-dialog and secret
  checks, docker sandboxes, stopping a crashed CLI's leftover tool commands
  (`taskkill /T` needs the parent alive), BrowserBear and ComputerCub.

## On Linux (the desktop app)

The Linux desktop app (docs/linux.md) is a `.tar.gz` that is unpacked anywhere; it
puts nothing outside that folder until you let it. What it adds, and when:

- **Always:** the runner's data folder `~/Library/Application Support/Threadbear`
  and log `~/Library/Logs/threadbear-runner.log`, as a runner on Linux has (the
  folders keep their macOS names), and the app's window state in the folder the
  window plugin keeps it in.
- **When you let the app set the runner up** (the first time it opens, the tray
  menu, or `threadbear-desktop --runner`; `--dry-run` says first):
  `~/.config/systemd/user/threadbear-runner.service` (started at login, run with
  `systemctl --user enable --now`), and `~/.local/bin/tb`, a two-line script. A
  `tb` of yours that this didn't write is left alone. `--uninstall` removes both.
  A "no thanks" is a marker file, `$XDG_STATE_HOME/Threadbear/declined-runner-task`
  (else `~/.local/state/...`).
- **When you run `install.sh`:** `~/.local/share/applications/threadbear.desktop`,
  pointing at the unpacked folder. `install.sh --uninstall` removes it.
- **If you install the `.deb` instead of unpacking the tarball:** `apt` puts
  the same folder in `/opt/threadbear`, a `threadbear-desktop` link in
  `/usr/bin`, `/usr/share/applications/threadbear.desktop`, an icon in
  `/usr/share/icons/hicolor/256x256/apps`, and a copyright file in
  `/usr/share/doc/threadbear`. It has no install scripts and starts nothing.
  Removing it takes those away and leaves the per-user things above.
- **On the runner's first start:** the Claude Agent SDK from `registry.npmjs.org`
  into `~/.cache/threadbear/sdk`, checked against the hash in
  `runner/package-lock.json` (it is Anthropic's, so the package doesn't carry it).
- **What it runs:** the package's own Node (`node/bin/node`, checked against its
  SHA-256 when the package is built), the runner, your own `claude`, `git`,
  `bash`, `systemctl --user`, and `xdg-open` (through the opener plugin) for a
  web link. Nothing is started as root and nothing is written outside your home.
