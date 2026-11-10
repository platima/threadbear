// scripts/setup-sync.mjs: the Windows and Linux counterpart of the Convex half of setup.mjs
// (docs/pairing.md). It is run here with stand-ins for everything it touches: the Convex
// command line (a small fake that keeps its own idea of what is in the account), git, npm,
// the runner's installer, the person at the keyboard and the clock. Nothing here logs in to
// Convex, makes a project or deploys anything, and no real data folder or Convex login is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';
import { onlyOnWindows, skipOnWindows } from '../helpers/platform.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sync: any = await import(pathToFileURL(path.join(REPO, 'scripts', 'setup-sync.mjs')).href);

const URL_ = 'https://calm-fox-123.ap-southeast-2.convex.cloud';
const DEPLOY_KEY = 'prod:calm-fox-123|SECRETDEPLOYKEYVALUE';
const ACCESS_TOKEN = 'SECRETACCESSTOKENVALUE';

type Call = { file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean; input?: string; verbatim?: boolean };
type Opts = {
  platform?: string;
  repoName?: string;
  packages?: boolean;
  tty?: boolean;
  answers?: string[];
  installed?: boolean;
  teams?: { name: string; slug: string }[];
  exists?: string[];
  env?: NodeJS.ProcessEnv;
  homeWarning?: string;
  startSays?: string[];
  // What `convex login status` fails with (until a login is made), whatever the saved login is.
  statusSays?: string;
};

// A computer with a clone of the repo, a profile folder and a data folder, and an account on the other end.
function world(o: Opts = {}) {
  const root = tmpDir();
  const repo = path.join(root, o.repoName ?? 'repo');
  const profile = path.join(root, 'profile');
  const win = (o.platform ?? 'win32') === 'win32';
  // The data folder is the standard one, which is the one an installed runner uses: %APPDATA%\Threadbear
  // on Windows, and where the runner keeps it on Linux. A test that wants another passes --home.
  const appData = path.join(root, 'AppData', 'Roaming');
  const home = win ? path.join(appData, 'Threadbear') : path.join(profile, 'Library', 'Application Support', 'Threadbear');
  for (const dir of ['convex', 'web', path.join('runner', 'scripts')]) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{}');
  for (const f of ['deploy-backend.mjs', 'install-windows.mjs', 'install-linux.mjs']) fs.writeFileSync(path.join(repo, 'runner', 'scripts', f), '');
  fs.mkdirSync(profile, { recursive: true });
  const convexBin = path.join(repo, 'node_modules', 'convex', 'bin', 'main.js');
  const installPackages = () => {
    fs.mkdirSync(path.dirname(convexBin), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'convex', 'package.json'), JSON.stringify({ name: 'convex', bin: { convex: 'bin/main.js' } }));
    fs.writeFileSync(convexBin, '');
  };
  if (o.packages !== false) installPackages();
  const nodeExec = win ? 'C:\\Program Files\\nodejs\\node.exe' : '/opt/node/bin/node';

  // What is in the Convex account, and what the deployment holds.
  const acct = {
    token: false,
    teams: o.teams ?? [{ name: 'Platima', slug: 'platima' }],
    prod: undefined as string | undefined,
    runnerKey: undefined as string | undefined,
    nextKey: undefined as string | undefined,
    deployed: false,
    installed: o.installed ?? false,
    startSays: [...(o.startSays ?? ['Started the runner.'])],
    gitHead: true,
    statusSays: o.statusSays,
  };
  const calls: Call[] = [];
  const out: string[] = [];
  const errs: string[] = [];
  const answers = [...(o.answers ?? [])];
  const asked: string[] = [];
  const slept: number[] = [];

  const res = (status: number, stdout = '', stderr = '') => ({ status, stdout, stderr });
  const convexFake = (args: string[], call: Call) => {
    const e = call.env ?? {};
    const verb = args.slice(0, 2).join(' ');
    if (verb === 'login status') {
      if (acct.statusSays) return res(1, '', acct.statusSays);
      return acct.token ? res(0, '', `Logged in.\nTeams:\n${acct.teams.map((t) => `  - ${t.name} (${t.slug})`).join('\r\n')}\r\n`) : res(1, '', 'Not logged in.');
    }
    if (args[0] === 'login') {
      acct.token = true;
      acct.statusSays = undefined;
      fs.mkdirSync(path.join(profile, '.convex'), { recursive: true });
      fs.writeFileSync(path.join(profile, '.convex', 'config.json'), JSON.stringify({ accessToken: ACCESS_TOKEN }));
      return res(0);
    }
    if (args[0] === 'dev') {
      assert.ok(acct.token, 'dev needs a login');
      fs.writeFileSync(path.join(repo, '.env.local'), `# Deployment used by \`npx convex dev\`\nCONVEX_DEPLOYMENT=dev:happy-cat-9 # team: ${args[args.indexOf('--team') + 1]}, project: ${args[args.indexOf('--project') + 1]}\n`);
      return res(0);
    }
    if (verb === 'deployment create') {
      if (acct.prod) return res(1, '', 'A production deployment already exists for this project.');
      acct.prod = URL_;
      return res(0, `Created the production deployment ${URL_}\n`);
    }
    if (verb === 'deployment token') {
      const file = args[args.indexOf('--save-env') + 1];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `CONVEX_DEPLOY_KEY=${DEPLOY_KEY}\n`);
      return res(0, 'Saved the deploy key.\n');
    }
    if (verb === 'env get') {
      assert.equal(e.CONVEX_DEPLOY_KEY, DEPLOY_KEY, 'the deployment is picked by the deploy key');
      assert.equal(e.CONVEX_DEPLOYMENT, undefined);
      const value = args[2] === 'RUNNER_KEY' ? acct.runnerKey : acct.nextKey;
      return value ? res(0, `${value}\n`) : res(0, '', `Environment variable "${args[2]}" not found.`);
    }
    if (verb === 'env set') {
      assert.equal(e.CONVEX_DEPLOY_KEY, DEPLOY_KEY);
      acct.runnerKey = call.input;
      return res(0);
    }
    return res(1, '', `fake convex: unexpected ${args.join(' ')}`);
  };

  const spawn = (command: { file: string; args: string[]; windowsVerbatimArguments?: boolean }, opts: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean; input?: string } = {}) => {
    const call: Call = { file: command.file, args: command.args, ...opts, ...(command.windowsVerbatimArguments ? { verbatim: true } : {}) };
    calls.push(call);
    const [first, ...rest] = command.args;
    if (command.file === 'git') return command.args.includes('rev-parse') ? (acct.gitHead ? res(0, 'abc1234\n') : res(128, '', 'fatal: not a git repository')) : res(0, 'git version 2.50.0\n');
    if (/tar(\.exe)?$/i.test(command.file)) return res(0, 'bsdtar 3.8\n');
    if (first === convexBin) return convexFake(rest, call);
    if (first === path.join(repo, 'runner', 'scripts', 'deploy-backend.mjs')) {
      if (rest.includes('--dry-run')) return acct.deployed ? res(0, 'Backend up to date at abc1234.\n') : res(0, 'Would deploy the functions and website at abc1234.\n');
      acct.deployed = true;
      return res(0);
    }
    if (first && /install-(windows|linux)\.mjs$/.test(first)) {
      if (rest[0] === '--installed') return res(acct.installed ? 0 : 1);
      if (rest[0] === '--stop') return res(0, 'Stopped the runner.\n');
      if (rest[0] === '--start') {
        const said = acct.startSays.length > 1 ? acct.startSays.shift()! : acct.startSays[0]!;
        return res(0, `${said}\n`);
      }
    }
    // npm: a node that runs npm-cli.js, npm.cmd through cmd.exe, or npm itself
    if (command.args.some((a) => /npm(-cli\.js|\.cmd)/i.test(a)) || /(^|[\\/])npm$/.test(command.file)) {
      if (/\bci\b/.test(command.args.join(' '))) {
        installPackages();
        return res(0);
      }
      return res(0, '11.0.0\n');
    }
    return res(1, '', `fake: unexpected ${command.file} ${command.args.join(' ')}`);
  };

  // The made-up Node folder of a Windows computer is only what the test says is in it: a real Windows
  // machine (GitHub's, say) has a Node of its own at that very path, with an npm-cli.js beside it.
  const real = (f: string) => !f.startsWith('C:\\Program Files\\nodejs') && fs.existsSync(f);
  // flock is where a Linux machine has it, whatever this one (a Mac, say) does.
  const extra = new Set(['/usr/bin/flock', ...(o.exists ?? [])]);
  const deps = {
    platform: o.platform ?? 'win32',
    arch: 'x64',
    env: { PATH: win ? 'C:\\Windows' : '/usr/bin', ...(win ? { APPDATA: appData } : {}), ...(o.env ?? {}) },
    homedir: profile,
    hostname: 'DESK-PC.local',
    timeZone: 'Australia/Sydney',
    nodeExec,
    nodeVersion: '24.1.0',
    repo,
    exists: (f: string) => real(f) || extra.has(f),
    homeWarning: () => o.homeWarning,
    fetch: async (url: string) => ({ ok: acct.prod !== undefined && url === `${acct.prod}/version` }),
    isTTY: o.tty ?? false,
    spawn,
    ask: async (q: string) => {
      asked.push(q);
      return answers.shift() ?? '';
    },
    sleep: (ms: number) => void slept.push(ms),
    say: (l: string) => void out.push(l),
    err: (l: string) => void errs.push(l),
  };
  const convexCalls = () => calls.filter((c) => c.args[0] === convexBin).map((c) => c.args.slice(1).join(' '));
  const run = (...args: string[]) => sync.main(args, deps) as Promise<number>;
  const text = () => [...out, ...errs].join('\n');
  return { root, repo, profile, home, convexBin, acct, calls, out, errs, asked, slept, deps, run, convexCalls, text, installPackages, answers };
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const MUTATING = /^(login (?!status)|dev|deployment|env set)/;

