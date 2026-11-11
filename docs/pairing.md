# Pairing a phone or a browser, on Windows and Linux

Threadbear's phone apps and its website don't talk to your computer. They read
a copy of your threads that the runner keeps in a Convex deployment of your own,
and send their commands through it (docs/convex-backend.md). So pairing needs
that deployment to exist, and on Windows and Linux a script makes it:
`scripts/setup-sync.mjs`. Until it has run, Settings > Phone & browser has its
"Show a code" button greyed, with the note "Pairing needs the sync backend, and
it's off: no sync.url in runner.json".

On a Mac, `./threadbear setup` does the same job and also builds the runner and
the Mac app (docs/setup-and-updates.md, section 2.2). Use that there.

A second computer, a work PC say, doesn't make a backend of its own. It joins the
one the first computer made, with `scripts/setup-sync.mjs --join`, and its threads
show up beside the first computer's. See "Joining from a second computer", below.

This is Convex cloud only. A self-hosted Convex backend (docs/self-hosting.md)
is Mac-only for now, and the script stops if it finds that this computer has one.

## What you need

- **A Convex account.** Sign up at https://convex.dev. The script opens your
  browser for you to approve the login, once. A free account is enough to start
  with (see "What it costs").
- **Node 24 or newer, and git.** The app brings its own Node, but the script runs
  with the one on your PATH. `node --version` should say 24 or more.
