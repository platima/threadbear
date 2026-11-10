// `node scripts/setup-sync.mjs`: sets up the Convex sync backend for a Windows or
// Linux copy of Threadbear, so a phone or a browser can be paired with it
// (docs/pairing.md). It is the Windows and Linux counterpart of the Convex half
// of scripts/setup.mjs, which is for the Mac and does the same things before it
// goes on to build the Mac app. Every step looks at what is already there
// first, so running it again only does what is missing, and --dry-run says what
// it would do without doing any of it.
//
//   node scripts/setup-sync.mjs [--dry-run] [--yes] [--team SLUG] [--project NAME]
//                               [--region REGION] [--name NAME] [--home DIR]
//                               [--no-restart]
//
// Run it from a clone of the repository (git clone, not Download ZIP): the
// backend is deployed from the clone's commit. Convex cloud only. A self-hosted
// backend (docs/self-hosting.md) stays Mac-only.
//
//   1. this computer: Node 24 or newer, git, npm and tar, the repository, and the
//      runner's data folder (%APPDATA%\Threadbear on Windows, and
//      ~/Library/Application Support/Threadbear on Linux, as the runner keeps it)
//   2. the repo's packages (npm ci)
//   3. a Convex login, in your browser (reused if this PC has one)
//   4. a Convex project of your own with a production deployment (reused if
//      this clone already points at one, or runner.json already names one)
//   5. its keys: a deploy key the backend deploy uses (secrets/convex-deploy.env)
//      and the main runner key, set as RUNNER_KEY on the deployment and kept in
//      secrets/convex-key
//   6. runner.json: sync.url and sync.name merged in, everything else left as it is
//   7. the backend and the website, deployed (runner/scripts/deploy-backend.mjs)
//   8. the runner restarted, so it reads the new runner.json (the installed one, and
//      only when --home is the data folder it uses: another folder's runner is left
//      alone, and so is any runner when this is run inside a Threadbear thread, as
//      stopping it there would end the thread's turn)
//   9. where to pair: Settings > Phone & browser > Show a code
//
// Nothing in this script is Mike's or the fork's: the project, the deployment and
// the keys are in your own Convex account and your own data folder. (The backend
// it deploys sends phone notifications through the push relay, which is Mike's
// unless PUSH_RELAY is off: docs/pairing.md, "Privacy".)
//
// Node built-ins and the runner's own sources only, so it runs before the repo's
// packages are installed. Those sources are TypeScript, which only Node 24 and
// newer (and some 22) load, so they are loaded after the Node version has been
// checked and not at the top: on an older Node the check can still say what to
// install, where a static import would die first with ERR_UNKNOWN_FILE_EXTENSION.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isJoining, runnerKeyPlan } from './runner-key-plan.mjs';

export const MIN_NODE = 24;

// Why this Node can't run the script, if it can't, and what to do about it.
export function oldNodeMessage(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  if (major >= MIN_NODE) return undefined;
  return `Node ${version} is too old: Threadbear needs Node ${MIN_NODE} or newer. Install it from https://nodejs.org (or with your package manager), open a new terminal, check that "node --version" says ${MIN_NODE} or more, and run this again.`;
}