test('a first run does each step in order, and leaves the keys, runner.json and the deploy where they belong', async () => {
  const w = world({ packages: false, env: { CONVEX_DEPLOYMENT: 'dev:someone-elses-1', CONVEX_DEPLOY_KEY: 'prod:stray|zzz' } });
  const code = await w.run('--yes', '--no-restart', '--home', w.home);
  assert.equal(code, 0, w.text());
  assert.deepEqual(w.convexCalls(), [
    'login --device-name DESK-PC --login-flow poll',
    'login status',
    'dev --once --configure new --project threadbear --dev-deployment cloud --team platima',
    'deployment create production --type prod --default --region aws-ap-southeast-2',
    'deployment token create threadbear-runner-desk-pc --prod --save-env ' + path.join(w.home, 'secrets', 'convex-deploy.env'),
    'env get RUNNER_KEY',
    'env get RUNNER_KEY_NEXT',
    'env set RUNNER_KEY',
  ]);
  // Before login the stray CONVEX_* variables of the person's shell can't pick a deployment either.
  for (const c of w.calls.filter((c) => c.args[0] === w.convexBin && c.args[1] !== 'env')) {
    assert.equal(c.env?.CONVEX_DEPLOYMENT, undefined, c.args.join(' '));
    assert.equal(c.env?.CONVEX_DEPLOY_KEY, undefined, c.args.join(' '));
  }
  // npm ci ran in the clone, with Node's own folder first on the PATH.
  const ci = w.calls.find((c) => c.args.includes('ci'));
  assert.equal(ci?.cwd, w.repo);
  // The deploy key is where the runner's deploy script reads it, and the runner key is the deployment's.
  assert.equal(fs.readFileSync(path.join(w.home, 'secrets', 'convex-deploy.env'), 'utf8').trim(), `CONVEX_DEPLOY_KEY=${DEPLOY_KEY}`);
  const runnerKey = fs.readFileSync(path.join(w.home, 'secrets', 'convex-key'), 'utf8').trim();
  assert.match(runnerKey, /^[0-9a-f]{64}$/);
  assert.equal(w.acct.runnerKey, runnerKey, 'the same key is set as RUNNER_KEY');
  assert.equal(fs.readFileSync(path.join(w.home, 'secrets', 'made-deploy-keys'), 'utf8'), 'threadbear-runner-desk-pc\n');
  assert.deepEqual(readJson(path.join(w.home, 'runner.json')), { sync: { url: URL_, name: 'DESK-PC' } });
  // The deploy got the data folder and the clone as separate arguments, whatever is in their names.
  const deploy = w.calls.find((c) => c.args[0] === path.join(w.repo, 'runner', 'scripts', 'deploy-backend.mjs') && !c.args.includes('--dry-run'));
  assert.deepEqual(deploy?.args.slice(1), ['--home', w.home, '--repo', w.repo]);
  assert.equal(w.acct.deployed, true);
  // The way to pair is the last thing said, and no key or token is ever printed.
  assert.match(w.text(), /Settings > Phone & browser/);
  assert.match(w.text(), /\.convex\.site/);
  for (const secret of [DEPLOY_KEY, 'SECRETDEPLOYKEYVALUE', runnerKey, ACCESS_TOKEN]) assert.ok(!w.text().includes(secret), `${secret.slice(0, 8)} was printed`);
});

test('running it again only checks: no login, project, key or setting is made twice, and nothing is rewritten', async () => {
  const w = world({ packages: false, tty: true });
  assert.equal(await w.run('--yes', '--no-restart', '--home', w.home), 0, w.text());
  const jsonBefore = fs.readFileSync(path.join(w.home, 'runner.json'), 'utf8');
  const keyBefore = fs.readFileSync(path.join(w.home, 'secrets', 'convex-key'), 'utf8');
  const stat = fs.statSync(path.join(w.home, 'runner.json')).mtimeMs;
  w.calls.length = 0;
  w.out.length = 0;
  // No --yes: if it found anything to do it would stop to ask, and this fails the test.
  w.deps.ask = async () => assert.fail('asked a question with nothing to do');
  assert.equal(await w.run('--no-restart', '--home', w.home), 0, w.text());
  assert.deepEqual(w.convexCalls().filter((c) => MUTATING.test(c)), []);
  assert.ok(!w.calls.some((c) => c.args.includes('ci')), 'npm ci is not run again');
  assert.equal(fs.readFileSync(path.join(w.home, 'runner.json'), 'utf8'), jsonBefore);
  assert.equal(fs.readFileSync(path.join(w.home, 'secrets', 'convex-key'), 'utf8'), keyBefore);
  assert.equal(fs.statSync(path.join(w.home, 'runner.json')).mtimeMs, stat, 'runner.json is not even rewritten');
  assert.match(w.text(), /nothing the runner reads was changed in this run/);
  // The deploy script is asked first (and says it is up to date, so there is nothing to ask the person about),
  // then run, and it has nothing to do.
  const deploys = w.calls.filter((c) => c.args[0]?.endsWith('deploy-backend.mjs')).map((c) => c.args.includes('--dry-run'));
  assert.deepEqual(deploys, [true, false]);
  assert.doesNotMatch(w.text(), /\btodo\b/);
});