- **A clone of the repository**, not the installed app and not a Download ZIP:
  the script lives in the repository, and the backend is deployed from the clone's
  commit. Clone the repository this copy of Threadbear comes from
  (`git clone https://github.com/platima/threadbear.git` is this fork's address; if
  you forked it again, use your own fork's), then work from that folder. Folders
  with spaces or brackets in their names are fine.
- **Threadbear installed, and opened once**, so it has a data folder
  (`%APPDATA%\Threadbear` on Windows, `~/Library/Application Support/Threadbear`
  on Linux). The script makes the folder if it isn't there, but the runner you
  want to pair is the one that uses it.

That is for the computer that makes the backend. A computer that joins one
another computer made needs a good deal less: Node 24 or newer, the repository's
files (a Download ZIP will do) and a key file from the first computer. It needs no
Convex account, no git and no clone, and "Joining from a second computer" says how.

## Running it

From the clone, in a terminal:

    node scripts/setup-sync.mjs --dry-run
    node scripts/setup-sync.mjs

The first only prints what it would do, and changes nothing. The second shows
the same list, asks "Go ahead?", and does it. Running it again is safe: every
step looks at what is already there first and only does what is missing, so a
run that stopped halfway (no network, a closed browser) carries on where it
stopped.

| Option | What it does |
|---|---|
| `--dry-run` | say what it would do, and change nothing |
| `--yes`, `-y` | don't ask: go ahead, use the only Convex team, restart the runner (never from inside a Threadbear thread, see step 8) |
| `--team SLUG` | the Convex team for the project (otherwise the only one, or you choose) |
| `--project NAME` | the project's name (default `threadbear`) |
| `--region REGION` | the Convex region (default: the one nearest this computer's time zone) |
| `--name NAME` | what the phone calls this computer (default: its host name) |
| `--home DIR` | the runner's data folder, if it isn't the usual one. The installed runner is restarted only when this is the folder it uses |
| `--no-restart` | don't restart the runner; say how to |
| `--join` | for a second computer: use the backend the first computer made, instead of making one (see "Joining from a second computer") |
| `--url ADDRESS` | with `--join`: the first computer's `sync.url`, like `https://calm-fox-123.convex.cloud`. Not needed when runner.json already has it |
| `--key-file FILE` | with `--join`: the file that `tb runner add --out` wrote on the first computer |
| `--id RUNNERID` | with `--join`: the runner id the key was made for. Accepted only when runner.json has no `sync.runnerId` yet, or has this same one |
| `--delete-key-file` | with `--join`: delete the key file once the key in `secrets\convex-key` reads back the same |

`--team`, `--project` and `--region` don't go with `--join`, since a joining computer
makes no project and no deployment, and `--url`, `--key-file`, `--id` and
`--delete-key-file` need `--join`. Either mistake is a usage error (exit code 2),
said before anything is looked at. `--dry-run`, `--yes`, `--name`, `--home` and
`--no-restart` work with `--join` as they do without it.

The steps, in order:

1. **This computer.** Node, git, npm and tar are there, the folder is a git clone
   with the `convex/` and `web/` folders, and the data folder exists. It says
   plainly what is missing. On a Mac it says to use `./threadbear setup` instead.
2. **Packages.** `npm ci` in the clone, for the Convex command line.
3. **Convex login.** Opens your browser, and you approve it there. Skipped if this
   computer is already logged in to Convex. If Convex says the saved login is no
   good, it logs in again. If Convex can't be reached at all (no network), it stops
   and leaves the saved login alone, since the login may be fine.
4. **A Convex project** of your own with a production deployment. If you have more
   than one Convex team it asks which (or give `--team`). If the clone already
   points at a project (a `.env.local` from an earlier try), that one is used, and
   if runner.json already names a deployment, no second one is made. A deploy key
   already in the data folder (from a run that stopped part way) belongs to one
   deployment: that one is found from the name in the key and used, and if it
   can't be found the script stops and says what to put in runner.json, rather than
   make another one that the key would not match.
5. **Keys.** A deploy key for the runner's backend deploys, and the main runner
   key, set as `RUNNER_KEY` on the deployment. If the deployment already has a
   `RUNNER_KEY` it wins: it is copied here, and never replaced on the deployment.
   That includes a key already in `secrets\convex-key`. The script reads the
   deployment's `RUNNER_KEY` (a read, which a dry run does too) before it says what
   it will do, so replacing the key in the file, or setting it on a deployment that
   has none, is in the list it asks about and needs a yes (or `--yes`) like any
   other change.
6. **runner.json.** `sync.url` and `sync.name` are merged in. Everything else in the
   file is left as it was. A runner.json that is there but can't be read (a stray
   comma, an empty file, a byte order mark from Notepad) stops the script with
   words, and it is not touched.
7. **Backend and website.** `runner/scripts/deploy-backend.mjs` deploys `convex/`
   and `web/` from the clone's commit to your deployment, a few minutes the first
   time.
8. **Restart the runner**, so it reads the new runner.json. If the app set the
   runner up as a Task Scheduler task (Windows) or a systemd user service (Linux)
   the script can do it, after asking, with `--stop` and then `--start` of
   `runner/scripts/install-windows.mjs` or `install-linux.mjs`. Anything a thread
   is doing at that moment is cut short. To let working threads finish first,
   answer no (or pass `--no-restart`) and restart it from the app's Runners page,
   which waits until no thread is busy. The installed task
   or service runs with the standard data folder, so it is restarted only when
   `--home` (or `THREADBEAR_HOME`) is that folder. With another folder the script
   leaves it alone, since ending it would change nothing for the runner that uses
   the folder you named, and says to restart that runner yourself.

   Run from inside a Threadbear thread (an agent running it for you, say), the
   script never restarts the runner: stopping it from there would end the thread's
   turn, and every other thread's work with it. It says so, and gives the Runners
   page and the two commands to run from a terminal outside any thread.
9. **Where to pair.** Open Threadbear, Settings > Phone & browser.

## Joining from a second computer

A second computer can use the backend the first one made, instead of making
another. Its threads then go to the same backend, beside the first computer's.
`node scripts/setup-sync.mjs --join` does it, in two runs of the same command,
with one command on the first computer between them.

The joining computer is given a runner key: a key for its own runner id and
nothing else. The runner uses it to write this computer's threads to the backend.
It can't make pairing codes, read the first computer's threads or deploy
anything, and it can be revoked on its own from the first computer. The computer
gets no Convex login, deploy key or project, and the script runs no Convex
command line, `npm`, `git` or `tar`.

**What you need**

- *On the joining computer:* Node 24 or newer (`node --version`) and the
  repository's files. A `git clone` or a Download ZIP will do: the script needs only
  `scripts\setup-sync.mjs`, `scripts\runner-key-plan.mjs` and `runner\src\`, plus
  `runner\scripts\install-windows.mjs` (or `install-linux.mjs`) to restart the
  runner. There is no Convex account, git, `npm ci` or clone to arrange. Threadbear installed and opened once is best, so its runner has
  made the id this computer goes by; if it hasn't, part one makes one.
- If `node` there isn't 24 or newer, the app's own Node will run the script. It is
  in the folder the app is installed in (`%LOCALAPPDATA%\Programs\Threadbear` by
  default):

      & "$env:LOCALAPPDATA\Programs\Threadbear\node\node.exe" scripts\setup-sync.mjs --join --url https://calm-fox-123.convex.cloud

- *On the first computer:* a backend made by this script (or by `./threadbear
  setup` on a Mac), and its runner started at least once, so it has an id of its
  own. It uses `tb`. On Windows that is `tb.cmd` in `%LOCALAPPDATA%\Threadbear\bin`,
  which the app puts there when it sets up the runner's Task Scheduler task, so it
  isn't there if you said no to that. In that case give the same arguments to the
  app's Node, as
  `& "$env:LOCALAPPDATA\Programs\Threadbear\node\node.exe" "$env:LOCALAPPDATA\Programs\Threadbear\runner\bin\tb" runner add ...`
  (using the install folder again).
- A way to carry a small file from one to the other. A USB stick is the usual way.
  Not email or chat: the file holds the key.

The commands below are for Windows. On Linux use `scripts/setup-sync.mjs` and a
path like `/media/usb/work-pc.key`, which is how part one writes its example there.

**1. The first computer's address.** It is `sync.url` in that computer's
runner.json, and it isn't secret. On Windows:

    (Get-Content "$env:APPDATA\Threadbear\runner.json" | ConvertFrom-Json).sync.url

On Linux and on a Mac the file is `~/Library/Application Support/Threadbear/runner.json`.
The address is also on the deployment's page in the Convex dashboard.

**2. Part one, on the joining computer.** From the folder with the repository's
files:

    node scripts\setup-sync.mjs --join --url https://calm-fox-123.convex.cloud --name "Work PC" --dry-run
    node scripts\setup-sync.mjs --join --url https://calm-fox-123.convex.cloud --name "Work PC"

`--name` is what the phone and the first computer call this computer (the name
runner.json already has, else its host name, if you leave it out). The first command says what the second would do and
changes nothing. The second shows the same list, asks "Go ahead?", and records
`sync.url`, `sync.runnerId` and `sync.name` in runner.json. The id is the one
runner.json already has (the runner makes one when it first starts) or, if there
is none, a new one. An id that is there is never changed, and a dry run with none
doesn't invent one: it says the id is chosen when it's run for real.

Part one doesn't restart the runner, as it has no key to use yet. It ends by
printing the command to run on the first computer, with this computer's id in it,
and "Part one done. This computer is waiting for its key". Run again, it changes
nothing and prints the same command.

**3. On the first computer.** In a terminal of your own, not one an agent is
working in, run the command part one printed. It looks like this:

    tb runner add "Work PC" --out E:\work-pc.key --id 3f9a1c0b7d2e

`E:` stands for the USB stick, so use the path of yours. Keep the file off a
Desktop or Documents folder that OneDrive backs up, and out of a Dropbox or shared
folder. The key goes into the file and is never printed. A runner has one live key,
so making another for the same id revokes the one before. If it says the runner is
already on the deployment, that computer has used this backend before (with the
main key, say). If it really is that computer, run the same command again with
`--replace` added.

**4. Part two, on the joining computer.** Carry the file across and run the same
command again, with `--key-file`:

    node scripts\setup-sync.mjs --join --url https://calm-fox-123.convex.cloud --key-file E:\work-pc.key

It reads the file, asks the backend whether the key is live and is this
computer's, and only if it is: saves the key in `secrets\convex-key`, brings
runner.json up to date, and offers to restart the runner (step 8 above has the
details). Then it says what this computer can and can't do. `--dry-run` goes as
far as asking the backend, which is a read, and lists the rest without doing it.

The key file stays where it is unless you add `--delete-key-file`, which deletes it
once the key reads back the same from `secrets\convex-key`. On a USB stick that is
not a secure erase. Without the flag the script says the file is a second copy of
the key: delete it yourself, and send it nowhere.

**5. On the first computer again.** `tb runner list` has a line starting `live`
with the new key's id and the name you gave it. The joined computer's threads show
on the phones and in the website paired with the first computer once the joined
runner has restarted onto the key.

Running either part again is safe. Part two again, with the file or without it,
finds the key in place and changes nothing (if the file is gone it says so and
uses the key it has). A different runner key in the file, which the first computer
makes with `--replace` when the old one is lost or revoked, replaces the old one,
after a yes.

**The steps, for a join.** They keep their numbers so what the script prints lines
up with the list above. Step 1 checks Node and the data folder and looks for what
it must refuse (below). Steps 2 (packages), 3 (Convex login) and 7 (backend and
website) are skipped, each with a line saying why. Step 4 is only the backend's
address, which it looks at to see that it answers (a GET of `/version`). Step 5 is
the runner key: in part one "no runner key yet", in part two the check and then the
save. Step 6 is the runner.json merge, with the runner id in it as well. Step 8
restarts the runner as for the first computer, except in part one. Step 9 says what
to do next.

**What a join refuses.** Each of these stops it with nothing changed:

- *A computer with admin power over the backend.* It looks for the five things
  `tb runner check` looks for: `secrets\convex-deploy.env` (setup's deploy key),
  `secrets\convex-self-hosted.env`, `secrets\convex-team-token`, a Convex panel's
  deploy key in `secrets\convex-panels\`, and a Convex command line login
  (`~\.convex\config.json`). Any of them can do anything to the backend, so a runner
  key beside them keeps nothing out. The message lists what is there and the order
  to deal with it: revoke them on Convex's side, remove the files (and `npx convex
  logout`), then rotate the main key on the first computer (`tb runner
  rotate-owner`), since they could have read it. There is no option to carry on
  regardless.
  A work PC with a Convex login for other projects is refused too, until that login
  is gone.
- *A `secrets\convex-key` that holds anything but a runner key.* That is the first
  computer's main key, or a copy of it, and a join never replaces it.
- *A key file that isn't a runner key.* It must be a regular file of at most 1 KiB,
  outside the repository's folder (git could pick it up there), holding `tbr_` and
  64 digits and letters a to f. A main key or a deploy key in it is refused with a
  note to delete that copy. What is in the file is never printed. A byte order mark,
  and the UTF-16 that Windows PowerShell 5.1's `>` writes, are both understood.
- *An address that isn't a Convex cloud one*, like `https://calm-fox-123.convex.cloud`
  or `https://calm-fox-123.ap-southeast-2.convex.cloud`, with nothing after the
  name. A self-hosted backend can't be joined from here yet. An address that
  differs from the `sync.url` runner.json already has is refused too: what this
  computer has already sent stays at the old one, so take that line out of
  runner.json yourself if you do mean to move.
- *A runner.json that can't be read*, or has `"sync": { "enabled": false }`, and an
  `--id` that isn't the one it already has.

**The check with the backend.** Part two calls `sync:messageHeads` on the
deployment, as this computer's runner id and with the key (a POST to the address's
`/api/query`). It only reads, and what it returns is thread ids and sequence
numbers. If the backend turns the key down as bad, the key was replaced or revoked,
or this isn't the backend that made it, and the message gives the `tb runner add`
line to run again on the first computer, with `--replace` on the end. If it says the
key is for a different runner, the key was made for another id. Neither writes
anything. A
backend too old to have the function can't check the key: the script says so and
carries on, and the runner says if it turns the key down later. A network failure
or a reply that isn't Convex's stops it with nothing written.