// Whether this file is the program being run, not something a test imports.
// Compared by real path, and without regard to case on Windows, where
// `d:\repos\...` and `D:\Repos\...` are the same file.
function ranAsScript() {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const a = real(process.argv[1]);
  const b = real(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The runner's own modules, which the steps below use. Left unset on a Node too old to load them.
let ConvexAdminError, convexEnv, readConvexAdmin, siteOf;
let readRunnerJson, RunnerJsonError, writeRunnerJson;
let dataDirFor, dataDirWarning;
let nodeBin, npmCommand, pathWith, tarProgram;
const tooOld = oldNodeMessage();
if (tooOld) {
  // Nothing more can be loaded. As a program it says so and stops; imported by something else it throws.
  if (!ranAsScript()) throw new Error(tooOld);
  console.error(`\nFailed: ${tooOld}`);
  process.exitCode = 1;
} else {
  ({ ConvexAdminError, convexEnv, readConvexAdmin, siteOf } = await import('../runner/src/convex-admin.ts'));
  ({ readRunnerJson, RunnerJsonError, writeRunnerJson } = await import('../runner/src/config.ts'));
  ({ dataDirFor, dataDirWarning } = await import('../runner/src/platform.ts'));
  ({ nodeBin, npmCommand, pathWith, tarProgram } = await import('../runner/src/node-tools.ts'));
}

export const USAGE = `node scripts/setup-sync.mjs [--dry-run] [--yes] [--team SLUG] [--project NAME]
                            [--region REGION] [--name NAME] [--home DIR] [--no-restart]

Sets up the Convex sync backend for a Windows or Linux copy of Threadbear so a
phone or a browser can be paired (docs/pairing.md). Safe to run again: it only
does what is missing.

  --dry-run      say what it would do and change nothing
  --yes, -y      don't ask: go ahead, pick the only Convex team, restart the runner
  --team SLUG    the Convex team to make the project in (asked, or the only one)
  --project NAME the project's name (default threadbear)
  --region R     the Convex region for the deployment (default: near this PC's time zone)
  --name NAME    what the phone calls this computer (default: its host name)
  --home DIR     the runner's data folder (default $THREADBEAR_HOME, else the runner's own).
                 The installed runner is restarted only when this is the folder it uses
  --no-restart   don't restart the runner; say how to do it. (It is never restarted
                 from inside a Threadbear thread, as that would end the thread's turn)
`;

// The nearest Convex region to this computer's time zone, so the phone and the
// website aren't a round trip across the world away. As scripts/setup.mjs
// works it out. Undefined leaves Convex's own default (the US).
export function nearestRegion(zone = '') {
  if (/^(Australia|Pacific\/(Auckland|Fiji|Guam|Port_Moresby)|Asia\/(Singapore|Jakarta|Makassar|Jayapura|Manila|Tokyo|Seoul|Hong_Kong|Shanghai|Taipei|Kuala_Lumpur|Bangkok|Ho_Chi_Minh))/.test(zone)) return 'aws-ap-southeast-2';
  if (/^(Europe|Africa|Atlantic\/(Reykjavik|Canary|Madeira|Azores))/.test(zone)) return 'aws-eu-west-1';
  return undefined;
}

// The teams `convex login status` lists (it prints them on stderr).
export function parseTeams(text) {
  return [...String(text ?? '').replace(/\r\n/g, '\n').matchAll(/^\s+- (.+) \(([^)]+)\)$/gm)].map((m) => ({ name: m[1], slug: m[2] }));
}

// What this clone's .env.local says about its Convex project, if anything:
// `CONVEX_DEPLOYMENT=dev:name # team: slug, project: slug`.
export function parseEnvLocal(text) {
  const deployment = String(text ?? '').match(/^CONVEX_DEPLOYMENT=["']?([^"'\s#]+)/m)?.[1];
  if (!deployment) return undefined;
  const m = String(text).match(/#\s*team:\s*([^,\n]+?)\s*,\s*project:\s*([^\s,\n]+)/);
  return { deployment, ...(m ? { team: m[1], project: m[2] } : {}) };
}

// Words from a command's output for a message, with anything that looks like a
// key taken out first: a deploy key ("prod:name|..."), a runner key, a long hex run.
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(?:prod|dev|preview):[a-z0-9-]+\|[A-Za-z0-9+/=_.-]+/gi, '[key]')
    .replace(/\btbr_[A-Za-z0-9_-]+/g, '[key]')
    .replace(/\b[0-9a-f]{40,}\b/gi, '[key]');
}

// Whether a command's output says the network failed (no connection, no DNS, a timeout), as against
// Convex answering and saying no.
export function looksOffline(text) {
  return /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|fetch failed|getaddrinfo|network|socket/i.test(String(text ?? ''));
}

class Fail extends Error {}

const shortHost = (name) => String(name).split('.')[0];
const keyHost = (name) => shortHost(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'pc';
const expand = (p, home) => p.replace(/^~(?=$|[\\/])/, home);
// Whether two folder names are the same folder: slashes either way and no trailing one, and
// without regard to case on Windows, where d:\data and D:\Data are one folder.
const samePath = (a, b, platform) => {
  const n = (p) => {
    const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? s.toLowerCase() : s;
  };
  return n(a) === n(b);
};
const quote = (p) => (/[\s"]/.test(p) ? `"${p}"` : p);

// The last few lines a command said, for a failure message.
function tail(r, lines = 3) {
  return redact(r.stderr || r.stdout || r.error?.message || '').trim().split(/\r?\n/).filter(Boolean).slice(-lines).join(' ');
}

// ---------------------------------------------------------------- the real machine

export function realDeps() {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homedir: os.homedir(),
    hostname: os.hostname(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    nodeExec: process.execPath,
    nodeVersion: process.versions.node,
    repo: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    exists: (file) => fs.existsSync(file),
    // Why the data folder isn't private to this user, if it isn't (runner/src/platform.ts).
    homeWarning: (home) => dataDirWarning(home),
    fetch: globalThis.fetch,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    // A command from node-tools.ts: { file, args, windowsVerbatimArguments? }.
    spawn(command, opts = {}) {
      const r = spawnSync(command.file, command.args, {
        cwd: opts.cwd,
        env: opts.env,
        input: opts.input,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: !opts.inherit,
        ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        ...(opts.inherit ? { stdio: 'inherit' } : {}),
      });
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) };
    },
    async ask(question) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    say: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

// ---------------------------------------------------------------- the steps

class Setup {
  constructor(d, v, { dry, out }) {
    this.d = d;
    this.v = v;
    this.dry = dry;
    this.out = out;
    this.todos = [];
    this.warnings = [];
    // What this run changes that the runner reads when it starts.
    this.changed = { runnerJson: false, runnerKey: false };
    this.teams = undefined;
    this.restarted = false;
    const given = v.home ?? d.env.THREADBEAR_HOME ?? d.env.THREADBEAR_DATA_DIR ?? d.env.THREADBARE_HOME;
    this.home = given ? path.resolve(expand(given, d.homedir)) : dataDirFor({ platform: d.platform, env: d.env, home: d.homedir });
    this.secrets = path.join(this.home, 'secrets');
    this.runnerJsonPath = path.join(this.home, 'runner.json');
    this.deployKeyFile = path.join(this.secrets, 'convex-deploy.env');
    this.runnerKeyFile = path.join(this.secrets, 'convex-key');
  }

  // ---- output
  say(s = '') {
    this.out(s);
  }
  ok(s) {
    this.out(`  ok    ${s}`);
  }
  todo(s) {
    this.todos.push(s);
    this.out(`  todo  ${s}`);
  }
  note(s) {
    this.out(`  note  ${s}`);
  }
  warn(s) {
    this.warnings.push(s);
    this.out(`  note  ${s}`);
  }

  // ---- reading what is there
  readRunner() {
    try {
      return readRunnerJson(this.home);
    } catch (e) {
      if (!(e instanceof RunnerJsonError)) throw e;
      let bom = '';
      try {
        if (fs.readFileSync(this.runnerJsonPath, 'utf8').startsWith('\uFEFF')) bom = ' It starts with a byte order mark, which Notepad adds when it saves as "UTF-8 with BOM": save it again as plain UTF-8.';
      } catch {
        // unreadable: the message above says so
      }
      throw new Fail(`${e.message}${bom} Nothing has been changed.`);
    }
  }

  admin() {
    try {
      return readConvexAdmin(this.home);
    } catch (e) {
      if (e instanceof ConvexAdminError) throw new Fail(e.message);
      throw e;
    }
  }

  localKey() {
    try {
      return fs.readFileSync(this.runnerKeyFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  hasToken() {
    try {
      return Boolean(JSON.parse(fs.readFileSync(path.join(this.d.homedir, '.convex', 'config.json'), 'utf8')).accessToken);
    } catch {
      return false;
    }
  }

  envLocal() {
    try {
      return parseEnvLocal(fs.readFileSync(path.join(this.d.repo, '.env.local'), 'utf8'));
    } catch {
      return undefined;
    }
  }

  // ---- running things
  baseEnv() {
    const P = this.d.platform === 'win32' ? path.win32 : path.posix;
    return pathWith(this.d.env, P.dirname(this.d.nodeExec), this.d.platform);
  }

  npm(args) {
    return npmCommand(this.d.nodeExec, args, { platform: this.d.platform, env: this.d.env, exists: this.d.exists });
  }

  convexBin() {
    return nodeBin(path.join(this.d.repo, 'node_modules'), 'convex');
  }

  // The Convex CLI, run with this Node on its own program file: no npx, so no
  // npx.cmd on Windows and nothing fetched from the network. With `admin` (the
  // deploy key's credential) the environment names the key and nothing else that
  // could pick a deployment, as scripts/setup.mjs runs its own. Without it the
  // environment names none, so the command acts as the logged-in person.
  convex(args, { admin, inherit, input } = {}) {
    const bin = this.convexBin();
    if (!bin) throw new Fail("The Convex command line isn't installed in node_modules yet (npm ci should have put it there).");
    const env = admin ? convexEnv(admin, this.baseEnv()) : convexEnv({ kind: 'none', file: '', selfHostedFile: '' }, this.baseEnv());
    return this.d.spawn({ file: this.d.nodeExec, args: [bin, ...args] }, { cwd: this.d.repo, env, inherit, input });
  }

  async confirm(question) {
    if (this.v.yes) return true;
    if (!this.d.isTTY) return false;
    return /^y(es)?$/i.test(await this.d.ask(`${question} [y/N] `));
  }

  writeSecret(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
    // NTFS has no modes: a file in the user's profile already belongs to them
    // (runner/src/platform.ts, chmodSafe), which is why the data folder is checked below.
    if (this.d.platform !== 'win32') fs.chmodSync(file, 0o600);
  }

  // ---- 1. this computer
  checkComputer() {
    const { d, v } = this;
    this.say('1. This computer');
    if (d.platform === 'darwin') {
      throw new Fail('This script is for Windows and Linux. On a Mac, run ./threadbear setup instead: it does this and builds the runner and the Mac app (docs/setup-and-updates.md, section 2.2).');
    }
    if (d.platform !== 'win32' && d.platform !== 'linux') throw new Fail(`Threadbear runs on Windows, Linux and macOS, and this is ${d.platform}.`);
    this.ok(`${d.platform === 'win32' ? 'Windows' : 'Linux'} ${d.arch}`);

    // The same check as the one at the top of the file, for a Node that was handed in.
    const old = oldNodeMessage(d.nodeVersion);
    if (old) throw new Fail(old);
    this.ok(`Node ${d.nodeVersion}`);

    const git = d.spawn({ file: 'git', args: ['--version'] }, { env: this.baseEnv() });
    if (git.status !== 0) throw new Fail(`git is missing, or won't run. ${d.platform === 'win32' ? 'Install Git for Windows (https://git-scm.com/download/win)' : 'Install it with your package manager'}, then run this again.`);
    this.ok(git.stdout.trim() || 'git');
    const head = d.spawn({ file: 'git', args: ['-C', d.repo, 'rev-parse', '--verify', 'HEAD'] }, { env: this.baseEnv() });
    if (head.status !== 0) throw new Fail(`${d.repo} isn't a git clone with a commit in it. The backend is deployed from the clone's commit, so get it with git clone (not Download ZIP) and run this from there.`);
    for (const dir of ['convex', 'web']) {
      if (!d.exists(path.join(d.repo, dir))) throw new Fail(`${d.repo} has no ${dir} folder, so it is not a clone of the repository (an installed copy of the app has none). Run this from a clone of the repository, made with git clone.`);
    }
    this.ok(`the repository, ${d.repo}`);

    const npmV = this.npm(['--version']);
    const npm = d.spawn(npmV, { env: this.baseEnv() });
    if (npm.status !== 0) throw new Fail(`npm won't run (${tail(npm) || 'no answer'}). It comes with Node: reinstall Node from https://nodejs.org, then run this again.`);
    this.ok(`npm ${npm.stdout.trim()}`);

    // The backend deploy unpacks the commit with tar and, on Linux, keeps two deploys apart with flock.
    const tar = d.spawn({ file: tarProgram({ platform: d.platform, env: d.env, exists: d.exists }), args: ['--version'] }, { env: this.baseEnv() });
    if (tar.status !== 0) throw new Fail(d.platform === 'win32' ? "tar.exe isn't in the Windows folder (C:\\Windows\\System32\\tar.exe comes with Windows 10 and 11). Without it the backend can't be unpacked for deploying." : "tar isn't installed. Install it with your package manager, then run this again.");
    this.ok('tar');
    if (d.platform === 'linux' && !['/usr/bin/flock', '/bin/flock'].some((f) => d.exists(f))) throw new Fail("flock isn't installed (it is in util-linux). The backend deploy needs it. Install it with your package manager, then run this again.");

    if (d.exists(this.home)) this.ok(`data folder ${this.home}`);
    else if (this.dry) this.todo(`make the data folder ${this.home}`);
    else {
      fs.mkdirSync(this.home, { recursive: true });
      this.ok(`made the data folder ${this.home}`);
    }
    const outside = d.homeWarning(this.home);
    if (outside) this.warn(`${outside} This setup writes a deploy key and the runner key there.`);
    if (!d.exists(this.runnerJsonPath)) this.note("there is no runner.json yet, so Threadbear hasn't run with this data folder. That is fine: this makes one, and the runner fills in the rest when it starts.");

    // Things that mean this isn't a job for this script.
    const admin = this.admin();
    if (admin.kind === 'selfHosted') {
      throw new Fail(`This computer has a self-hosted Convex backend (${admin.file}). This script sets up Convex cloud only; a self-hosted backend is Mac-only for now (docs/self-hosting.md), so nothing was changed.`);
    }
    if (isJoining({ existing: false, local: this.localKey() })) {
      throw new Fail(`${this.runnerKeyFile} is a key of this runner's own, given by another computer's Threadbear (tb runner add). That computer owns the backend, and has its own phone pairing; there is nothing to set up here.`);
    }
    const json = this.readRunner();
    if (json.sync?.enabled === false) {
      throw new Fail(`${this.runnerJsonPath} has "sync": { "enabled": false }, so the runner won't use a backend whatever this sets up. Remove that line (or set it to true) and run this again. Nothing has been changed.`);
    }
    if (v.team && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.team)) throw new Fail(`--team wants a team slug like my-team, not ${JSON.stringify(v.team)}.`);
    if (v.region && !/^[a-z0-9-]+$/.test(v.region)) throw new Fail(`--region wants a Convex region like aws-ap-southeast-2, not ${JSON.stringify(v.region)}.`);
    if (v.project !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(v.project)) throw new Fail(`--project wants a name of letters, numbers, spaces, dots, dashes and underscores, not ${JSON.stringify(v.project)}.`);
    if (v.name !== undefined && (!v.name.trim() || v.name.length > 64 || /[\u0000-\u001f]/.test(v.name))) throw new Fail('--name wants a short name for this computer, such as Desk PC.');
  }

  // ---- 2. packages
  packages() {
    this.say('2. Packages');
    if (this.convexBin()) return this.ok('installed (the Convex command line is in node_modules)');
    if (this.dry) return this.todo(`npm ci in ${this.d.repo} (a minute or two)`);
    const r = this.d.spawn(this.npm(['ci', '--no-audit', '--no-fund']), { cwd: this.d.repo, env: this.baseEnv(), inherit: true });
    if (r.status !== 0 || !this.convexBin()) throw new Fail('npm ci failed (the output above says why). Fix that, then run this again.');
    this.ok('installed');
  }

  // ---- 3. Convex login
  fetchTeams() {
    const r = this.convex(['login', 'status']);
    const all = `${r.stdout}\n${r.stderr}\n${r.error?.message ?? ''}`;
    return { ok: r.status === 0, teams: parseTeams(all), text: tail(r), offline: r.status !== 0 && looksOffline(all) };
  }

  login() {
    this.say('3. Convex login');
    if (!this.hasToken()) {
      if (this.dry) return this.todo('log in to Convex: it opens your browser, and you approve it there (you need a Convex account: https://convex.dev)');
      return this.logIn();
    }
    if (this.dry) return this.ok('a Convex login is on this computer');
    const status = this.fetchTeams();
    if (status.ok) {
      this.teams = status.teams;
      return this.ok('logged in to Convex');
    }
    // No network is not a bad login: logging in again would replace one that is fine, and ask for
    // a browser approval that can't finish either.
    if (status.offline) {
      throw new Fail(`Couldn't reach Convex to check the saved login (${status.text || 'no answer'}). The login itself was left as it is. Check your internet connection (and any proxy or VPN), then run this again.`);
    }
    this.note(`Convex didn't accept the saved login (${status.text || 'no answer'}), so logging in again.`);
    this.logIn(true);
  }

  logIn(force = false) {
    // The browser flow with no questions in the terminal: it opens the page, prints the link in case it
    // can't, and waits for the approval there.
    const r = this.convex(['login', '--device-name', shortHost(this.d.hostname), '--login-flow', 'poll', ...(force ? ['--force'] : [])], { inherit: true });
    if (r.status !== 0 || !this.hasToken()) throw new Fail("Logging in to Convex didn't finish. Run this again when you can approve it in the browser.");
    this.ok('logged in to Convex');
  }

  // ---- 4. the project and its production deployment
  async pickTeam() {
    const { v, d } = this;
    if (v.team) return v.team;
    const found = this.teams ? { ok: true, teams: this.teams } : this.fetchTeams();
    const teams = found.teams;
    if (teams.length === 1) return teams[0].slug;
    if (!teams.length) throw new Fail("Convex didn't list any teams for this login. Run this again with --team and the slug of the team to use (it is in the address of your Convex dashboard: dashboard.convex.dev/t/<slug>).");
    if (d.isTTY && !v.yes) {
      this.say('  Your Convex login has more than one team:');
      teams.forEach((t, i) => this.say(`    ${i + 1}. ${t.name} (${t.slug})`));
      const answer = Number(await d.ask('  Which one for Threadbear? Number: '));
      if (Number.isInteger(answer) && teams[answer - 1]) return teams[answer - 1].slug;
      throw new Fail('That is not one of the numbers. Run this again, or pass --team.');
    }
    throw new Fail(`Your Convex login has ${teams.length} teams. Run this again with --team and one of: ${teams.map((t) => `${t.slug} (${t.name})`).join(', ')}.`);
  }

  // The key's "prod:<name>|..." prefix names its deployment, which has to be
  // the one runner.json mirrors to (deploy-backend.mjs checks the same).
  sameDeployment(admin, url) {
    let name;
    try {
      name = new URL(url).hostname.split('.')[0];
    } catch {
      return;
    }
    if (admin.deployment && name && admin.deployment !== name) {
      throw new Fail(`The deploy key in ${admin.file} is for the deployment ${admin.deployment}, but runner.json mirrors to ${url}. Remove the key file (or the sync line in runner.json) so they agree, then run this again.`);
    }
  }

  async project() {
    const { d, v } = this;
    this.say('4. Convex project');
    const json = this.readRunner();
    const have = json.sync?.url;
    const admin = this.admin();
    if (have && admin.kind === 'cloud') {
      this.sameDeployment(admin, have);
      this.ok(`using ${have}`);
      return have;
    }
    if (!have && admin.kind === 'cloud') {
      // A deploy key is already here (an earlier run that stopped part way, or one put here by hand).
      // It belongs to one deployment, and a second one made now would never match it: the key would
      // be kept, runner.json would name the new one and the backend deploy would refuse the mismatch.
      // So it is that deployment that is used, found from the name in the key.
      const found = admin.deployment ? await this.findUrl(admin.deployment) : undefined;
      if (!found) {
        throw new Fail(`There is already a deploy key in ${admin.file}${admin.deployment ? `, for the deployment ${admin.deployment}` : ''}, but runner.json doesn't say where that deployment is and it couldn't be found, so this won't make another backend that the key doesn't match. Put its address in runner.json as "sync": { "url": "https://${admin.deployment ?? 'your-deployment'}.convex.cloud" } (it is on the deployment's page in the Convex dashboard) and run this again, or remove ${admin.file} to start over with a new one. Nothing has been changed.`);
      }
      this.ok(`the deploy key in ${admin.file} is for ${found}: using that deployment, not making another`);
      return found;
    }
    const env = this.envLocal();
    if (have) {
      if (!env) {
        throw new Fail(`runner.json already mirrors to ${have}, so this won't make a second backend, but there is no deploy key for it here and this clone isn't linked to its project. Either remove the "url" line under "sync" in ${this.runnerJsonPath} to start a new backend, or link this clone to the project that owns it (npx convex dev --once --configure existing) and run this again.`);
      }
      this.ok(`runner.json already mirrors to ${have}; the deploy key made next must be for that deployment`);
      return have;
    }
    const want = v.project ?? 'threadbear';
    if (env) {
      const slug = env.project?.toLowerCase();
      const wantSlug = want.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (slug && slug !== wantSlug && !new RegExp(`^${wantSlug}-\\d+$`).test(slug)) {
        throw new Fail(`This clone's .env.local points at the Convex project ${env.project}${env.team ? ` (team ${env.team})` : ''}, not ${want}. The production deployment of the project this uses gets Threadbear's backend, replacing what is on it. If ${env.project} is the one you mean, run this again with --project ${env.project}; if not, delete .env.local.`);
      }
      this.ok(`this clone already has a Convex project: .env.local points at ${env.deployment}${env.project ? ` (project ${env.project})` : ''}`);
    } else if (this.dry) {
      this.todo(`make a Convex project called "${want}"${v.team ? ` on the team ${v.team}` : ''}, with the dev deployment Convex gives every project`);
    } else {
      const team = await this.pickTeam();
      const r = this.convex(['dev', '--once', '--configure', 'new', '--project', want, '--dev-deployment', 'cloud', '--team', team], { inherit: true });
      if (r.status !== 0 || !this.envLocal()) {
        throw new Fail(`Making the Convex project failed (the output above says why). If a project called ${want} is already on team ${team}, run this again with --project and another name.`);
      }
      this.ok(`project ${want} on team ${team}`);
    }
    const region = v.region ?? nearestRegion(d.timeZone);
    if (this.dry) {
      this.todo(`make the project's production deployment${region ? ` in ${region}` : ''}`);
      return undefined;
    }
    const made = this.convex(['deployment', 'create', 'production', '--type', 'prod', '--default', ...(region ? ['--region', region] : [])]);
    const url = `${made.stdout}\n${made.stderr}`.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)?\.convex\.cloud/)?.[0];
    if (url) this.ok(`production deployment ${url}`);
    else this.note(`the production deployment may exist already (${tail(made) || 'no answer'}); looking for it`);
    return url;
  }

  // Probes the regions Convex runs in for a deployment's URL.
  async findUrl(name) {
    for (const region of ['', 'ap-southeast-2.', 'eu-west-1.', 'us-east-1.', 'us-west-2.']) {
      const url = `https://${name}.${region}convex.cloud`;
      try {
        const res = await this.d.fetch(`${url}/version`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return url;
      } catch {
        // not this one
      }
    }
    return undefined;
  }

  // ---- 5. keys
  async keys(urlFromProject) {
    const { d } = this;
    this.say('5. Keys');
    let admin = this.admin();
    if (admin.kind === 'cloud') this.ok(`deploy key, in ${this.deployKeyFile}`);
    else if (this.dry) this.todo(`a deploy key for the production deployment, in ${this.deployKeyFile}`);
    else {
      fs.mkdirSync(this.secrets, { recursive: true, mode: 0o700 });
      const keyName = `threadbear-runner-${keyHost(d.hostname)}`;
      const r = this.convex(['deployment', 'token', 'create', keyName, '--prod', '--save-env', this.deployKeyFile]);
      admin = this.admin();
      if (r.status !== 0 || admin.kind !== 'cloud') throw new Fail(`Making a deploy key failed (${tail(r) || 'no answer'}). Check that the Convex project has a production deployment, then run this again.`);
      if (d.platform !== 'win32') fs.chmodSync(this.deployKeyFile, 0o600);
      // By name, so tb runner rotate-owner knows this one is this computer's own.
      fs.appendFileSync(path.join(this.secrets, 'made-deploy-keys'), `${keyName}\n`, { mode: 0o600 });
      const wanted = this.readRunner().sync?.url ?? urlFromProject;
      if (wanted) {
        try {
          this.sameDeployment(admin, wanted);
        } catch (e) {
          fs.rmSync(this.deployKeyFile, { force: true });
          throw e;
        }
      }
      this.ok(`deploy key saved in ${this.deployKeyFile}`);
    }

    let url = urlFromProject ?? this.readRunner().sync?.url;
    if (!url && admin.kind === 'cloud' && admin.deployment) url = await this.findUrl(admin.deployment);
    if (!this.dry && !url) throw new Fail("Couldn't work out the production deployment's address. Put it in runner.json as sync.url (it is on the deployment's page in the Convex dashboard) and run this again.");

    // The deployment's RUNNER_KEY is the main key, which can do everything: one
    // that is already set wins and is never replaced, or a runner using it would
    // be locked out. Only a deployment without one gets a new key.
    // scripts/runner-key-plan.mjs holds those rules.
    const local = this.localKey();
    // The deploy key to ask the deployment with is not here yet (a dry run, before the real one makes
    // it), or the Convex command line isn't either. Nothing can be said of the deployment's key, so
    // what a first run does with a key already in the data folder is planned for, not skipped.
    if (admin.kind !== 'cloud' || !this.convexBin()) {
      if (local) this.todo(`the runner key already in ${this.runnerKeyFile}: the deployment's own RUNNER_KEY replaces it if the deployment has one, else this one is set as RUNNER_KEY on the deployment`);
      else {
        this.changed.runnerKey = true;
        this.todo(`the runner key: the deployment's own if it has one, else a new one set as RUNNER_KEY and kept in ${this.runnerKeyFile}`);
      }
      return url;
    }
    // Asked of the deployment even in a dry run (a read, nothing is written), because a key that is
    // already here can still be replaced by the deployment's own, or set on a deployment that has none:
    // those are credential writes, and a plan that left them out would let them run unconfirmed.
    const got = this.convex(['env', 'get', 'RUNNER_KEY'], { admin });
    const nextGet = this.convex(['env', 'get', 'RUNNER_KEY_NEXT'], { admin });
    const plan = runnerKeyPlan({ envGet: got, nextGet, local, joining: false });
    if (plan.action === 'fail') throw new Fail(plan.why.replace(/([Rr])un setup again/g, '$1un it again').replace('so setup stopped', 'so this stopped'));
    if (plan.action === 'keep') this.ok('runner key');
    else if (plan.action === 'copy') {
      this.changed.runnerKey = true;
      if (this.dry) this.todo(local ? `replace the runner key in ${this.runnerKeyFile} with the deployment's own RUNNER_KEY: the deployment already has a different one, which wins, so a runner using the old one would be locked out` : `copy the deployment's own RUNNER_KEY into ${this.runnerKeyFile}`);
      else {
        this.writeSecret(this.runnerKeyFile, got.stdout.trim());
        this.ok(local ? "runner key: using the deployment's (it already had one)" : 'runner key');
      }
    } else {
      if (!local) this.changed.runnerKey = true;
      if (this.dry) this.todo(local ? `set the runner key in ${this.runnerKeyFile} as RUNNER_KEY on the deployment, which has none` : `make a new runner key, keep it in ${this.runnerKeyFile} and set it as RUNNER_KEY on the deployment, which has none`);
      else {
        const fresh = local || crypto.randomBytes(32).toString('hex');
        if (!local) this.writeSecret(this.runnerKeyFile, fresh);
        const set = this.convex(['env', 'set', 'RUNNER_KEY'], { admin, input: fresh });
        if (set.status !== 0) throw new Fail(`Setting RUNNER_KEY on the deployment failed (${tail(set) || 'no answer'}). Run this again.`);
        this.ok('runner key set as RUNNER_KEY');
      }
    }
    return url;
  }

  // ---- 6. runner.json
  runnerJson(url) {
    this.say('6. runner.json');
    const json = this.readRunner();
    // sync.site is left out, as scripts/setup.mjs leaves it: a Convex cloud
    // deployment's website is the .convex.site twin of its address, which the
    // runner works out itself (runner/src/convex-admin.ts, siteOf).
    const name = this.v.name ?? json.sync?.name ?? shortHost(this.d.hostname);
    const next = { ...json, sync: { ...json.sync, ...(url ? { url } : {}), name } };
    if (JSON.stringify(next) === JSON.stringify(json)) return this.ok(`${this.runnerJsonPath} as it was (mirrors to ${json.sync?.url} as ${name})`);
    this.changed.runnerJson = true;
    if (this.dry) return this.todo(`write ${this.runnerJsonPath}: sync.url ${url ?? '(the new deployment)'} and sync.name ${name}; everything else in it stays`);
    try {
      writeRunnerJson(this.home, next);
    } catch (e) {
      if (e instanceof RunnerJsonError) throw new Fail(`${e.message} Nothing has been changed.`);
      throw e;
    }
    this.ok(`mirrors to ${next.sync.url} as ${name}`);
  }

  // ---- 7. backend and website
  backend() {
    this.say('7. Backend and website');
    const script = path.join(this.d.repo, 'runner', 'scripts', 'deploy-backend.mjs');
    const args = [script, '--home', this.home, '--repo', this.d.repo];
    if (this.dry) {
      // With a deploy key and an address in place, the script itself says whether anything is left to deploy.
      if (this.admin().kind === 'cloud' && this.readRunner().sync?.url) {
        const r = this.d.spawn({ file: this.d.nodeExec, args: [...args, '--dry-run'] }, { cwd: this.d.repo, env: this.baseEnv() });
        if (r.status === 0 && /up to date/i.test(r.stdout)) return this.ok(r.stdout.trim());
      }
      return this.todo("deploy the backend (convex/) and the website (web/) from the clone's commit to your deployment, with runner/scripts/deploy-backend.mjs (a few minutes)");
    }
    const r = this.d.spawn({ file: this.d.nodeExec, args }, { cwd: this.d.repo, env: this.baseEnv(), inherit: true });
    if (r.status !== 0) throw new Fail('Deploying the backend failed (the output above says why). The keys and runner.json are already in place. Run this again to finish the deploy; it carries on from where it stopped. The runner reads the new settings when it next restarts.');
  }

  // ---- 8. the runner
  installerScript() {
    return path.join(this.d.repo, 'runner', 'scripts', this.d.platform === 'win32' ? 'install-windows.mjs' : 'install-linux.mjs');
  }

  // A note, then how to restart the runner by hand, one note a line. The Runners page waits until
  // no thread is busy (runner.restart with when: idle); the two commands cut short what is running.
  restartHelp(first, { outsideThread = false } = {}) {
    const script = this.installerScript();
    this.note(first);
    this.note(`  Restart it from the app's Runners page, which waits until no thread is busy, or run these two commands${outsideThread ? ' from a terminal outside any thread' : ''} (they cut short what a thread is doing):`);
    this.note(`    node ${quote(script)} --stop`);
    this.note(`    node ${quote(script)} --start`);
    if (this.d.platform === 'linux') this.note('  (A runner installed with runner/scripts/install-runner.sh is restarted with: systemctl --user restart com.mikerosoft.threadbear.runner.service)');
  }

  // Whether this is running inside one of a runner's threads. The runner sets these in every
  // thread it starts (runner/src/restart.ts, threadEnv). Stopping the installed runner from there
  // ends this script before it starts it again, and the thread's turn with it, as it would for
  // runner/scripts/install-runner.sh, which refuses the real runner from any thread at all.
  inThread() {
    const { env } = this.d;
    return Boolean(env.THREADBEAR_THREAD_ID || env.THREADBARE_THREAD_ID);
  }

  async restart() {
    const { d, v } = this;
    this.say('8. Restart the runner');
    if (!this.changed.runnerJson && !this.changed.runnerKey) {
      this.ok('nothing the runner reads was changed in this run');
      return this.note(`If Settings > Phone & browser still says the sync backend is off, the runner started before those settings were written: restart it (${path.basename(this.installerScript())} --stop and then --start, or the Runners page).`);
    }
    if (v['no-restart']) return this.restartHelp('Not restarting (--no-restart). To make the runner read the new settings:');
    // The installed task or service takes no data folder of its own: it runs with the standard one.
    // With --home (or THREADBEAR_HOME) naming another, restarting it would stop whatever it is
    // doing for nothing and leave the runner that uses the folder just set up as it was, while
    // saying it had restarted. So that one is left alone.
    const standard = dataDirFor({ platform: d.platform, env: d.env, home: d.homedir });
    if (!samePath(this.home, standard, d.platform)) {
      this.note(`A runner installed on this computer (its ${d.platform === 'win32' ? 'Task Scheduler task' : 'systemd user service'}) uses the standard data folder, ${standard}, not ${this.home}. It was left alone: restarting it would not change the runner that uses ${this.home}.`);
      return this.note(`  To make that runner read the new settings, restart it yourself, the way you started it, with THREADBEAR_HOME set to ${this.home}.`);
    }
    if (this.inThread()) {
      return this.restartHelp("Not restarting: this is running inside a Threadbear thread, and stopping the runner from here would end this thread's turn (and every other thread's work). To make the runner read the new settings:", { outsideThread: true });
    }
    const script = this.installerScript();
    const installer = path.basename(script);
    if (!d.exists(script)) return this.restartHelp(`${script} isn't here. To make the runner read the new settings:`);
    const run = (flag) => d.spawn({ file: d.nodeExec, args: [script, flag] }, { cwd: d.repo, env: this.baseEnv() });
    const kind = d.platform === 'win32' ? 'Task Scheduler task' : 'systemd user service';
    if (run('--installed').status !== 0) {
      return this.restartHelp(`No ${kind} for the runner was found, so it can't be restarted from here. If you started it yourself, stop and start it as you did. Otherwise, to make the runner read the new settings:`);
    }
    if (this.dry) return this.todo(`restart the runner (its ${kind}) with ${installer} --stop and then --start. Anything a thread is doing right now is cut short`);
    if (!(await this.confirm('  Restart the runner now? Anything a thread is doing right now is cut short.'))) {
      return this.restartHelp('Not restarting. To make the runner read the new settings:');
    }
    const stop = run('--stop');
    if (stop.status !== 0) return this.restartHelp(`Couldn't stop the runner (${tail(stop)}). To make the runner read the new settings:`);
    // Ending a task takes a moment: a start straight after can find it still running.
    for (let attempt = 0; attempt < 3; attempt++) {
      d.sleep(3000);
      const start = run('--start');
      const said = `${start.stdout}${start.stderr}`;
      if (start.status === 0 && /Started the runner/.test(said)) {
        this.restarted = true;
        return this.ok('the runner restarted');
      }
      if (start.status !== 0) return this.note(`couldn't start the runner again (${tail(start)}). Open Threadbear, or run node ${quote(script)} --start.`);
    }
    this.note(`the runner didn't report starting. Check with node ${quote(script)} --status, and start it with --start if it isn't running.`);
  }

  // ---- 9. where to pair
  finish(url) {
    const { d } = this;
    this.say('9. Pair a phone or a browser');
    const site = siteOf(url, this.readRunner().sync?.site);
    if ((this.changed.runnerJson || this.changed.runnerKey) && !this.restarted) this.note('First restart the runner (step 8), so it reads the new settings.');
    this.note('In Threadbear on this computer, go to Settings > Phone & browser. "Show a code" is a QR code for a phone; "Make a link" signs a browser in.');
    if (site) this.note(`Your website will be at ${site} (a browser is signed in with the link from "Make a link").`);
    this.note('The iPhone app is on the App Store. For Android, install the app from the release (docs/android.md); a notification with the app closed needs its push relay.');
    this.note('What this made, how it is used and how to undo it: docs/pairing.md.');
    if (d.platform === 'win32') this.note("Your deploy key and runner key are in the data folder's secrets folder. Don't copy them anywhere or paste them into a thread.");
  }

  async all() {
    this.checkComputer();
    this.say();
    this.packages();
    this.say();
    this.login();
    this.say();
    const made = await this.project();
    this.say();
    const url = await this.keys(made);
    this.say();
    this.runnerJson(url);
    this.say();
    this.backend();
    this.say();
    await this.restart();
    this.say();
    this.finish(url);
    return url;
  }
}

// ---------------------------------------------------------------- the whole thing

// Does what argv asks and gives the exit code. `d` is everything it touches
// outside its own process (the machine, the commands it runs, the person at the
// keyboard, the clock), so a test can hand it stand-ins.
export async function main(argv, d = realDeps()) {
  let v;
  try {
    ({ values: v } = parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        team: { type: 'string' },
        project: { type: 'string' },
        region: { type: 'string' },
        name: { type: 'string' },
        home: { type: 'string' },
        'no-restart': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    d.err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (v.help) {
    d.say(USAGE);
    return 0;
  }
  const fail = (e) => {
    if (!(e instanceof Fail)) throw e;
    d.err(`\nFailed: ${e.message}\nFix that and run it again; it carries on from where it stopped.`);
    return 1;
  };

  if (v['dry-run']) {
    d.say('Threadbear sync setup (dry run: nothing changes)\n');
    try {
      const plan = new Setup(d, v, { dry: true, out: d.say });
      await plan.all();
      d.say(plan.todos.length ? '\nDry run done. Nothing was changed. Run it without --dry-run to do the steps marked todo.' : '\nDry run done. Nothing was changed, and nothing is left to do.');
      return 0;
    } catch (e) {
      return fail(e);
    }
  }

  // First a quiet look, to know what there is to do and to ask before doing it.
  const lines = [];
  const plan = new Setup(d, v, { dry: true, out: (s) => lines.push(s) });
  try {
    await plan.all();
  } catch (e) {
    d.say('Threadbear sync setup\n');
    for (const l of lines) d.say(l);
    return fail(e);
  }
  if (plan.todos.length) {
    d.say('Threadbear sync setup\n');
    d.say('This will:');
    for (const t of plan.todos) d.say(`  - ${t}`);
    if (plan.warnings.length) {
      d.say('');
      for (const w of plan.warnings) d.say(`Take care: ${w}`);
    }
    d.say('');
    if (!v.yes) {
      if (!d.isTTY) {
        d.err('Not asking, as there is no terminal here. Run it again in a terminal, or with --yes to go ahead, or with --dry-run to see the plan.');
        return 1;
      }
      if (!/^y(es)?$/i.test(await d.ask('Go ahead? [y/N] '))) {
        d.say('Nothing was changed.');
        return 0;
      }
    }
    d.say('');
  } else d.say('Threadbear sync setup\n');
  try {
    const run = new Setup(d, v, { dry: false, out: d.say });
    await run.all();
    d.say('\nDone.');
    return 0;
  } catch (e) {
    return fail(e);
  }
}

if (!tooOld && ranAsScript()) process.exitCode = await main(process.argv.slice(2));