test('a run that stopped halfway carries on from there', async () => {
  const w = world({ packages: false });
  // The earlier run got as far as a login, a project and a production deployment, then lost the network.
  w.acct.token = true;
  fs.mkdirSync(path.join(w.profile, '.convex'), { recursive: true });
  fs.writeFileSync(path.join(w.profile, '.convex', 'config.json'), JSON.stringify({ accessToken: ACCESS_TOKEN }));
  fs.writeFileSync(path.join(w.repo, '.env.local'), 'CONVEX_DEPLOYMENT=dev:happy-cat-9 # team: platima, project: threadbear\n');
  w.acct.prod = URL_;
  assert.equal(await w.run('--yes', '--no-restart', '--home', w.home), 0, w.text());
  const calls = w.convexCalls();
  assert.ok(!calls.some((c) => c.startsWith('dev ')), 'the project is not made again');
  // Creating the production deployment says it exists; the address is found from the deploy key's name.
  assert.ok(calls.some((c) => c.startsWith('deployment create')));
  assert.equal(readJson(path.join(w.home, 'runner.json')).sync.url, URL_);
  assert.match(w.text(), /may exist already/);
});

test('runner.json is merged into: everything else in it stays, and a name already there is kept', async () => {
  const w = world();
  const before = {
    port: 8797,
    defaults: { cwd: 'D:\\Work', permissionMode: 'auto', models: { claude: 'opus' } },
    accountNotes: { 'claude-2': 'Work only' },
    experiments: { somethingNew: true },
    secretCheck: { enabled: false },
    sync: { runnerId: 'abc123def456', name: 'Study', full: true, pastedPictures: false, site: 'https://calm-fox-123.convex.site' },
    somethingFromANewerRunner: [1, { a: 2 }],
  };
  fs.mkdirSync(w.home, { recursive: true });
  fs.writeFileSync(path.join(w.home, 'runner.json'), JSON.stringify(before, null, 2));
  assert.equal(await w.run('--yes', '--no-restart', '--home', w.home), 0, w.text());
  const after = readJson(path.join(w.home, 'runner.json'));
  assert.deepEqual(after, { ...before, sync: { ...before.sync, url: URL_ } });
  assert.deepEqual(Object.keys(after), Object.keys(before), 'in the same order');
  // --name sets the name on the next run.
  assert.equal(await w.run('--yes', '--no-restart', '--name', 'Desk PC', '--home', w.home), 0, w.text());
  assert.equal(readJson(path.join(w.home, 'runner.json')).sync.name, 'Desk PC');
  assert.equal(readJson(path.join(w.home, 'runner.json')).sync.runnerId, 'abc123def456');
});

for (const [what, text, hint] of [
  ['invalid JSON', '{"sync": {"url": ', /valid JSON/],
  ['an empty file', '', /empty|valid JSON/],
  ['JSON that is not an object', '["sync"]', /not an object/],
  ['a file that starts with a byte order mark', '\uFEFF{"port": 8797}', /byte order mark/],
] as [string, string, RegExp][]) {
  test(`a runner.json that is ${what} is never touched, and nothing is made in Convex`, async () => {
    const w = world({ packages: false });
    fs.mkdirSync(w.home, { recursive: true });
    fs.writeFileSync(path.join(w.home, 'runner.json'), text);
    const code = await w.run('--yes', '--home', w.home);
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(path.join(w.home, 'runner.json'), 'utf8'), text, 'the file is as it was');
    assert.match(w.text(), hint);
    assert.match(w.text(), /Nothing has been changed/);
    assert.ok(w.text().includes(path.join(w.home, 'runner.json')), 'says which file');
    assert.deepEqual(w.convexCalls(), [], 'no Convex command ran');
    assert.ok(!w.calls.some((c) => c.args.includes('ci')), 'no packages were installed');
    assert.equal(fs.existsSync(path.join(w.home, 'secrets')), false);
    assert.equal(fs.existsSync(path.join(w.profile, '.convex')), false);
  });
}

test('it will not turn sync on behind a runner.json that has switched it off', async () => {
  const w = world();
  fs.mkdirSync(w.home, { recursive: true });
  fs.writeFileSync(path.join(w.home, 'runner.json'), '{"sync": {"enabled": false}}');
  assert.equal(await w.run('--yes', '--home', w.home), 1);
  assert.match(w.text(), /"enabled": false/);
  assert.deepEqual(w.convexCalls(), []);
});