**A work network that inspects HTTPS traffic.** Node keeps its own list of
certificate authorities and doesn't use Windows's unless asked. If one of the
script's requests fails with a certificate error, it says so and suggests setting
`NODE_USE_SYSTEM_CA=1` in that terminal (Node 24.6 or newer; the app's own Node
is newer than that) and running it again. In PowerShell that is
`$env:NODE_USE_SYSTEM_CA = "1"`, and in Command Prompt `set NODE_USE_SYSTEM_CA=1`.
That helps the script. Whether the runner, started by Task Scheduler, picks the
variable up, and whether its live connection to Convex gets through such a proxy,
has not been tried.

**What a joined computer can do.** It writes its own threads to the backend, and
they show up on the phones and in the website paired with the first computer, under
the name it joined as. It can't make pairing codes or sign a browser in, read the first
computer's threads, or deploy. Its own app doesn't list the first computer's
threads either. Phones and browsers are paired on the first computer only. On the
joined computer, Settings > Phone & browser can't list what is paired or make a
code, as both need the first computer's key and the backend refuses them. That page
has not been tried on a joined computer, and it has no gentler words for it yet.
`tb runner check` on the joined computer says if a deploy key or a Convex login
turns up there later.

**What hasn't been proved.**

- The whole flow, the first computer's setup included, has not been run against a
  real Convex account yet. The tests use a stand-in backend that answers the key
  check the way `convex/lib.ts` is written to. What a real Convex backend says to a
  refused key is inferred from how the runner itself calls the backend.
