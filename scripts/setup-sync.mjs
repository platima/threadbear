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
//   node scripts/setup-sync.mjs --join [--url URL] [--key-file FILE] [--id RUNNERID]
//                               [--name NAME] [--delete-key-file] [--dry-run] [--yes]
//                               [--home DIR] [--no-restart]
//
// Run it from a clone of the repository (git clone, not Download ZIP): the
// backend is deployed from the clone's commit. Convex cloud only. A self-hosted
// backend (docs/self-hosting.md) stays Mac-only.
//
// --join is for a second computer, which uses the backend the first one made
// instead of making one (see "Joining" below).
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
// Joining (--join): a second computer, a work PC say, whose threads should show up
// beside the first one's. It is not given the backend's keys. The first computer
// makes it a runner key (tb runner add --out FILE --id RUNNERID), which acts as that
// one runner and can do nothing else on the backend. This computer ends up with
// that key, a runner.json that names the backend, and no Convex login, deploy key,
// project, packages, git or clone. It needs only this script, the files it imports
// and Node 24 or newer, so a Download ZIP or the app's own node.exe will do. Two
// runs of the same command:
//
//   part one  no key file yet. Records sync.url, sync.runnerId (a new id if the
//             runner hasn't made one) and sync.name in runner.json, and prints the
//             tb runner add command to run on the first computer, in a terminal of
//             your own, with this computer's id in it. Nothing else is changed.
//   part two  with --key-file FILE, the file that command wrote. The backend is asked
//             whether the key is live and is this runner's (a read), and only then is
//             the key put in secrets/convex-key, runner.json brought up to date, and
//             the runner restarted. --delete-key-file removes FILE after the key reads
//             back from secrets/convex-key.
//
// Steps 2, 3 and 7 are skipped, and step 4 is the backend's address (--url, or
// sync.url in runner.json) and a look that it answers. A computer is refused, with
// nothing changed and no way round it, if it has any of the five things tb runner
// check looks for beside a runner key (a deploy key, a self-hosted admin key, a team
// token, a Convex panel key, a Convex CLI login), or if secrets/convex-key already
// holds a key that is not a runner key (the main key is never replaced). The key
// file is read as bytes (a byte order mark and Windows PowerShell's UTF-16 are
// understood), must be a regular file of at most 1 KiB outside this clone, and its
// text is never printed. scripts/runner-key-plan.mjs (joinKeyPlan) decides what
// happens to the key.
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
import { isJoining, joinKeyPlan, runnerKeyPlan } from './runner-key-plan.mjs';

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
let ConvexAdminError, convexEnv, readConvexAdmin, siteOf, SELF_HOSTED_ENV_FILE, DEPLOY_ENV_FILE;
let readRunnerJson, RunnerJsonError, writeRunnerJson;
let dataDirFor, dataDirWarning;
let nodeBin, npmCommand, pathWith, tarProgram;
let atomicWriteFileSync;
const tooOld = oldNodeMessage();
if (tooOld) {
  // Nothing more can be loaded. As a program it says so and stops; imported by something else it throws.
  if (!ranAsScript()) throw new Error(tooOld);
  console.error(`\nFailed: ${tooOld}`);
  process.exitCode = 1;
} else {
  ({ ConvexAdminError, convexEnv, readConvexAdmin, siteOf, SELF_HOSTED_ENV_FILE, DEPLOY_ENV_FILE } = await import('../runner/src/convex-admin.ts'));
  ({ readRunnerJson, RunnerJsonError, writeRunnerJson } = await import('../runner/src/config.ts'));
  ({ dataDirFor, dataDirWarning } = await import('../runner/src/platform.ts'));
  ({ nodeBin, npmCommand, pathWith, tarProgram } = await import('../runner/src/node-tools.ts'));
  ({ atomicWriteFileSync } = await import('../runner/src/fsutil.ts'));
}