test('a self-hosted backend, and a runner key of its own from another computer, are not this script\'s job', async () => {
  const a = world();
  fs.mkdirSync(path.join(a.home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(a.home, 'secrets', 'convex-self-hosted.env'), "CONVEX_SELF_HOSTED_URL='http://127.0.0.1:13210'\nCONVEX_SELF_HOSTED_ADMIN_KEY='x|y'\n");
  assert.equal(await a.run('--yes', '--home', a.home), 1);
  assert.match(a.text(), /self-hosted/);
  assert.match(a.text(), /Mac-only/);
  assert.deepEqual(a.convexCalls(), []);

  const b = world();
  fs.mkdirSync(path.join(b.home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(b.home, 'secrets', 'convex-key'), 'tbr_somethingminted');
  assert.equal(await b.run('--yes', '--home', b.home), 1);
  assert.match(b.text(), /key of this runner's own/);
  assert.deepEqual(b.convexCalls(), []);
});

test('on a Mac it says to use ./threadbear setup, and touches nothing', async () => {
  const w = world({ platform: 'darwin' });
  assert.equal(await w.run('--yes', '--home', w.home), 1);
  assert.match(w.errs.join('\n'), /\.\/threadbear setup/);
  assert.match(w.errs.join('\n'), /Windows and Linux/);
  assert.equal(w.calls.length, 0, 'not even git was asked');
  assert.equal(fs.existsSync(w.home), false);
  // And another system it has no idea about.
  const bsd = world({ platform: 'freebsd' });
  assert.equal(await bsd.run('--yes', '--home', bsd.home), 1);
  assert.match(bsd.errs.join('\n'), /Windows, Linux and macOS/);
});

test('--dry-run prints the plan and changes nothing: no folder, no login, no key, no setting', async () => {
  const w = world({ packages: false, installed: true });
  const code = await w.run('--dry-run', '--home', w.home);
  assert.equal(code, 0, w.text());
  const text = w.text();
  assert.match(text, /dry run: nothing changes/);
  for (const step of [/1\. This computer/, /2\. Packages/, /3\. Convex login/, /4\. Convex project/, /5\. Keys/, /6\. runner\.json/, /7\. Backend and website/, /8\. Restart the runner/, /9\. Pair a phone or a browser/]) assert.match(text, step);
  assert.match(text, /todo {2}npm ci/);
  assert.match(text, /todo {2}log in to Convex/);
  assert.match(text, /todo {2}make a Convex project called "threadbear"/);
  assert.match(text, /todo {2}make the project's production deployment in aws-ap-southeast-2/);
  assert.match(text, /todo {2}a deploy key/);
  assert.match(text, /todo {2}write .*runner\.json: sync\.url \(the new deployment\) and sync\.name DESK-PC/);
  assert.match(text, /todo {2}restart the runner \(its Task Scheduler task\)/);
  assert.match(text, /Dry run done\. Nothing was changed/);
  assert.equal(fs.existsSync(w.home), false, 'no data folder');
  assert.equal(fs.existsSync(path.join(w.profile, '.convex')), false, 'no Convex login');
  assert.equal(fs.existsSync(path.join(w.repo, '.env.local')), false);
  assert.equal(fs.existsSync(path.join(w.repo, 'node_modules')), false, 'no packages');
  // Only looks: version checks, the installer's --installed, and nothing that reaches Convex.
  assert.deepEqual(w.convexCalls(), []);
  assert.ok(!w.calls.some((c) => c.args.includes('ci')));
  assert.ok(!w.calls.some((c) => c.args.some((a) => /^--(stop|start)$/.test(a))));
});

test('a run is shown the plan and asked first, and "no" changes nothing', async () => {
  const w = world({ tty: true, answers: ['n'] });
  assert.equal(await w.run('--home', w.home), 0, w.text());
  assert.equal(w.asked.length, 1);
  assert.match(w.asked[0], /Go ahead\?/);
  assert.match(w.text(), /This will:\n {2}- /);
  assert.match(w.text(), /Nothing was changed/);
  assert.equal(fs.existsSync(w.home), false);
  assert.deepEqual(w.convexCalls(), []);
});

test('with no terminal and no --yes it does not guess', async () => {
  const w = world({ tty: false });
  assert.equal(await w.run('--home', w.home), 1);
  assert.match(w.errs.join('\n'), /--yes/);
  assert.equal(fs.existsSync(w.home), false);
  assert.deepEqual(w.convexCalls(), []);
});

test('a data folder outside the profile is warned about before anything is written, and needs a yes', async () => {
  const warning = 'The data folder D:\\Shared\\Threadbear is outside your user profile folder (C:\\Users\\me), so other people who use this PC may be able to read the runner\'s token and secrets there.';
  const w = world({ tty: false, homeWarning: warning });
  assert.equal(await w.run('--home', w.home), 1);
  assert.match(w.text(), /Take care: The data folder D:\\Shared\\Threadbear is outside your user profile/);
  assert.equal(fs.existsSync(path.join(w.home, 'secrets')), false);
});

test('a Windows npm.cmd is started through cmd.exe with its folder quoted, and npm-cli.js with node', async () => {
  const cmdPath = 'C:\\Program Files\\nodejs\\npm.cmd';
  const a = world({ packages: false, exists: [cmdPath], env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
  assert.equal(await a.run('--yes', '--no-restart', '--home', a.home), 0, a.text());
  const ci = a.calls.find((c) => c.verbatim && c.args.some((x) => x.includes(' ci')))!;
  assert.equal(ci.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(ci.args, ['/d', '/s', '/c', `""${cmdPath}" ci --no-audit --no-fund"`]);

  const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  const b = world({ packages: false, exists: [cli] });
  assert.equal(await b.run('--yes', '--no-restart', '--home', b.home), 0, b.text());
  const direct = b.calls.find((c) => c.args.includes('ci'))!;
  assert.equal(direct.file, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(direct.args, [cli, 'ci', '--no-audit', '--no-fund']);
  assert.ok(!direct.verbatim);
  // Node's folder is first on the PATH it runs with.
  assert.match(String(direct.env?.PATH ?? direct.env?.Path), /^C:\\Program Files\\nodejs;/);
});

test('a clone in a folder with spaces and brackets is passed whole to everything it runs', async () => {
  const w = world({ repoName: 'Y - Third Party (new)', packages: false });
  assert.equal(await w.run('--yes', '--no-restart', '--home', path.join(w.root, 'My Data (x)')), 0, w.text());
  assert.ok(w.repo.includes(' (new)'));
  const dev = w.calls.find((c) => c.args[1] === 'dev')!;
  assert.equal(dev.cwd, w.repo);
  const deploy = w.calls.find((c) => c.args[0].endsWith('deploy-backend.mjs') && !c.args.includes('--dry-run'))!;
  assert.deepEqual(deploy.args.slice(1), ['--home', path.join(w.root, 'My Data (x)'), '--repo', w.repo]);
  for (const c of w.calls) assert.ok(!c.verbatim || !c.args[3]?.includes(w.repo), 'the clone is never put in a cmd.exe line');
});

test('more than one Convex team: asked on a terminal, listed when nobody can be asked, or given with --team', async () => {
  const teams = [{ name: 'Platima', slug: 'platima' }, { name: 'Work', slug: 'work-team' }];
  const none = world({ packages: false, teams });
  assert.equal(await none.run('--yes', '--home', none.home), 1);
  assert.match(none.errs.join('\n'), /2 teams.*--team and one of: platima \(Platima\), work-team \(Work\)/);
  assert.ok(!none.convexCalls().some((c) => c.startsWith('dev')), 'no project was made');

  const given = world({ packages: false, teams });
  assert.equal(await given.run('--yes', '--no-restart', '--team', 'work-team', '--project', 'My Bear', '--home', given.home), 0, given.text());
  assert.ok(given.convexCalls().includes('dev --once --configure new --project My Bear --dev-deployment cloud --team work-team'));

  const asked = world({ packages: false, teams, tty: true, answers: ['y', '2'] });
  assert.equal(await asked.run('--no-restart', '--home', asked.home), 0, asked.text());
  assert.ok(asked.convexCalls().some((c) => c.endsWith('--team work-team')));
  assert.match(asked.text(), /1\. Platima \(platima\)\n\s+2\. Work \(work-team\)/);
});

test('a clone that already points at a project uses it; one that points at a different project stops', async () => {
  const same = world({ packages: false });
  fs.writeFileSync(path.join(same.repo, '.env.local'), 'CONVEX_DEPLOYMENT=dev:old-owl-5 # team: platima, project: threadbear-2\n');
  same.acct.token = true;
  fs.mkdirSync(path.join(same.profile, '.convex'), { recursive: true });
  fs.writeFileSync(path.join(same.profile, '.convex', 'config.json'), JSON.stringify({ accessToken: ACCESS_TOKEN }));
  assert.equal(await same.run('--yes', '--no-restart', '--home', same.home), 0, same.text());
  assert.ok(!same.convexCalls().some((c) => c.startsWith('dev')));
  assert.match(same.text(), /this clone already has a Convex project/);

  const other = world({ packages: false });
  fs.writeFileSync(path.join(other.repo, '.env.local'), 'CONVEX_DEPLOYMENT=dev:old-owl-5 # team: platima, project: my-other-app\n');
  assert.equal(await other.run('--yes', '--home', other.home), 1);
  assert.match(other.errs.join('\n'), /points at the Convex project my-other-app.*--project my-other-app.*delete \.env\.local/);
  assert.deepEqual(other.convexCalls(), []);
  // Saying so on purpose is allowed.
  other.acct.token = true;
  fs.mkdirSync(path.join(other.profile, '.convex'), { recursive: true });
  fs.writeFileSync(path.join(other.profile, '.convex', 'config.json'), JSON.stringify({ accessToken: ACCESS_TOKEN }));
  assert.equal(await other.run('--yes', '--no-restart', '--project', 'my-other-app', '--home', other.home), 0, other.text());
});

test('a runner.json that already names a deployment is kept; a deploy key for another one is refused', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(w.home, 'runner.json'), JSON.stringify({ sync: { url: URL_, name: 'Desk' } }));
  fs.writeFileSync(path.join(w.home, 'secrets', 'convex-deploy.env'), `CONVEX_DEPLOY_KEY=${DEPLOY_KEY}\n`);
  w.acct.token = true;
  w.acct.prod = URL_;
  fs.mkdirSync(path.join(w.profile, '.convex'), { recursive: true });
  fs.writeFileSync(path.join(w.profile, '.convex', 'config.json'), JSON.stringify({ accessToken: ACCESS_TOKEN }));
  assert.equal(await w.run('--yes', '--no-restart', '--home', w.home), 0, w.text());
  assert.match(w.text(), new RegExp(`using ${URL_.replaceAll('.', '\\.')}`));
  assert.ok(!w.convexCalls().some((c) => /^(dev|deployment)/.test(c)));

  const wrong = world();
  fs.mkdirSync(path.join(wrong.home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(wrong.home, 'runner.json'), JSON.stringify({ sync: { url: 'https://other-bird-777.convex.cloud' } }));
  fs.writeFileSync(path.join(wrong.home, 'secrets', 'convex-deploy.env'), `CONVEX_DEPLOY_KEY=${DEPLOY_KEY}\n`);
  assert.equal(await wrong.run('--yes', '--home', wrong.home), 1);
  assert.match(wrong.errs.join('\n'), /calm-fox-123.*other-bird-777/);
});

test("a deployment's own RUNNER_KEY is copied, never replaced; a local key goes up if the deployment has none", async () => {
  const has = world({ packages: false });
  has.acct.runnerKey = 'the-deployments-own-key';
  assert.equal(await has.run('--yes', '--no-restart', '--home', has.home), 0, has.text());
  assert.equal(fs.readFileSync(path.join(has.home, 'secrets', 'convex-key'), 'utf8'), 'the-deployments-own-key');
  assert.ok(!has.convexCalls().includes('env set RUNNER_KEY'), 'RUNNER_KEY is left as it is');
  assert.ok(!has.text().includes('the-deployments-own-key'));

  const local = world({ packages: false });
  fs.mkdirSync(path.join(local.home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(local.home, 'secrets', 'convex-key'), 'my-local-main-key\n');
  assert.equal(await local.run('--yes', '--no-restart', '--home', local.home), 0, local.text());
  assert.equal(local.acct.runnerKey, 'my-local-main-key');
  assert.equal(fs.readFileSync(path.join(local.home, 'secrets', 'convex-key'), 'utf8'), 'my-local-main-key\n', 'the file is not rewritten');

  // A main key being rotated is not for this script to touch.
  const rotating = world({ packages: false });
  rotating.acct.runnerKey = 'old';
  rotating.acct.nextKey = 'new';
  assert.equal(await rotating.run('--yes', '--home', rotating.home), 1);
  assert.match(rotating.errs.join('\n'), /being rotated/);
  assert.doesNotMatch(rotating.errs.join('\n'), /run setup/);
});

test('secrets are written for their owner alone where the platform has modes', skipOnWindows('NTFS has no modes: a file in the profile is already private (platform.ts, chmodSafe)'), async () => {
  const w = world({ platform: 'linux', packages: false });
  assert.equal(await w.run('--yes', '--no-restart', '--home', w.home), 0, w.text());
  for (const f of ['convex-key', 'convex-deploy.env', 'made-deploy-keys']) {
    assert.equal(fs.statSync(path.join(w.home, 'secrets', f)).mode & 0o777, 0o600, f);
  }
  assert.equal(fs.statSync(path.join(w.home, 'secrets')).mode & 0o777, 0o700);
});

test('Linux: the data folder is the runner\'s own, and flock is needed', async () => {
  const w = world({ platform: 'linux', packages: false });
  assert.equal(await w.run('--dry-run'), 0, w.text());
  assert.ok(w.text().includes(path.join(w.profile, 'Library', 'Application Support', 'Threadbear')));
  assert.match(w.text(), /ok {4}Linux x64/);
  // /usr/bin/flock is what the deploy takes; without one it says so (a Linux box that has it passes above).
  const noFlock = world({ platform: 'linux', packages: false });
  noFlock.deps.exists = (f: string) => !/flock$/.test(f) && fs.existsSync(f);
  assert.equal(await noFlock.run('--dry-run', '--home', noFlock.home), 1);
  assert.match(noFlock.errs.join('\n'), /flock/);
});

test('Windows: with no --home the data folder is %APPDATA%\\Threadbear', async () => {
  const w = world({ platform: 'win32', packages: false, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } });
  assert.equal(await w.run('--dry-run'), 0, w.text());
  assert.ok(w.text().includes('C:\\Users\\me\\AppData\\Roaming\\Threadbear'), w.text());
});

test('restarting the runner: stop then start with --yes, the commands to run by hand without', async () => {
  const yes = world({ installed: true, startSays: ['The runner is already running.', 'Started the runner.'] });
  assert.equal(await yes.run('--yes', '--home', yes.home), 0, yes.text());
  const flags = yes.calls.filter((c) => /install-windows\.mjs$/.test(c.args[0] ?? '')).map((c) => c.args[1]);
  assert.deepEqual(flags.filter((f) => f !== '--installed'), ['--stop', '--start', '--start'], 'stopped once, and started again until it said it had');
  assert.deepEqual(yes.slept, [3000, 3000]);
  assert.match(yes.text(), /ok {4}the runner restarted/);
  assert.doesNotMatch(yes.text(), /First restart the runner/);

  const no = world({ installed: true, repoName: 'repo (with spaces)' });
  assert.equal(await no.run('--yes', '--no-restart', '--home', no.home), 0, no.text());
  assert.ok(!no.calls.some((c) => c.args.includes('--stop')), 'not stopped');
  const script = path.join(no.repo, 'runner', 'scripts', 'install-windows.mjs');
  assert.match(no.text(), /Not restarting \(--no-restart\)/);
  assert.ok(no.text().includes(`node "${script}" --stop`));
  assert.ok(no.text().includes(`node "${script}" --start`));
  // `tb restart` is not offered: from a terminal it refuses a runner that has no release.json, which an
  // installed Windows or Linux runner has not (runner/src/tb-dev.ts, restartRefusal). The Runners page waits for idle.
  assert.doesNotMatch(no.text(), /tb restart/);
  assert.match(no.text(), /Runners page, which waits until no thread is busy/);
  assert.match(no.text(), /First restart the runner \(step 8\)/);

  const none = world({ installed: false });
  assert.equal(await none.run('--yes', '--home', none.home), 0, none.text());
  assert.match(none.text(), /No Task Scheduler task for the runner was found/);
  assert.ok(!none.calls.some((c) => c.args.includes('--stop')));
});

test('a runner installed here is restarted only when --home is the folder it uses; another folder is left alone', async () => {
  // The installed task or service runs with the standard data folder. A run for another folder must not
  // end it (it would cut short what its threads are doing) and then say the runner restarted.
  const other = (w: ReturnType<typeof world>) => path.join(w.root, 'another runner data');
  const touched = (w: ReturnType<typeof world>) => w.calls.filter((c) => /install-(windows|linux)\.mjs$/.test(c.args[0] ?? ''));

  const w = world({ installed: true });
  assert.equal(await w.run('--yes', '--home', other(w)), 0, w.text());
  assert.deepEqual(touched(w), [], 'the installer was not run at all: not --installed, not --stop, not --start');
  assert.match(w.text(), /uses the standard data folder/);
  assert.ok(w.text().includes(`THREADBEAR_HOME set to ${other(w)}`), w.text());
  assert.doesNotMatch(w.text(), /the runner restarted/);
  assert.match(w.text(), /First restart the runner \(step 8\)/, 'the end still says the runner has to be restarted');

  // The same by the environment variable, with no --home.
  const fromEnv = world({ installed: true });
  (fromEnv.deps.env as NodeJS.ProcessEnv).THREADBEAR_HOME = other(fromEnv);
  assert.equal(await fromEnv.run('--yes'), 0, fromEnv.text());
  assert.deepEqual(touched(fromEnv), []);
  assert.match(fromEnv.text(), /uses the standard data folder/);

  // The plan does not promise a restart it will not do.
  const dry = world({ installed: true });
  assert.equal(await dry.run('--dry-run', '--home', other(dry)), 0, dry.text());
  assert.doesNotMatch(dry.text(), /todo {2}restart the runner/);

  // The standard folder, named out loud, is the same folder.
  const same = world({ installed: true });
  assert.equal(await same.run('--yes', '--home', same.home), 0, same.text());
  assert.ok(touched(same).some((c) => c.args[1] === '--stop'), 'stopped');
  assert.match(same.text(), /ok {4}the runner restarted/);

  // On Linux too.
  const linux = world({ platform: 'linux', installed: true });
  assert.equal(await linux.run('--yes', '--home', other(linux)), 0, linux.text());
  assert.deepEqual(touched(linux), []);
  assert.match(linux.text(), /systemd user service/);
});

test('inside a Threadbear thread the installed runner is never stopped: it says how to restart it from outside, and the plan promises no restart', async () => {
  // Stopping the runner a thread runs on ends the script before it starts the runner again, and the thread's
  // turn with it (runner/scripts/install-runner.sh refuses the real runner from any thread for the same reason).
  const touched = (w: ReturnType<typeof world>) => w.calls.filter((c) => /install-(windows|linux)\.mjs$/.test(c.args[0] ?? ''));
  for (const [platform, name] of [['win32', 'THREADBEAR_THREAD_ID'], ['linux', 'THREADBEAR_THREAD_ID'], ['win32', 'THREADBARE_THREAD_ID']] as const) {
    const w = world({ platform, installed: true, env: { [name]: 'a1b2c3d4' } });
    assert.equal(await w.run('--yes', '--home', w.home), 0, `${platform} ${name}: ${w.text()}`);
    assert.deepEqual(touched(w), [], `${platform} ${name}: the installer was not run at all: not --installed, not --stop, not --start`);
    assert.match(w.text(), /Not restarting: this is running inside a Threadbear thread/);
    assert.match(w.text(), /Runners page, which waits until no thread is busy/);
    assert.match(w.text(), /from a terminal outside any thread/);
    assert.ok(w.text().includes(`install-${platform === 'win32' ? 'windows' : 'linux'}.mjs" --stop`) || w.text().includes(`install-${platform === 'win32' ? 'windows' : 'linux'}.mjs --stop`), 'the commands are given');
    assert.doesNotMatch(w.text(), /the runner restarted/);
    assert.match(w.text(), /First restart the runner \(step 8\)/, 'the end still says the runner has to be restarted');
  }

  // The plan promises no restart, in a dry run or in the list a run is asked about.
  const env = { THREADBEAR_THREAD_ID: 'a1b2c3d4' };
  const dry = world({ installed: true, env });
  assert.equal(await dry.run('--dry-run', '--home', dry.home), 0, dry.text());
  assert.doesNotMatch(dry.text(), /todo {2}restart the runner/);
  assert.match(dry.text(), /Not restarting: this is running inside a Threadbear thread/);
  const onTty = world({ installed: true, tty: true, answers: ['y'], env });
  assert.equal(await onTty.run('--home', onTty.home), 0, onTty.text());
  assert.deepEqual(onTty.asked.map((q) => q.replace(/\s+$/, '')), ['Go ahead? [y/N]'], 'asked once, about the plan, and never about restarting');
  assert.deepEqual(onTty.out.filter((l) => /^ {2}- /.test(l) && /restart/i.test(l)), [], 'no restart in the list of what it will do');
  assert.deepEqual(touched(onTty), []);

  // A thread of a runner that uses another folder: the folder's runner is not the installed one, so that note stands.
  const other = world({ installed: true, env });
  assert.equal(await other.run('--yes', '--home', path.join(other.root, 'another runner data')), 0, other.text());
  assert.match(other.text(), /uses the standard data folder/);
  assert.deepEqual(touched(other), []);
});

test('a Node older than 24 is told what to install, before the runner\'s TypeScript is read', async () => {
  assert.equal(sync.oldNodeMessage('24.0.0'), undefined);
  assert.equal(sync.oldNodeMessage('25.2.1'), undefined);
  assert.equal(sync.oldNodeMessage('26.0.0'), undefined);
  for (const version of ['22.18.0', '20.11.1', '18.20.4', '9.9.9', 'not a version']) {
    const message = sync.oldNodeMessage(version) as string;
    assert.match(message, new RegExp(`^Node ${version.replace(/\./g, '\\.')} is too old: Threadbear needs Node 24 or newer\\. Install it from https://nodejs\\.org`), version);
    assert.match(message, /node --version/);
  }
  // main() says it for a Node that is handed in, and touches nothing.
  const w = world();
  w.deps.nodeVersion = '22.18.0';
  assert.equal(await w.run('--yes', '--home', w.home), 1);
  assert.match(w.errs.join('\n'), /Failed: Node 22\.18\.0 is too old/);
  assert.equal(w.calls.length, 0, 'nothing was run');
  assert.equal(fs.existsSync(w.home), false);
});

test('run as a program on a Node that cannot read .ts files: it says what to install, not ERR_UNKNOWN_FILE_EXTENSION', (t) => {
  // Node 20 and 22 before 22.18 cannot load the .ts files in runner/src. Here the same is made by switching
  // type stripping off, with a preload that makes this Node say it is 20.11.1: no second Node is needed.
  const probe = spawnSync(process.execPath, ['--no-experimental-strip-types', '-e', '0'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip(`this Node has no --no-experimental-strip-types switch: ${probe.stderr.trim().split('\n')[0]}`);
  const dir = tmpDir();
  const preload = path.join(dir, 'pretend-old-node.mjs');
  fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: '20.11.1' });\n");
  const script = path.join(REPO, 'scripts', 'setup-sync.mjs');
  const old = ['--no-experimental-strip-types', '--import', pathToFileURL(preload).href];
  const r = spawnSync(process.execPath, [...old, script, '--dry-run'], { cwd: REPO, encoding: 'utf8', env: process.env, timeout: 60_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Failed: Node 20\.11\.1 is too old: Threadbear needs Node 24 or newer\. Install it from https:\/\/nodejs\.org/);
  assert.doesNotMatch(r.stderr, /ERR_UNKNOWN_FILE_EXTENSION|\n\s+at /, 'no stack trace');
  assert.equal(r.stdout, '', 'nothing else was said or done');

  // Imported by something else on that Node, it throws the same words and loads nothing.
  const code = `import(${JSON.stringify(pathToFileURL(script).href)}).then(() => console.log('loaded'), (e) => console.log(e.message));`;
  const imported = spawnSync(process.execPath, [...old, '--input-type=module', '-e', code], { cwd: REPO, encoding: 'utf8', env: process.env, timeout: 60_000 });
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /^Node 20\.11\.1 is too old: Threadbear needs Node 24 or newer\./);
});

// A saved login, and the deployment's other half of it, as a person who has run this before has.
function saveLogin(w: ReturnType<typeof world>) {
  w.acct.token = true;
  fs.mkdirSync(path.join(w.profile, '.convex'), { recursive: true });
  fs.writeFileSync(path.join(w.profile, '.convex', 'config.json'), JSON.stringify({ accessToken: ACCESS_TOKEN }));
}

test('a saved login that cannot be checked because the network is down is left alone: no forced browser login', async () => {
  const downs = [
    'Error: getaddrinfo ENOTFOUND api.convex.dev',
    'connect ECONNREFUSED 104.18.0.1:443',
    'TypeError: fetch failed',
    'Error: connect ETIMEDOUT 104.18.0.1:443',
    'Error: getaddrinfo EAI_AGAIN api.convex.dev',
    'Error: read ECONNRESET',
    'Error: socket hang up',
    'Error: A network error occurred',
  ];
  for (const says of downs) {
    const w = world({ statusSays: says });
    saveLogin(w);
    assert.equal(await w.run('--yes', '--no-restart', '--home', w.home), 1, `${says}: ${w.text()}`);
    assert.match(w.errs.join('\n'), /Couldn't reach Convex to check the saved login/, says);
    assert.match(w.errs.join('\n'), /internet connection/, says);
    assert.doesNotMatch(w.text(), /didn't accept the saved login/, says);
    assert.deepEqual(w.convexCalls().filter((c) => MUTATING.test(c)), [], `${says}: nothing was made or logged in`);
    assert.equal(w.convexCalls().some((c) => /--force/.test(c)), false);
    assert.equal(readJson(path.join(w.profile, '.convex', 'config.json')).accessToken, ACCESS_TOKEN, 'the saved login is as it was');
    assert.equal(fs.existsSync(path.join(w.home, 'runner.json')), false, 'runner.json was not written');
  }
  // Anything else Convex says is still a login it did not accept: it logs in again, with --force.
  const w = world({ statusSays: 'Error: Unauthorized: this access token is no longer valid.' });
  saveLogin(w);
  assert.equal(await w.run('--yes', '--no-restart', '--home', w.home), 0, w.text());
  assert.match(w.text(), /Convex didn't accept the saved login \(.*Unauthorized/);
  assert.ok(w.convexCalls().includes('login --device-name DESK-PC --login-flow poll --force'), w.convexCalls().join(' | '));
  // Said in a dry run too: there it never asks Convex, so it is not a worry.
  const dry = world({ statusSays: 'Error: getaddrinfo ENOTFOUND api.convex.dev' });
  saveLogin(dry);
  assert.equal(await dry.run('--dry-run', '--home', dry.home), 0, dry.text());
  assert.deepEqual(dry.convexCalls().filter((c) => c.startsWith('login')), []);
});

test('what looks like the network being down, and what does not', () => {
  for (const yes of ['getaddrinfo ENOTFOUND api.convex.dev', 'ECONNREFUSED', 'ETIMEDOUT', 'fetch failed', 'EAI_AGAIN', 'ENETUNREACH', 'Network request failed', 'socket hang up']) assert.equal(sync.looksOffline(yes), true, yes);
  for (const no of ['', 'Not logged in.', 'Unauthorized: this access token is no longer valid.', 'Logged in.\nTeams:\n  - My Team (my-team)', undefined]) assert.equal(sync.looksOffline(no), false, String(no));
});

test('a deploy key already in the data folder, with no address anywhere, is used: another deployment is not made to go with it', async () => {
  const login = (w: ReturnType<typeof world>) => {
    w.acct.token = true;
    fs.mkdirSync(path.join(w.profile, '.convex'), { recursive: true });
    fs.writeFileSync(path.join(w.profile, '.convex', 'config.json'), JSON.stringify({ accessToken: ACCESS_TOKEN }));
    fs.mkdirSync(path.join(w.home, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(w.home, 'secrets', 'convex-deploy.env'), `CONVEX_DEPLOY_KEY=${DEPLOY_KEY}\n`);
  };
  // The deployment can be found from the key's name: it is the one used.
  const found = world({ packages: false });
  login(found);
  found.acct.prod = URL_;
  assert.equal(await found.run('--yes', '--no-restart', '--home', found.home), 0, found.text());
  assert.ok(!found.convexCalls().some((c) => /^(dev|deployment)/.test(c)), `no project or deployment was made: ${found.convexCalls().join(' | ')}`);
  assert.equal(readJson(path.join(found.home, 'runner.json')).sync.url, URL_);
  assert.match(found.text(), /is for https:\/\/calm-fox-123\.ap-southeast-2\.convex\.cloud: using that deployment, not making another/);
  assert.equal(found.acct.deployed, true);

  // It cannot: nothing is made and nothing is written, and it says what to put where.
  const lost = world({ packages: false });
  login(lost);
  assert.equal(await lost.run('--yes', '--no-restart', '--home', lost.home), 1);
  assert.match(lost.errs.join('\n'), /already a deploy key in .*convex-deploy\.env, for the deployment calm-fox-123/);
  assert.match(lost.errs.join('\n'), /"sync": \{ "url": "https:\/\/calm-fox-123\.convex\.cloud" \}/);
  assert.ok(!lost.convexCalls().some((c) => /^(dev|deployment|env set)/.test(c)));
  assert.equal(fs.existsSync(path.join(lost.home, 'runner.json')), false, 'runner.json was not written');
  assert.equal(fs.readFileSync(path.join(lost.home, 'secrets', 'convex-deploy.env'), 'utf8'), `CONVEX_DEPLOY_KEY=${DEPLOY_KEY}\n`, 'the key is as it was');
});

test("a runner key that is already here is planned for, not skipped: replacing it with the deployment's, or setting it on one that has none, needs a yes", async () => {
  const keyFile = (w: ReturnType<typeof world>) => path.join(w.home, 'secrets', 'convex-key');
  const w = world({ packages: false });
  assert.equal(await w.run('--yes', '--no-restart', '--home', w.home), 0, w.text());
  const mine = fs.readFileSync(keyFile(w), 'utf8');
  // Up to date: nothing is planned and nothing is asked.
  assert.equal(await w.run('--no-restart', '--home', w.home), 0, w.text());
  assert.doesNotMatch(w.text().split('Threadbear sync setup').at(-1) ?? '', /This will:/);

  // The deployment has another key of its own: it would win and replace this one.
  w.acct.runnerKey = 'the-deployments-other-key';
  const before = w.calls.length;
  assert.equal(await w.run('--no-restart', '--home', w.home), 1, 'no terminal and no --yes: it stops and asks for neither');
  assert.match(w.errs.join('\n'), /Not asking, as there is no terminal/);
  assert.match(w.text(), /This will:\n {2}- replace the runner key in .*convex-key with the deployment's own RUNNER_KEY/);
  assert.equal(fs.readFileSync(keyFile(w), 'utf8'), mine, 'the key is as it was');
  assert.ok(!w.calls.slice(before).some((c) => c.args.includes('set')), 'nothing was set on the deployment');
  assert.equal(await w.run('--dry-run', '--home', w.home), 0);
  assert.equal(fs.readFileSync(keyFile(w), 'utf8'), mine, 'a dry run changes nothing');
  assert.equal(await w.run('--yes', '--no-restart', '--home', w.home), 0, w.text());
  assert.equal(fs.readFileSync(keyFile(w), 'utf8'), 'the-deployments-other-key', 'with a yes it is replaced');

  // The deployment has none: this one would be set on it.
  const x = world({ packages: false });
  assert.equal(await x.run('--yes', '--no-restart', '--home', x.home), 0, x.text());
  const keep = fs.readFileSync(keyFile(x), 'utf8');
  x.acct.runnerKey = undefined;
  x.errs.length = 0;
  x.out.length = 0;
  assert.equal(await x.run('--no-restart', '--home', x.home), 1);
  assert.match(x.text(), /This will:\n {2}- set the runner key in .*convex-key as RUNNER_KEY on the deployment, which has none/);
  assert.equal(x.acct.runnerKey, undefined, 'RUNNER_KEY was not set');
  assert.equal(await x.run('--yes', '--no-restart', '--home', x.home), 0, x.text());
  assert.equal(x.acct.runnerKey, keep.trim(), 'with a yes it is set');
  assert.equal(fs.readFileSync(keyFile(x), 'utf8'), keep, 'the local file is as it was');

  // A first run, a key in the data folder already, and no deploy key yet: the plan says what will happen to it.
  const first = world({ packages: false });
  fs.mkdirSync(path.join(first.home, 'secrets'), { recursive: true });
  fs.writeFileSync(keyFile(first), 'my-local-main-key\n');
  assert.equal(await first.run('--dry-run', '--home', first.home), 0, first.text());
  assert.match(first.text(), /todo {2}the runner key already in .*convex-key: the deployment's own RUNNER_KEY replaces it/);
});

test('on a terminal it asks before ending the runner, and "no" leaves it running', async () => {
  const w = world({ installed: true, tty: true, answers: ['y', 'n'] });
  assert.equal(await w.run('--home', w.home), 0, w.text());
  assert.equal(w.asked.length, 2);
  assert.match(w.asked[1], /Restart the runner now\?.*cut short/);
  assert.ok(!w.calls.some((c) => c.args.includes('--stop')));
  assert.match(w.text(), /Not restarting\. To make the runner read the new settings/);
});

test('on Linux the runner is restarted through its systemd service, with the server install named too', async () => {
  const w = world({ platform: 'linux', installed: true });
  assert.equal(await w.run('--yes', '--home', w.home), 0, w.text());
  const flags = w.calls.filter((c) => /install-linux\.mjs$/.test(c.args[0] ?? '')).map((c) => c.args[1]);
  assert.deepEqual(flags.filter((f) => f !== '--installed'), ['--stop', '--start']);
  const help = world({ platform: 'linux' });
  assert.equal(await help.run('--yes', '--no-restart', '--home', help.home), 0, help.text());
  assert.match(help.text(), /systemctl --user restart com\.mikerosoft\.threadbear\.runner\.service/);
});

test('a bad flag is a usage error, and --help prints the usage', async () => {
  const w = world();
  assert.equal(await w.run('--bogus'), 2);
  assert.match(w.errs.join('\n'), /node scripts\/setup-sync\.mjs/);
  assert.equal(await w.run('--team', 'not a slug!', '--dry-run', '--home', w.home), 1);
  assert.match(w.errs.join('\n'), /--team wants a team slug/);
  const h = world();
  assert.equal(await h.run('--help'), 0);
  assert.match(h.out.join('\n'), /--no-restart/);
  assert.equal(h.calls.length, 0);
});

test('what the Convex command line prints is read for teams and for the clone\'s project, and keys are taken out of messages', () => {
  assert.deepEqual(sync.parseTeams('Logged in as me\r\nTeams:\r\n  - My Team (my-team)\r\n  - Work (work)\r\n'), [{ name: 'My Team', slug: 'my-team' }, { name: 'Work', slug: 'work' }]);
  assert.deepEqual(sync.parseTeams(''), []);
  assert.deepEqual(sync.parseEnvLocal('# note\nCONVEX_DEPLOYMENT=dev:happy-cat-9 # team: my-team, project: threadbear\n'), { deployment: 'dev:happy-cat-9', team: 'my-team', project: 'threadbear' });
  assert.deepEqual(sync.parseEnvLocal('CONVEX_DEPLOYMENT=dev:happy-cat-9\n'), { deployment: 'dev:happy-cat-9' });
  assert.equal(sync.parseEnvLocal('CONVEX_URL=https://x.convex.cloud\n'), undefined);
  assert.equal(sync.nearestRegion('Australia/Perth'), 'aws-ap-southeast-2');
  assert.equal(sync.nearestRegion('Europe/Paris'), 'aws-eu-west-1');
  assert.equal(sync.nearestRegion('America/New_York'), undefined);
  const hex = 'a'.repeat(64);
  assert.equal(sync.redact(`bad key prod:calm-fox-123|abc+/=DEF and tbr_abc_def and ${hex}`), 'bad key [key] and [key] and [key]');
});

// ---- the script itself, as a program

function runScript(args: string[], env: NodeJS.ProcessEnv, cwd = REPO, script = path.join(REPO, 'scripts', 'setup-sync.mjs')) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });
}

const ON_A_MAC = process.platform === 'darwin';

test('run as a program: --dry-run prints the plan and changes nothing (on a Mac it says to use ./threadbear setup), and --help and a bad flag answer', () => {
  const root = tmpDir();
  // A profile and data folder of its own: the real ones are never looked at.
  const profile = path.join(root, 'profile');
  const home = path.join(root, 'data folder (test)');
  fs.mkdirSync(profile, { recursive: true });
  const env = { USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(profile, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(profile, '.config'), THREADBEAR_HOME: '', THREADBEAR_DATA_DIR: '' };
  const dry = runScript(['--dry-run', '--home', home], env);
  if (ON_A_MAC) {
    assert.equal(dry.status, 1, dry.stdout + dry.stderr);
    assert.match(dry.stderr, /\.\/threadbear setup/);
  } else {
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /Threadbear sync setup \(dry run: nothing changes\)/);
    assert.match(dry.stdout, /9\. Pair a phone or a browser/);
    assert.match(dry.stdout, /Dry run done\. Nothing was changed/);
  }
  assert.equal(fs.existsSync(home), false, 'the data folder was not made');
  assert.equal(fs.existsSync(path.join(profile, '.convex')), false, 'no Convex login was made');
  const help = runScript(['--help'], env);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--no-restart/);
  const bad = runScript(['--nope'], env);
  assert.equal(bad.status, 2);
});

test('run as a program: lowercase or odd spellings of its own path still run it', onlyOnWindows('Windows paths are not case-sensitive'), () => {
  const lower = path.join(REPO, 'scripts', 'setup-sync.mjs').toLowerCase();
  const r = runScript(['--help'], {}, REPO, lower);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--dry-run/);
});

test('it needs nothing installed: a copy of the script and the runner sources with no node_modules still starts', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'setup-sync.mjs'), path.join(root, 'scripts', 'setup-sync.mjs'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'runner-key-plan.mjs'), path.join(root, 'scripts', 'runner-key-plan.mjs'));
  fs.cpSync(path.join(REPO, 'runner', 'src'), path.join(root, 'runner', 'src'), { recursive: true });
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const env = { USERPROFILE: profile, HOME: profile, APPDATA: profile, LOCALAPPDATA: profile };
  const r = runScript(['--dry-run', '--home', path.join(root, 'data')], env, root, path.join(root, 'scripts', 'setup-sync.mjs'));
  // It gets as far as noticing that this is not a git clone (on a Mac, that it is a Mac), which it
  // can only say if every import loaded.
  assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, ON_A_MAC ? /\.\/threadbear setup/ : /isn't a git clone/);
});