- `tb runner add --out` is covered by tests, and one of them checks that the file it
  writes is one the script accepts, but it has not been run on a real Windows PC.
- The restart at the end runs `install-windows.mjs --stop` and `--start` from the
  folder the script is in, as it does for the first computer. The tests use
  stand-ins for Task Scheduler, not the real one.

## Pairing

In the app's Settings > Phone & browser:

- **Phone, "Show a code".** A QR code. On the iPhone, open the Threadbear app
  from the App Store and scan it. On Android, install the app from the release
  (docs/android.md) and use "Scan the code" on its first screen, or point the
  camera at the code. The code holds a sign-in for the phone, so don't share a
  picture of it. It is shown once and not kept.
- **Browser, "Make a link".** A sign-in link for your website, which is at
  `https://<your deployment>.convex.site`. Open it in the browser you mean to use.

The list below them shows what is paired, with Sign out for each.

This is done on the computer that made the backend. A computer that joined it with
`--join` has a key that can't make a code or a link, or list what is paired, so
pair from the first computer. The joined computer's threads are on those phones and
browsers all the same.

A phone's notifications with the app closed need more than the pairing: the push
relay (see "Privacy") and, on Android, a release of the app built with a Firebase
project (docs/android.md says how).

## What it creates

**In your Convex account** (visible in the Convex dashboard):