export const USAGE = `node scripts/setup-sync.mjs [--dry-run] [--yes] [--team SLUG] [--project NAME]
                            [--region REGION] [--name NAME] [--home DIR] [--no-restart]
node scripts/setup-sync.mjs --join [--url URL] [--key-file FILE] [--id RUNNERID]
                            [--name NAME] [--delete-key-file] [--dry-run] [--yes]
                            [--home DIR] [--no-restart]

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

A second computer joins the backend the first one made, with --join. It is given
a runner key of its own and nothing else: no Convex login, deploy key, project,
packages or git, and no clone is needed (only Node 24 or newer). Run it twice:

  1. node scripts/setup-sync.mjs --join --url ADDRESS
     records the address and this computer's runner id, and prints the command to
     run on the first computer (tb runner add NAME --out FILE --id RUNNERID).
  2. node scripts/setup-sync.mjs --join --url ADDRESS --key-file FILE
     checks the key with the backend, installs it, and restarts the runner.

A computer with a deploy key, a Convex login or any other admin credential for
the backend is refused (tb runner check lists them), as is one whose
secrets/convex-key holds the main key. Nothing is changed in either case.

  --join             join the backend another computer set up (the options below
                     go with it; --team, --project and --region don't)
  --url URL          the first computer's sync.url, like https://calm-fox-123.convex.cloud
                     (not needed when runner.json already has it)
  --key-file FILE    the file tb runner add --out wrote on the first computer. Keep it
                     off the repository folder, OneDrive and shared folders
  --id RUNNERID      the runner id the key was made for. Only when runner.json has no
                     sync.runnerId yet, or the same one. Part one makes an id if there is none
  --delete-key-file  delete FILE once the key in secrets/convex-key reads back the same
                     (a USB stick's deletion is not a secure erase)
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
// Whether two paths are one file on disk, however they are spelt: the same name (without regard to case on
// Windows), the same file once links and junctions are followed (and 8.3 short names expanded), or two names for
// one file (a hard link). The last two need both to exist.
const sameFile = (a, b, platform) => {
  if (samePath(path.resolve(a), path.resolve(b), platform)) return true;
  try {
    if (samePath(fs.realpathSync.native(a), fs.realpathSync.native(b), platform)) return true;
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    // An ino of 0 is a file system that has none to give (some network shares), not a file number.
    return x.ino !== 0n && x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
};
// Whether a path is inside a folder: by its name, and by where it really is once links and junctions are
// followed (a name outside the folder can lead into it). ".." has to be a whole path component, so a folder
// called "..keys" is inside. A file that isn't there yet is placed by its folder.
const within = (file, folder) => {
  const rel = path.relative(folder, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const insideFolder = (file, folder) => {
  if (within(path.resolve(file), path.resolve(folder))) return true;
  try {
    let real;
    try {
      real = fs.realpathSync.native(file);
    } catch {
      real = path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file));
    }
    return within(real, fs.realpathSync.native(folder));
  } catch {
    return false;
  }
};
const quote = (p) => (/[\s"]/.test(p) ? `"${p}"` : p);

// The last few lines a command said, for a failure message.
function tail(r, lines = 3) {
  return redact(r.stderr || r.stdout || r.error?.message || '').trim().split(/\r?\n/).filter(Boolean).slice(-lines).join(' ');
}

// ---------------------------------------------------------------- --join

// Anything the backend or the network said, or a person typed, as it is put in a message: no control
// characters or escape sequences (which could rewrite the terminal), no zero-width or direction marks, one
// line, cut short. As runner/src/runner-keys.ts `clean`.
// The characters it takes out, as ranges of code points: the C0 and C1 controls, zero-width and direction
// marks, line and paragraph separators, and the byte order mark.
const UNSEEN = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`, 'g');
export function oneLine(text, max = 160) {
  const one = String(text ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(UNSEEN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// A runner id as convex/runnerAccess.ts RUNNER_ID has it (a unit test keeps them the same), and not "any",
// which is the phone's "whichever runner".
export const RUNNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const validRunnerId = (id) => RUNNER_ID.test(id) && id !== 'any';

// The options that don't go together, said before anything is looked at. Undefined when they do.
export function joinUsageProblem(v) {
  if (v.join) {
    for (const flag of ['team', 'project', 'region']) {
      if (v[flag] !== undefined) return `--${flag} doesn't go with --join: a joining computer makes no project and no deployment. Leave out --team, --project and --region.`;
    }
    if (v['delete-key-file'] && v['key-file'] === undefined) return '--delete-key-file needs --key-file.';
    return undefined;
  }
  const why = {
    url: 'it is the address of the backend the first computer made',
    'key-file': 'it is the file that tb runner add --out wrote on the first computer',
    id: 'it is the runner id the first computer made the key for',
    'delete-key-file': 'it deletes the key file once the key is in place',
  };
  for (const [flag, reason] of Object.entries(why)) {
    if (v[flag] !== undefined && v[flag] !== false) return `--${flag} goes with --join: ${reason}. Add --join, or leave --${flag} out.`;
  }
  return undefined;
}

// The text of a key file, from its bytes: a UTF-8 byte order mark is dropped, UTF-16 LE with one (which is what
// Windows PowerShell 5.1 writes for > and Out-File) is decoded, and blanks around it go.
export function parseKeyText(bytes) {
  let b = Buffer.from(bytes);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le').trim();
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  return b.toString('utf8').trim();
}

// The five things `tb runner check` looks for beside a runner key (runner/src/runner-keys.ts: localAdmin,
// hasAdmin and adminAdvice), as this computer has them. Any of them can do anything to the backend, so a computer
// that has one is not given a runner key to join with. This is a copy of that code, because runner-keys.ts needs
// the runner's packages and this runs before they are installed; runner-keys.test.ts runs both over the same
// folders and fails if they ever say different things.
const PANEL_KEY = /^threadbear-panel-[a-z0-9-]{1,40}-[0-9a-f]{6}$/;
const DEPLOYMENT = /^[a-z0-9-]{1,64}$/;

export function localAdmin(home, userHome) {
  const dir = path.join(home, 'secrets', 'convex-panels');
  let panels = [];
  try {
    panels = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const name = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).name;
          return typeof name === 'string' ? name : '(no name)';
        } catch {
          return '(unreadable)';
        }
      });
  } catch {
    // no panel keys
  }
  return {
    deployEnv: fs.existsSync(path.join(home, 'secrets', DEPLOY_ENV_FILE)),
    cliLogin: fs.existsSync(path.join(userHome, '.convex', 'config.json')),
    teamToken: fs.existsSync(path.join(home, 'secrets', 'convex-team-token')),
    selfHostedEnv: fs.existsSync(path.join(home, 'secrets', SELF_HOSTED_ENV_FILE)),
    panels,
  };
}

