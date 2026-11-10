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
  commit. `git clone https://github.com/platima/threadbear.git`, then work from
  that folder. Folders with spaces or brackets in their names are fine.
- **Threadbear installed, and opened once**, so it has a data folder
  (`%APPDATA%\Threadbear` on Windows, `~/Library/Application Support/Threadbear`
  on Linux). The script makes the folder if it isn't there, but the runner you
  want to pair is the one that uses it.

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
| `--yes`, `-y` | don't ask: go ahead, use the only Convex team, restart the runner |
| `--team SLUG` | the Convex team for the project (otherwise the only one, or you choose) |
| `--project NAME` | the project's name (default `threadbear`) |
| `--region REGION` | the Convex region (default: the one nearest this computer's time zone) |
| `--name NAME` | what the phone calls this computer (default: its host name) |
| `--home DIR` | the runner's data folder, if it isn't the usual one. The installed runner is restarted only when this is the folder it uses |
| `--no-restart` | don't restart the runner; say how to |

The steps, in order:

1. **This computer.** Node, git, npm and tar are there, the folder is a git clone
   with the `convex/` and `web/` folders, and the data folder exists. It says
   plainly what is missing. On a Mac it says to use `./threadbear setup` instead.
2. **Packages.** `npm ci` in the clone, for the Convex command line.
3. **Convex login.** Opens your browser, and you approve it there. Skipped if this
   computer is already logged in to Convex.
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
   answer no (or pass `--no-restart`) and run `tb restart` in a new terminal, which
   waits until no thread is busy, or use the app's Runners page. The installed task
   or service runs with the standard data folder, so it is restarted only when
   `--home` (or `THREADBEAR_HOME`) is that folder. With another folder the script
   leaves it alone, since ending it would change nothing for the runner that uses
   the folder you named, and says to restart that runner yourself.
9. **Where to pair.** Open Threadbear, Settings > Phone & browser.

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

The deployment is in your Convex account, and only you and the people you give
access to the Convex team can read what is stored. Threadbear's maintainers
see none of it. What the runner stores there is listed under "Who it talks to" in
docs/on-your-mac.md: thread titles and status, the text of messages (each cut at
8,000 characters, with the shapes of keys and tokens taken out first, which is a
best effort and not a guarantee), one line per tool call, project names, and the
pictures you paste into a message. Tool output and diffs stay on the computer
unless you turn on full sync (docs/full-convex.md).

Phone notifications go through the push relay, which is Mike Cann's (the
original author) and the one shared piece: the phone apps' push keys can't be in
everyone's deployments. Your deployment registers with it, giving its own address,
and sends it the notification sealed with a key only that phone and your
deployment have. The relay sees a device token and a thread id, never the title
or the text (docs/push-relay.md). To keep everything out of it, set the
environment variable `PUSH_RELAY` to `off` on your production deployment (in the
Convex dashboard, the deployment's Settings and Environment Variables); the
phones then get no notifications.

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

## If it stops

It says what failed and that it can be run again. Common ones:

- *"... is too old; Threadbear needs 24 or newer"*: install a newer Node and run it
  with that one (`node --version`).
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

`--dry-run` shows the plan at any point, and `backend.json` in the data folder
and `runner/scripts/deploy-backend.mjs --status` say what was deployed last.