- a project called `threadbear` (or `--project`), with the dev deployment Convex
  makes for every project
- a production deployment in it, in the region nearest this computer's time zone
  (Convex's own default, in the US, where the script can't tell)
- a deploy key named `threadbear-runner-<this computer's name>` for that
  deployment
- one environment variable on the production deployment, `RUNNER_KEY`
- the backend's functions and the website's files, deployed to the production
  deployment (Convex serves the website from the deployment's `.convex.site`
  address)

**On this computer:**

| Where | What |
|---|---|
| the data folder's `secrets\convex-deploy.env` | the deploy key. It can do anything to the deployment, and is used only for deploying the backend |
| `secrets\convex-key` | the main runner key, the same value as `RUNNER_KEY`. The runner uses it to write to the deployment and to make pairing codes |
| `secrets\made-deploy-keys` | the name of the deploy key above, so `tb runner rotate-owner` knows it is this computer's |
| `runner.json` | `sync.url` (the deployment's address) and `sync.name`, merged in |
| `backend.json` | what the backend deploy last deployed (so the next run can skip it) |
| `backend.winlock` | while a deploy is running, on Windows only (and `backend.winlock.reclaim` for a moment, when it takes over a lock a crash left) |
| `~\.convex\config.json` | the Convex command line's login. It is Convex's own file, written by `convex login`, not this script |
| the clone: `node_modules\` and `.env.local` | the packages, and the project the clone is linked to (the second is ignored by git) |

The secrets are written for their owner alone where the system has file modes
(Linux). Windows has none: a file in your profile folder already belongs to you,
and the data folder is in it by default. If you put the data folder somewhere
else on Windows, the script says that other people of the PC may be able to read
it, and won't go on without a yes. Neither key is ever printed, and neither
should be pasted into a thread or sent anywhere.

It also runs `npm ci` in a temporary folder while deploying, which it removes,
and it talks to `convex.dev`, `api.convex.dev`, `*.convex.cloud` and
`registry.npmjs.org` (docs/on-your-mac.md has the whole list for Threadbear).

**For a computer that joins** (`--join`), on that computer:

| Where | What |
|---|---|
| `secrets\convex-key` | the runner key, a `tbr_` key for this computer's runner id and nothing else. It is written to a temporary file in the same folder and then renamed, so the runner never reads half of it. The runner uses it to write this computer's threads to the backend |
| `runner.json` | `sync.url`, `sync.runnerId` and `sync.name`, merged in. Everything else in the file stays |
| the key file | read, and left alone, unless you pass `--delete-key-file`, which deletes it once the key reads back the same from `secrets\convex-key` |

Nothing else: no `secrets\convex-deploy.env`, no `made-deploy-keys`, no
`backend.json`, no `~\.convex`, no `node_modules\` or `.env.local`. A joining
computer makes nothing in Convex. On the first computer, `tb runner add` adds the key
to the backend, which keeps only a hash of it. The same remarks about file
permissions apply as above, and the key is never printed.

The script talks to the backend's own address and nowhere else: a GET of `/version`
to see that it answers, and a POST to `/api/query` that checks the key (a read, with
the key in the body and never in the address). A real run makes each twice, once for
the list it asks about and once when it runs.

## What it costs

Convex has a free plan, and a fresh deployment starts on it. A typical use, one
computer with a few threads a day, fits in it with room to spare (docs/convex-backend.md,
"A typical user"). The limits are hard on the free plan: past them, writes to
the deployment can fail, and the mirror stops until the month rolls over or you
move to a paid plan. A computer used very heavily (hundreds of threads) can pass
the database read limit; docs/convex-backend.md measured it. The current limits and
prices are on https://convex.dev/pricing. Threadbear itself charges nothing and
has no server of its own for this.

## Privacy

The deployment is in your own Convex account, and Convex hosts it: what the runner
stores there sits on Convex's servers, under Convex's terms. You, the people you
add to that Convex team, and the phones and browsers you pair can read it. A
paired phone or browser reads the same data the runner stores, until you sign it
out. Threadbear's maintainers see none of it, apart from what the push relay is
sent (below). What the runner stores there is listed under "Who it talks to" in
docs/on-your-mac.md: thread titles and status, the text of messages (each cut at
8,000 characters, with the shapes of keys and tokens taken out first, which is a
best effort and not a guarantee), one line per tool call, project names, and the
pictures you paste into a message. Tool output and diffs stay on the computer
unless you turn on full sync (docs/full-convex.md).

A computer that joins sends the same things to the same deployment, so the people
who can read the first computer's threads there (you, the people on that Convex
team, the phones and browsers paired) can read the joined computer's too. If the
joined computer is a work PC, that includes its thread text, which then sits in
your own Convex account: check that is allowed where you work before you join.

Phone notifications go through the push relay, which is Mike Cann's (the
original author, not this fork's) and the one shared piece: the phone apps' push
keys can't be in everyone's deployments. Your deployment registers with it,
giving its own address, and sends it the notification sealed with a key only that
phone and your deployment have. The relay sees a device token and a thread id,
never the title or the text (docs/push-relay.md). To keep everything out of it,
set the environment variable `PUSH_RELAY` to `off` on your production deployment
(in the Convex dashboard, the deployment's Settings and Environment Variables);
the phones then get no notifications.

## Undoing it

Nothing is permanent, and nothing outside your own account and data folder was
touched.

- **Stop using the backend:** in runner.json delete the `url` line under `sync`
  (or set `"sync": { "enabled": false }`), and restart the runner. The phone and
  browser stop working. The runner keeps working on its own.
- **Take the keys off this computer:** delete `secrets\convex-deploy.env`,
  `secrets\convex-key` and `secrets\made-deploy-keys` from the data folder.
- **Remove it from Convex:** in the Convex dashboard, delete the project (its
  settings page) and with it the deployments, the deploy key and the data. That
  also signs every paired phone and browser out. To only sign devices out and
  keep the backend, use Sign out in Settings > Phone & browser.
- **Convex login:** `node node_modules/convex/bin/main.js logout` in the clone
  forgets the login on this computer.
- **The clone:** delete `.env.local` to unlink it from the project.

To undo a join (the joined computer has none of the above):

- **Stop using the backend on the joined computer:** in its runner.json delete the
  `url` line under `sync` (or set `"sync": { "enabled": false }`), and restart the
  runner. `runnerId` and `name` can stay: they are only this computer's id and name.
- **Take the key off it:** delete `secrets\convex-key` from its data folder, and the
  key file too if it is still on the USB stick. With no key the runner doesn't sync.
- **Revoke the key, on the first computer:** `tb runner revoke <runnerId>` (`tb
  runner list` has the id). The key stops working at once, and that runner can't
  reach the backend until it is given another. What it already sent stays in the
  backend; `tb runner revoke <runnerId> --purge` also takes out everything that
  runner wrote there (its threads with their messages and pictures, sidebar rows,
  Pocket cards, schedules, projects and accounts), which can't be undone. Revoke the
  key before you rely on a lost USB stick being harmless: deleting from one is not a
  secure erase.

## If it stops

It says what failed and that it can be run again. Common ones:

- *"Node X is too old: Threadbear needs Node 24 or newer"*: install a newer Node
  from https://nodejs.org and run it with that one (`node --version`). The script
  checks this before it reads any of the repository's code, so an old Node gets
  this message and not a stack trace.
- *"Couldn't reach Convex to check the saved login"*: the network (or a proxy or
  VPN) was down. The saved login was left as it was; run it again when you are
  back online.
- *"isn't a git clone"* or *"has no convex folder"*: you are in the installed app's
  folder or an unpacked ZIP. Use `git clone`.
- *"Your Convex login has N teams"*: give `--team` with one of the slugs it lists.
- *"This clone's .env.local points at the Convex project X"*: the clone is linked to
  a project you didn't name. Pass `--project X` if that is the one, or delete
  `.env.local`.
- *"runner.json isn't valid JSON"*: open the file it names, fix it (or move it
  aside) and run it again. It changed nothing.
- The deploy fails on `npm ci`, a typecheck or the website build: the output above
  the message says why. Fix it and run the script again; the keys and runner.json
  are already in place.
- Settings > Phone & browser still says the backend is off: the runner started
  before runner.json was written. Restart it (step 8).

And for `--join`, each of which changes nothing:

- *"Joining needs a computer with no admin power over the backend"*: it lists what
  was found (a deploy key, a team token, a Convex login and so on) and the order to
  deal with it. See "What a join refuses". There is no way round it.
- *"holds the main key, not a runner key"*, about `secrets\convex-key`: that is the
  first computer's key, or a copy of it, and is never replaced. If this is the first
  computer, you don't want `--join` here. If it is a second computer that was
  handed a copy, move the file somewhere safe, run this again, then run `tb runner
  rotate-owner` on the first computer so the copy stops working.
- *"A joining computer needs the address of the backend the first computer made"*:
  add `--url` with the first computer's `sync.url` (part one, step 1).
- *"--url wants a Convex cloud address"*: the address isn't https, has a path,
  a port or a password, or isn't a `convex.cloud` one. Copy it again from runner.json.
- *"already mirrors to ... not ..."*: runner.json has a different `sync.url`. Use that
  one, or take the `url` line out of runner.json if you do mean to move.
- *"Couldn't reach ..."*: the network, a proxy or a VPN. The message says nothing was
  changed. With a certificate error, see "A work network that inspects HTTPS traffic".
- *"answered, but it doesn't look like a Convex deployment"*: the address is wrong.
  Check it against the first computer's runner.json.
- *"Couldn't read the key file"*, *"is bigger than a key file ever is"*, *"doesn't hold
  a runner key"*, *"holds the main key"* or *"holds a Convex deploy key"*: the
  file isn't what `tb runner add --out` wrote. Make it again on the first computer.
  If the message says the main key or a deploy key was in it, delete that copy.
- *"is inside the repository clone"*: move the key file outside the folder with the
  repository's files, and run it again.
- *"The backend turned the key down (bad runner key)"*: the key was replaced or
  revoked, or the address isn't the backend that made it. On the first computer run
  the `tb runner add` line it prints, with `--replace`, and use the new file.
- *"That key is for a different runner than ..."*: the key was made for another id.
  Run the `tb runner add` line it prints on the first computer, or give `--id` with the
  id the key was made for.
- *"This computer has no runner id yet"*: you went straight to part two on a computer
  whose runner has never started. Run part one, or give `--id` with the id the key
  was made for (`tb runner list` on the first computer).
- *"isn't this computer's runner id"*: runner.json has an id, and a runner keeps it.
  Make the key for that id.
- On the first computer, `tb runner add` saying that a deployment can have at most 3
  runner keys: `tb runner list` shows them, and `tb runner revoke <runnerId>` takes
  away one you don't need. If it can't write the file (a wrong drive letter, say),
  the key it made stays live with nobody holding it: run the same command again with
  `--replace` added.

`--dry-run` shows the plan at any point, and `backend.json` in the data folder
and `runner/scripts/deploy-backend.mjs --status` say what was deployed last.