export const hasAdmin = (a) => a.deployEnv || a.cliLogin || a.panels.length > 0 || Boolean(a.teamToken) || Boolean(a.selfHostedEnv);

function deploymentOf(url) {
  try {
    const d = new URL(url).hostname.split('.')[0] ?? '';
    return DEPLOYMENT.test(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

// What to do about them, as tb runner check says it. `words` changes only who is meant: by default this is
// that command's own text for a Mac, and a joining computer says "computer" and "the first computer".
export function adminAdvice(a, where, url, { rotateAt = 'here', mac = 'Mac', owner = 'the main Mac' } = {}) {
  const deployment = deploymentOf(url);
  const good = a.panels.filter((n) => PANEL_KEY.test(n));
  const odd = a.panels.length - good.length;
  const have = [a.deployEnv && `setup's deploy key (secrets/convex-deploy.env, named threadbear-runner-<that ${mac}'s name>)`, ...good.map((n) => `the Convex panel's deploy key ${n}`), odd && `${odd} panel key file${odd === 1 ? '' : 's'} with an unrecognised name (secrets/convex-panels/)`, a.cliLogin && 'a Convex CLI login (~/.convex/config.json)', a.teamToken && 'a Convex team access token (secrets/convex-team-token, which reaches every project on the team)', a.selfHostedEnv && `the self-hosted backend's admin key (secrets/${SELF_HOSTED_ENV_FILE})`].filter(Boolean);
  const settings = deployment ? `https://dashboard.convex.dev/d/${deployment}/settings` : "the deployment's settings in the Convex dashboard";
  const commands = deployment && good.length ? `, or from this ${mac}: ${good.map((n) => `npx convex deployment token delete ${n} --deployment ${deployment}`).join('; ')}` : '';
  return [
    `${where} also has ${have.join(', ')}. Any of them can do anything to the deployment, so its runner key keeps nothing out, and deleting the files doesn't stop a copy someone already took. In this order:`,
    `  1. Revoke them on Convex's side: the deploy keys in ${settings} (Deploy keys)${commands}.${odd ? ' Look there for any you don\'t recognise too.' : ''}${a.cliLogin ? ` The CLI login: in the Convex dashboard's account settings, revoke that ${mac}'s access token (named after its hostname).` : ''}${a.teamToken ? " The team token: in the Convex dashboard's team settings (Access tokens)." : ''}${a.selfHostedEnv ? " A self-hosted admin key can't be revoked on its own: every one comes from the backend's instance secret, so changing that is the only way (docs/self-hosting.md, \"Keys\")." : ''}`,
    `  2. Then remove them there: the files above${a.cliLogin ? ', and npx convex logout' : ''}.`,
    `  3. Then rotate the main key, which they could read: tb runner rotate-owner ${rotateAt}. Only ${owner} needs any of these.`,
  ].join('\n');
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
    // --join: what step 1 worked out for the steps after it (see checkJoin), and whether this computer is
    // still waiting for its key (part one), so there is nothing to restart yet.
    this.jn = undefined;
    this.waiting = false;
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
    this.say('1. This computer');
    this.checkPlatform();
    this.checkTools();
    this.checkDataFolder();
    this.checkFirstComputer();
  }

  checkPlatform() {
    const { d } = this;
    if (d.platform === 'darwin') {
      throw new Fail(
        this.v.join
          ? 'This script is for Windows and Linux. On a Mac, run ./threadbear setup --existing instead: it joins the backend another Mac set up (docs/setup-and-updates.md, section 2.2).'
          : 'This script is for Windows and Linux. On a Mac, run ./threadbear setup instead: it does this and builds the runner and the Mac app (docs/setup-and-updates.md, section 2.2).',
      );
    }
    if (d.platform !== 'win32' && d.platform !== 'linux') throw new Fail(`Threadbear runs on Windows, Linux and macOS, and this is ${d.platform}.`);
    this.ok(`${d.platform === 'win32' ? 'Windows' : 'Linux'} ${d.arch}`);

    // The same check as the one at the top of the file, for a Node that was handed in.
    const old = oldNodeMessage(d.nodeVersion);
    if (old) throw new Fail(old);
    this.ok(`Node ${d.nodeVersion}`);
  }

  // What the backend deploy needs: git and the clone, npm, tar and (on Linux) flock.
  checkTools() {
    const { d } = this;
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
  }

  // The runner's data folder, made if it isn't there. `writes` is what gets put in it, for the warning.
  checkDataFolder(writes = 'a deploy key and the runner key') {
    const { d } = this;
    if (d.exists(this.home)) this.ok(`data folder ${this.home}`);
    else if (this.dry) this.todo(`make the data folder ${this.home}`);
    else {
      fs.mkdirSync(this.home, { recursive: true });
      this.ok(`made the data folder ${this.home}`);
    }
    const outside = d.homeWarning(this.home);
    if (outside) this.warn(`${outside} This setup writes ${writes} there.`);
    if (!d.exists(this.runnerJsonPath)) this.note("there is no runner.json yet, so Threadbear hasn't run with this data folder. That is fine: this makes one, and the runner fills in the rest when it starts.");
  }

  // Things that mean this isn't a job for this script, and the options that can't be used.
  checkFirstComputer() {
    const { v } = this;
    const admin = this.admin();
    if (admin.kind === 'selfHosted') {
      throw new Fail(`This computer has a self-hosted Convex backend (${admin.file}). This script sets up Convex cloud only; a self-hosted backend is Mac-only for now (docs/self-hosting.md), so nothing was changed.`);
    }
    if (isJoining({ existing: false, local: this.localKey() })) {
      throw new Fail(`${this.runnerKeyFile} is a key of this runner's own, given by another computer's Threadbear (tb runner add). That computer owns the backend, and has its own phone pairing; this computer has joined that backend and has nothing to set up. To check the key or give it a new one, run this with --join.`);
    }
    const json = this.readRunner();
    if (json.sync?.enabled === false) {
      throw new Fail(`${this.runnerJsonPath} has "sync": { "enabled": false }, so the runner won't use a backend whatever this sets up. Remove that line (or set it to true) and run this again. Nothing has been changed.`);
    }
    if (v.team && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.team)) throw new Fail(`--team wants a team slug like my-team, not ${JSON.stringify(v.team)}.`);
    if (v.region && !/^[a-z0-9-]+$/.test(v.region)) throw new Fail(`--region wants a Convex region like aws-ap-southeast-2, not ${JSON.stringify(v.region)}.`);
    if (v.project !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(v.project)) throw new Fail(`--project wants a name of letters, numbers, spaces, dots, dashes and underscores, not ${JSON.stringify(v.project)}.`);
    this.checkName();
    // An address with no way to deploy to it here: a backend somebody else made. Said now, not at
    // step 4 after the list has promised packages and a Convex login that would come to nothing.
    if (json.sync?.url && admin.kind !== 'cloud' && !this.envLocal()) throw new Fail(this.noDeployKeyHere(json.sync.url));
  }

  checkName() {
    const { v } = this;
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

  noDeployKeyHere(have) {
    return `runner.json already mirrors to ${have}, so this won't make a second backend, but there is no deploy key for it here and this clone isn't linked to its project. Either remove the "url" line under "sync" in ${this.runnerJsonPath} to start a new backend, or link this clone to the project that owns it (npx convex dev --once --configure existing) and run this again. If this is a second computer joining a backend the first one made, run it with --join.`;
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
      // (checkFirstComputer has said so already; this is for a clone that lost its .env.local since.)
      if (!env) throw new Fail(this.noDeployKeyHere(have));
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
    // Part one of a join: runner.json names the backend but the key hasn't come yet, so a restart now would only
    // start a runner that can't sync. Part two restarts it.
    if (this.waiting) return this.ok('not needed yet: the runner has no key to use until it is in');
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

  // ---- --join: a computer that is not the first one. The steps keep their numbers, so what is said lines up
  // with the first computer's run and with docs/pairing.md.

  // Where a key file would go, for the command to run on the first computer: a USB stick is the usual way over.
  sampleKeyPath() {
    return this.d.platform === 'win32' ? `E:\\${keyHost(this.d.hostname)}.key` : `/media/usb/${keyHost(this.d.hostname)}.key`;
  }

  // What to run on the first computer to make this one's key. The name goes in double quotes, which every
  // shell understands, so it keeps to letters, digits, spaces and a few marks.
  ownerCommand(name, id, out = this.sampleKeyPath()) {
    const label = String(name).replace(/[^\p{L}\p{N} ._()-]/gu, '-').trim() || 'this-computer';
    return `tb runner add "${label}" --out ${quote(out)} --id ${id}`;
  }

  // A Convex cloud address, as the origin the runner can use (lower case, no slash), or a refusal that says
  // what is wanted. `what` names where it came from. The address is never echoed with a name or password in it.
  convexAddress(raw, what) {
    let u;
    try {
      u = new URL(String(raw).trim());
    } catch {
      // not an address at all
    }
    const fine = u && u.protocol === 'https:' && !u.username && !u.password && !u.port && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash && /^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.convex\.cloud$/.test(u.hostname);
    if (fine) return u.origin;
    const shown = oneLine(String(raw).replace(/\/\/[^/@\s]*@/, '//'), 120);
    throw new Fail(`${what} wants a Convex cloud address like https://calm-fox-123.convex.cloud or https://calm-fox-123.ap-southeast-2.convex.cloud, with nothing after the name, not "${shown}". A self-hosted backend can't be joined from here yet (docs/self-hosting.md). Nothing has been changed.`);
  }

  // The words for a key file that can't be used. `hint` says how the first computer makes one.
  keyRefusal(why, file, hint) {
    if (why === 'local') {
      return `${this.runnerKeyFile} holds the main key, not a runner key. That is the key of the computer that owns the backend, or a copy someone made. Joining would replace it, so this refuses. If this is the first computer, you don't want --join here. If it is a second computer that was given a copy, move the file somewhere safe, run this again, then rotate the main key on the first computer (tb runner rotate-owner) so the copy stops working. Nothing has been changed.`;
    }
    if (why === 'file-empty') return `${file} is empty. ${hint} Nothing has been changed.`;
    if (why === 'file-main') return `${file} holds the main key, not a runner key. Don't copy the main key to another computer: delete that copy, and make a runner key for this one on the first computer with tb runner add. Nothing has been changed.`;
    if (why === 'file-deploy') return `${file} holds a Convex deploy key, not a runner key. A deploy key can do anything to the backend, so it doesn't belong on this computer: delete that copy, and make a runner key for this one on the first computer with tb runner add. Nothing has been changed.`;
    return `${file} doesn't hold a runner key (tbr_ and then 64 digits and letters a to f). Nothing has been changed.`;
  }

  // The key file's text, or undefined when it isn't there but a runner key already is (the same command line
  // works again after --delete-key-file). Anything else wrong with it is a refusal that says nothing about its contents.
  readKeyFile(file, local, hint) {
    if (insideFolder(file, this.d.repo)) {
      throw new Fail(`${file} is inside the repository clone, where git could pick it up. Move it somewhere outside the clone and run this again. Nothing has been changed.`);
    }
    // The installed key itself, by any name. It would read as the same key, so the plan would be "keep" and
    // --delete-key-file would delete the computer's only copy: the backend keeps just a hash of it.
    if (sameFile(file, this.runnerKeyFile, this.d.platform)) {
      throw new Fail(`${file} is the runner key this computer already uses (${this.runnerKeyFile}), not a key file from the first computer. --key-file wants the file that tb runner add --out wrote there. Leave this one where it is (deleting it would leave this computer with no key). Nothing has been changed.`);
    }
    const unreadable = (what) => new Fail(`Couldn't read the key file ${file} (${what}). ${hint} Nothing has been changed.`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      if (e.code === 'ENOENT' && local) {
        this.note(`Couldn't find the key file ${file}; using the key already in ${this.runnerKeyFile}`);
        return undefined;
      }
      throw unreadable(e.code ?? 'error');
    }
    if (!stat.isFile()) throw unreadable('it is not a file');
    if (stat.size > 1024) throw new Fail(`${file} is bigger than a key file ever is (over 1 KiB). ${hint} Nothing has been changed.`);
    try {
      return parseKeyText(fs.readFileSync(file));
    } catch (e) {
      throw unreadable(e.code ?? 'error');
    }
  }

  // Step 1 for a computer that joins, once the platform and the data folder are done: everything that can be
  // refused from what is on this computer. So a refusal has asked nothing of the network and changed nothing.
  checkJoin() {
    const { d, v } = this;

    // Admin power over the backend, which a runner key can't keep out: any of the five that tb runner check finds.
    const admin = localAdmin(this.home, d.homedir);
    if (hasAdmin(admin)) {
      let guess = v.url ?? '';
      try {
        guess ||= readRunnerJson(this.home).sync?.url ?? '';
      } catch {
        // a runner.json that can't be read is said below, if it gets that far
      }
      throw new Fail(`Joining needs a computer with no admin power over the backend. ${adminAdvice(admin, 'This computer', String(guess), { rotateAt: 'on the first computer', mac: 'computer', owner: 'the first computer' })} Nothing has been changed.`);
    }

    // The key that is here. Anything but a runner key is the main key or a copy of it, and is never replaced.
    let local = '';
    try {
      local = fs.readFileSync(this.runnerKeyFile, 'utf8').trim();
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Fail(`Couldn't read ${this.runnerKeyFile} (${e.code ?? 'error'}), so this can't tell whether it holds a runner key. Nothing has been changed.`);
    }
    if (joinKeyPlan({ local }).action === 'refuse') throw new Fail(this.keyRefusal('local'));

    const json = this.readRunner();
    if (json.sync?.enabled === false) {
      throw new Fail(`${this.runnerJsonPath} has "sync": { "enabled": false }, so the runner won't use a backend whatever this sets up. Remove that line (or set it to true) and run this again. Nothing has been changed.`);
    }
    this.checkName();
    const name = v.name ?? json.sync?.name ?? shortHost(d.hostname);

    // The backend's address: --url, or the one runner.json has. Two that differ are a refusal: what this computer
    // has already sent stays where it went.
    const given = v.url !== undefined ? this.convexAddress(v.url, '--url') : undefined;
    const saved = typeof json.sync?.url === 'string' && json.sync.url.trim() ? this.convexAddress(json.sync.url, `The sync.url in ${this.runnerJsonPath}`) : undefined;
    if (given && saved && given !== saved) {
      throw new Fail(`${this.runnerJsonPath} already mirrors to ${saved}, not ${given}. What this computer has already sent stays in ${saved}. If you do mean to move to ${given}, take the "url" line out of the "sync" part of that file and run this again. Nothing has been changed.`);
    }
    const url = given ?? saved;
    if (!url) {
      throw new Fail('A joining computer needs the address of the backend the first computer made. Run this again with --url https://<name>.convex.cloud. The address is sync.url in runner.json on the first computer (on Windows: %APPDATA%\\Threadbear\\runner.json, on a Mac or Linux: ~/Library/Application Support/Threadbear/runner.json), and it is on the deployment\'s page in the Convex dashboard. Nothing has been changed.');
    }

    // This computer's runner id: the one runner.json has (the runner makes one when it first starts), which is
    // never changed, or --id when it has none, or (in part one only) a new one made when this runs for real.
    const had = json.sync?.runnerId;
    if (had !== undefined && had !== null && had !== '' && (typeof had !== 'string' || !validRunnerId(had))) {
      throw new Fail(`The sync.runnerId in ${this.runnerJsonPath} (${oneLine(JSON.stringify(had), 80)}) isn't a runner id (1 to 64 letters, digits, - or _, and not "any"). Nothing has been changed.`);
    }
    let id = had || undefined;
    if (v.id !== undefined) {
      if (!validRunnerId(v.id)) throw new Fail(`--id wants a runner id (1 to 64 letters, digits, - or _, and not "any"), not ${JSON.stringify(oneLine(v.id, 80))}.`);
      if (id && v.id !== id) {
        throw new Fail(`--id ${v.id} isn't this computer's runner id: ${this.runnerJsonPath} says it is ${id}, and a runner keeps its id. Make the key for ${id} on the first computer: ${this.ownerCommand(name, id)}. Nothing has been changed.`);
      }
      id = v.id;
    }

    if (d.env.THREADBEAR_SYNC_URL?.trim()) this.warn('THREADBEAR_SYNC_URL is set in this environment, and a runner started with it mirrors to that address instead of the one in runner.json. Unset it unless you mean it.');

    // The key file, if one was named.
    let file;
    let fileText;
    if (v['key-file'] !== undefined) {
      file = path.resolve(expand(v['key-file'], d.homedir));
      fileText = this.readKeyFile(file, local, `On the first computer, ${this.ownerCommand(name, id ?? '<runner id>', file)} writes it.`);
      if (/(^|[\\/])(?:OneDrive|Dropbox|Google Drive)[^\\/]*(?:[\\/]|$)/i.test(file)) {
        this.warn(`The key file ${file} is in a folder that looks synced or backed up (OneDrive, Dropbox or Google Drive), so a copy of the key may already be somewhere else.`);
      }
    }
    const plan = joinKeyPlan({ local, file: fileText });
    if (plan.action === 'refuse') throw new Fail(this.keyRefusal(plan.why, file, `On the first computer, ${this.ownerCommand(name, id ?? '<runner id>', file)} writes it.`));
    // A key doesn't say whose it is, so checking it needs the id it was made for.
    if (plan.action !== 'need' && !id) {
      throw new Fail("This computer has no runner id yet (no sync.runnerId in runner.json), and a runner key doesn't say which runner it is for, so it can't be checked. Run this again with --id and the id the key was made for (tb runner list on the first computer shows it). Nothing has been changed.");
    }
    this.jn = { url, id, hadId: Boolean(had), name, local, file, fileText, plan, fileKept: false };
  }

  // ---- 4. the backend's address, for a computer that joins
  async joinAddress() {
    this.say('4. Backend address');
    const { url } = this.jn;
    let res;
    try {
      res = await this.d.fetch(`${url}/version`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    } catch (e) {
      throw new Fail(this.unreachable(url, e));
    }
    if (!res.ok) throw new Fail(`${url} answered, but it doesn't look like a Convex deployment (HTTP ${res.status}). Check the address against the first computer's runner.json. Nothing has been changed.`);
    this.ok(`${url} answers`);
  }

  // The words for a request that got no answer. A certificate error here is most often a work network that checks
  // HTTPS traffic with a certificate of its own: Node keeps its own list of authorities and ignores the one the
  // system has unless it is asked to use it.
  unreachable(url, e) {
    const said = oneLine(redact([e?.message, e?.cause?.message, e?.cause?.code].filter(Boolean).join(' ')), 200);
    let text = `Couldn't reach ${url} (${said || 'no answer'}). Check your internet connection (and any proxy or VPN), then run this again. Nothing has been changed.`;
    if (/^(?:UNABLE_TO_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|CERT_|ERR_TLS_CERT)/.test(String(e?.cause?.code ?? e?.code ?? ''))) {
      const win = this.d.platform === 'win32';
      text += ` This network may be checking HTTPS traffic (a work proxy). Node doesn't use the ${win ? 'Windows' : "system's"} certificate store unless asked: set NODE_USE_SYSTEM_CA=1 in this terminal (Node 24.6 or newer) and run this again.`;
      if (win) text += ' In PowerShell that is $env:NODE_USE_SYSTEM_CA = "1"; in Command Prompt, set NODE_USE_SYSTEM_CA=1.';
    }
    return text;
  }

  // Asks the backend whether `key` is live and is runner `id`'s: sync:messageHeads, which returns only thread ids
  // and sequence numbers, and fails with kind "auth" for a key it doesn't know or has revoked and "forbidden" for
  // another runner's. A read, so a dry run does it too. Throws a refusal, or returns.
  async verifyKey(url, id, key) {
    const { name, file } = this.jn;
    const command = this.ownerCommand(name, id, file ?? undefined);
    let res;
    try {
      res = await this.d.fetch(`${url}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'sync:messageHeads', args: { key, runnerId: id }, format: 'json' }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Fail(this.unreachable(url, e));
    }
    const body = await res.json().catch(() => undefined);
    if (body?.status === 'success') return;
    const said = oneLine(redact(body?.errorData?.message ?? body?.errorMessage ?? ''), 160);
    const kind = body?.errorData?.kind;
    if (kind === 'auth') {
      throw new Fail(`The backend turned the key down (bad runner key). It was replaced or revoked, or this address isn't the backend that made it. On the first computer, make a new one: ${command} --replace. Nothing has been changed.`);
    }
    if (kind === 'forbidden') {
      const told = said ? `${said}${/[.!?]$/.test(said) ? '' : '.'}` : 'it gave no reason.';
      const remedy = this.jn.hadId ? `On the first computer, make a key for ${id}: ${command}` : `Use the id the key was made for with --id, or make a key for ${id} on the first computer: ${command}`;
      throw new Fail(`That key is for a different runner than ${id}. The backend said: ${told} ${remedy}. Nothing has been changed.`);
    }
    // No such function. Every backend that can make a runner key has this one (it came before runner keys), so this
    // is a Convex deployment that isn't a Threadbear backend: most likely a slip in --url that is still a real name.
    // Nothing is carried on with, or the key would be saved and runner.json pointed at somebody else's deployment.
    if (/could not find (public )?function/i.test(String(body?.errorMessage ?? ''))) {
      throw new Fail(`${url} answers, but it isn't a Threadbear backend: it has no sync:messageHeads, which every backend that makes runner keys has. Check the address against the first computer's runner.json. Nothing has been changed.`);
    }
    if (!body || typeof body !== 'object' || typeof body.status !== 'string') {
      throw new Fail(`${url} answered the key check with something that isn't a Convex reply (HTTP ${res.status}). Check the address against the first computer's runner.json. Nothing has been changed.`);
    }
    throw new Fail(`The backend couldn't check the key (HTTP ${res.status}${said ? `: ${said}` : ''}). Run this again in a minute. Nothing has been changed.`);
  }

  // The key, in a temporary file and then renamed, so the runner never reads half of it. Owner only where the
  // system has modes (a file in a Windows profile already belongs to its user).
  writeSecretAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(file, text, 0o600);
    if (this.d.platform !== 'win32') fs.chmodSync(file, 0o600);
  }

  // ---- 5. the runner key, for a computer that joins
  async joinKey() {
    const { v } = this;
    this.say('5. Runner key');
    const { plan, url, id, local, file, fileText } = this.jn;
    if (plan.action === 'need') {
      this.waiting = true;
      return this.note("no runner key yet: this computer's comes from the first computer (step 9 says how).");
    }
    const key = plan.action === 'keep' ? local : fileText;
    // Before anything is written, whether it is kept, installed or replaces another.
    await this.verifyKey(url, id, key);
    if (plan.action === 'keep') this.ok(`the key already in ${this.runnerKeyFile} is accepted by the backend`);
    else this.ok('the backend accepts the key');
    if (plan.action === 'install' || plan.action === 'replace') {
      this.changed.runnerKey = true;
      if (this.dry) {
        this.todo(plan.action === 'install' ? `write the runner key from ${file} to ${this.runnerKeyFile} (owner only)` : `replace the runner key in ${this.runnerKeyFile} with the one in ${file}: the first computer made it to replace the old one, which no longer works`);
      } else {
        this.writeSecretAtomic(this.runnerKeyFile, `${key}\n`);
        if (this.localKey() !== key) throw new Fail(`Wrote ${this.runnerKeyFile}, but it doesn't read back as the key. Check that nothing else is writing in that folder, then run this again.`);
        this.ok(plan.action === 'install' ? `runner key saved in ${this.runnerKeyFile}` : `runner key in ${this.runnerKeyFile} replaced with the one in ${file}`);
      }
    }
    if (fileText === undefined) return;
    if (!v['delete-key-file']) {
      this.jn.fileKept = true;
      return;
    }
    if (this.dry) return this.todo(`delete ${file} once the key is in place (--delete-key-file)`);
    // Only once the key reads back from secrets/convex-key: the file is then the only other copy.
    if (this.localKey() !== key) throw new Fail(`${this.runnerKeyFile} doesn't hold the key, so ${file} was not deleted.`);
    try {
      fs.rmSync(file);
      this.ok(`deleted ${file}`);
    } catch (e) {
      this.jn.fileKept = true;
      this.note(`couldn't delete ${file} (${e.code ?? 'error'}): delete it yourself, and don't send it anywhere`);
    }
  }

  // ---- 6. runner.json, for a computer that joins
  joinRunnerJson() {
    this.say('6. runner.json');
    const json = this.readRunner();
    const { url, name } = this.jn;
    // Part one on a computer whose runner has never started: the id is made now, and kept, so it is the one
    // the first computer is told. A dry run makes none, so it names none.
    if (!this.jn.id && !this.dry) this.jn.id = crypto.randomBytes(6).toString('hex');
    const { id } = this.jn;
    const next = { ...json, sync: { ...json.sync, url, ...(id ? { runnerId: id } : {}), name } };
    // No id yet in a dry run is a write that the real run will make, even when the address and name are already there.
    if (id && JSON.stringify(next) === JSON.stringify(json)) return this.ok(`${this.runnerJsonPath} as it was (mirrors to ${url} as ${name}, runner ${id})`);
    this.changed.runnerJson = true;
    if (this.dry) return this.todo(`write ${this.runnerJsonPath}: sync.url ${url}, sync.runnerId ${id ?? '(a new one, chosen when this is run for real)'} and sync.name ${name}; everything else in it stays`);
    try {
      writeRunnerJson(this.home, next);
    } catch (e) {
      // In part two the key is already in place by now, so "nothing changed" would not be true.
      if (e instanceof RunnerJsonError) throw new Fail(`${e.message} ${this.waiting ? 'Nothing has been changed.' : 'The runner key is already in place, so run this again once that is fixed.'}`);
      throw e;
    }
    this.ok(`mirrors to ${url} as ${name} (runner ${id})`);
  }

  // ---- 9. what happens next, for a computer that joins
  joinFinish() {
    const { d, v } = this;
    const { url, id, name, file } = this.jn;
    if (this.waiting) {
      this.say('9. Get this computer\'s key');
      const who = id ? `This computer is runner ${id} ("${name}")` : `This computer is a new runner, and its id is chosen when this is run for real ("${name}")`;
      this.note(`${who}. Its key comes from the first computer, which owns the backend. On the first computer, in your own terminal, run:`);
      this.say(`    ${this.ownerCommand(name, id ?? '<shown when run for real>')}`);
      const sample = d.platform === 'win32' ? 'E:' : '/media/usb';
      const care = d.platform === 'win32' ? "Not Desktop or Documents if OneDrive backs them up, and not a Dropbox or shared folder. If tb isn't found there, open a new terminal; the runner task has to have been installed for tb to exist." : "Not a folder that OneDrive, Dropbox or another service syncs, and not a shared one. If tb isn't found there, open a new terminal; the runner has to have been installed for tb to exist.";
      this.note(`(${sample} stands for a USB stick; use the path of yours. ${care})`);
      this.note('Bring that file here (USB stick or your own network, not email or chat), then run:');
      this.say(`    node ${d.platform === 'win32' ? 'scripts\\setup-sync.mjs' : 'scripts/setup-sync.mjs'} --join --url ${url} --key-file <that file>${v.home ? ` --home ${quote(v.home)}` : ''}`);
      return;
    }
    this.say('9. What this computer can do');
    if ((this.changed.runnerJson || this.changed.runnerKey) && !this.restarted) this.note('First restart the runner (step 8), so it reads the new settings.');
    this.note(`This computer is runner ${id} ("${name}") and has a key of its own. It acts as that runner and nothing else: it writes this computer's threads to the backend, but it can't make pairing codes, read the first computer's threads or deploy.`);
    this.note(`To pair a phone or sign a browser in, use Settings > Phone & browser on the first computer. This computer's threads show there as "${name}".`);
    if (this.jn.fileKept) this.note(`${file} is a second copy of the key. Delete it (--delete-key-file does that next time) and don't send it anywhere.`);
    this.note('tb runner check here says if a deploy key or Convex login turns up later.');
    this.note('What this made and how to undo it: docs/pairing.md, "Joining from a second computer".');
  }

  async joinAll() {
    this.say('1. This computer');
    this.checkPlatform();
    this.checkDataFolder('the runner key');
    this.checkJoin();
    this.say();
    this.say('2. Packages');
    this.ok('skipped (a joining computer deploys nothing)');
    this.say();
    this.say('3. Convex login');
    this.ok('skipped (a Convex login can do anything to the deployment, so a joining computer has none)');
    this.say();
    await this.joinAddress();
    this.say();
    await this.joinKey();
    this.say();
    this.joinRunnerJson();
    this.say();
    this.say('7. Backend and website');
    this.ok('skipped (the first computer deploys them)');
    this.say();
    await this.restart();
    this.say();
    this.joinFinish();
    return this.jn.url;
  }

  async all() {
    if (this.v.join) return this.joinAll();
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
        join: { type: 'boolean' },
        url: { type: 'string' },
        'key-file': { type: 'string' },
        id: { type: 'string' },
        'delete-key-file': { type: 'boolean' },
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
  const usage = joinUsageProblem(v);
  if (usage) {
    d.err(`${usage}\n\n${USAGE}`);
    return 2;
  }
  const fail = (e) => {
    if (!(e instanceof Fail)) throw e;
    d.err(`\nFailed: ${e.message}\nFix that and run it again; it carries on from where it stopped.`);
    return 1;
  };
  const title = v.join ? "Threadbear sync setup, joining another computer's backend" : 'Threadbear sync setup';

  if (v['dry-run']) {
    d.say(`${title} (dry run: nothing changes)\n`);
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
    d.say(`${title}\n`);
    for (const l of lines) d.say(l);
    return fail(e);
  }
  if (plan.todos.length) {
    d.say(`${title}\n`);
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
  } else d.say(`${title}\n`);
  try {
    const run = new Setup(d, v, { dry: false, out: d.say });
    await run.all();
    d.say(run.waiting ? '\nPart one done. This computer is waiting for its key (step 9).' : '\nDone.');
    return 0;
  } catch (e) {
    return fail(e);
  }
}

if (!tooOld && ranAsScript()) process.exitCode = await main(process.argv.slice(2));
