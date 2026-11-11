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
  // false: a folder with no .git, convex/ or web/, as a Download ZIP of the repository or an unpacked copy is.
  clone?: boolean;
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
  for (const dir of [...(o.clone === false ? [] : ['convex', 'web']), path.join('runner', 'scripts')]) fs.mkdirSync(path.join(repo, dir), { recursive: true });
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
    gitHead: o.clone !== false,
    statusSays: o.statusSays,
    // The runner keys the deployment knows (tb runner add made them), by key.
    runnerKeys: new Map<string, { runnerId: string; live: boolean }>(),
    // The network failing: on the version check, on the key check, or on either. code is the error's cause.
    net: undefined as undefined | { on: 'version' | 'query' | 'any'; message: string; code?: string },
    // What the backend says to the key check instead of its usual answer.
    queryReply: undefined as undefined | ((body: { path: string; args: { key: string; runnerId: string } }) => { ok: boolean; status: number; json: () => Promise<unknown> }),
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

  // The network: the deployment's /version (the first computer's backend) and its /api/query, which
  // answers sync:messageHeads for the runner keys in acct.runnerKeys the way convex/lib.ts does (auth for a
  // key it doesn't know or has revoked, forbidden for another runner's). Every request is recorded.
  const fetched: { url: string; method: string; body?: string }[] = [];
  const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    fetched.push({ url, method, ...(init.body !== undefined ? { body: init.body } : {}) });
    const isQuery = method === 'POST';
    if (acct.net && (acct.net.on === 'any' || acct.net.on === (isQuery ? 'query' : 'version'))) {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(acct.net.message), acct.net.code ? { code: acct.net.code } : {}) });
    }
    if (!isQuery) return reply(acct.prod !== undefined && url === `${acct.prod}/version` ? 200 : 404, '1.0.0');
    if (acct.prod === undefined || url !== `${acct.prod}/api/query`) return reply(404, undefined);
    const body = JSON.parse(init.body ?? '{}') as { path: string; args: { key: string; runnerId: string } };
    if (acct.queryReply) return acct.queryReply(body);
    assert.equal(body.path, 'sync:messageHeads', 'the key is checked with a read that returns no text');
    const row = acct.runnerKeys.get(body.args.key);
    if (!row?.live) return reply(560, { status: 'error', errorMessage: '[Request ID: 1] Server Error', errorData: { kind: 'auth', message: 'bad runner key' } });
    if (row.runnerId !== body.args.runnerId) return reply(560, { status: 'error', errorMessage: '[Request ID: 2] Server Error', errorData: { kind: 'forbidden', message: `This runner's key can't act as runner ${body.args.runnerId}.` } });
    return reply(200, { status: 'success', value: [] });
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
    fetch,
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
  return { root, repo, profile, home, convexBin, acct, calls, out, errs, asked, slept, deps, run, convexCalls, text, installPackages, answers, fetched };
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
  // It says what that means for this computer, rather than leaving it at "nothing to set up".
  assert.match(b.text(), /this computer has joined that backend and has nothing to set up\. To check the key or give it a new one, run this with --join\./);
  assert.deepEqual(b.convexCalls(), []);
});

test('a runner.json that already names a backend, with no deploy key here and no linked clone, stops at step 1, before the plan promises packages or a login', async () => {
  // A computer that mirrors to a backend somebody else made (it has the address and nothing to deploy with).
  // The plan pass always refused it, so nothing was ever installed or logged in, but only at step 4: after
  // the list had said "todo npm ci" and "todo log in to Convex", which is what the person reads in the
  // failure. Now it stops at step 1 and says only why.
  for (const flags of [['--yes'], ['--dry-run']]) {
    const w = world({ packages: false });
    fs.mkdirSync(w.home, { recursive: true });
    const text = JSON.stringify({ sync: { url: URL_, runnerId: 'abc123def456' } });
    fs.writeFileSync(path.join(w.home, 'runner.json'), text);
    assert.equal(await w.run(...flags, '--home', w.home), 1, w.text());
    assert.match(w.errs.join('\n'), new RegExp(`runner\\.json already mirrors to ${URL_.replaceAll('.', '\\.')}`));
    assert.match(w.errs.join('\n'), /Either remove the "url" line/);
    assert.match(w.errs.join('\n'), /If this is a second computer joining a backend the first one made, run it with --join\./);
    assert.doesNotMatch(w.text(), /npm ci|log in to Convex|2\. Packages|3\. Convex login/, 'nothing about packages or a login is promised first');
    assert.deepEqual(w.convexCalls(), [], 'no Convex command ran, so no login either');
    assert.ok(!w.calls.some((c) => c.args.includes('ci')), 'no packages were installed');
    assert.equal(fs.existsSync(path.join(w.profile, '.convex')), false);
    assert.equal(fs.readFileSync(path.join(w.home, 'runner.json'), 'utf8'), text, 'runner.json is as it was');
  }
  // With a deploy key, or a clone linked to its project, it carries on as before.
  const keyed = world({ packages: false });
  fs.mkdirSync(path.join(keyed.home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(keyed.home, 'runner.json'), JSON.stringify({ sync: { url: URL_ } }));
  fs.writeFileSync(path.join(keyed.home, 'secrets', 'convex-deploy.env'), `CONVEX_DEPLOY_KEY=${DEPLOY_KEY}\n`);
  keyed.acct.token = true;
  fs.mkdirSync(path.join(keyed.profile, '.convex'), { recursive: true });
  fs.writeFileSync(path.join(keyed.profile, '.convex', 'config.json'), JSON.stringify({ accessToken: ACCESS_TOKEN }));
  assert.equal(await keyed.run('--yes', '--no-restart', '--home', keyed.home), 0, keyed.text());
  const linked = world({ packages: false });
  fs.mkdirSync(linked.home, { recursive: true });
  fs.writeFileSync(path.join(linked.home, 'runner.json'), JSON.stringify({ sync: { url: URL_ } }));
  fs.writeFileSync(path.join(linked.repo, '.env.local'), 'CONVEX_DEPLOYMENT=dev:old-owl-5 # team: platima, project: threadbear\n');
  linked.acct.token = true;
  fs.mkdirSync(path.join(linked.profile, '.convex'), { recursive: true });
  fs.writeFileSync(path.join(linked.profile, '.convex', 'config.json'), JSON.stringify({ accessToken: ACCESS_TOKEN }));
  assert.equal(await linked.run('--yes', '--no-restart', '--home', linked.home), 0, linked.text());
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

  // --join needs no git, clone, convex/ or web/ either. It gets as far as reading the key file, which is
  // refused (not a runner key) before anything is asked of the network, so this makes no request.
  const badKey = path.join(tmpDir(), 'not-a-key.key');
  fs.writeFileSync(badKey, 'not a key\n');
  const j = runScript(['--join', '--dry-run', '--url', URL_, '--key-file', badKey, '--home', path.join(root, 'data')], env, root, path.join(root, 'scripts', 'setup-sync.mjs'));
  assert.doesNotMatch(j.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
  assert.equal(j.status, 1, j.stdout + j.stderr);
  assert.match(j.stderr, ON_A_MAC ? /\.\/threadbear setup --existing/ : /doesn't hold a runner key/);
  assert.doesNotMatch(j.stdout + j.stderr, /\bgit\b/i, 'no git, so none asked for');
  assert.equal(fs.existsSync(path.join(root, 'data')), false, 'a dry run makes nothing');
});

// ---------------------------------------------------------------- --join: a second computer joining the first one's backend
//
// The first computer owns the backend. This one gets a runner key from it (tb runner add --out, in a file) and
// nothing else: no Convex login, deploy key, project, packages or git. The backend is a fake that knows the runner
// keys in acct.runnerKeys and answers the key check the way convex/lib.ts would.

const RK = 'tbr_' + 'ab12'.repeat(16);
const RK2 = 'tbr_' + 'cd34'.repeat(16);
const MAIN_KEY = 'f0e1'.repeat(16);
const RUNNER_ID = 'abc123def456';

type World = ReturnType<typeof world>;

// A copy that is not a clone (a Download ZIP, say), with the first computer's backend on the other end.
function joinWorld(o: Opts = {}): World {
  const w = world({ clone: false, packages: false, ...o });
  w.acct.prod = URL_;
  return w;
}
const joinAt = (w: World, home: string, ...args: string[]) => w.run('--join', '--url', URL_, '--home', home, ...args);
const join = (w: World, ...args: string[]) => joinAt(w, w.home, ...args);
const forget = (w: World) => {
  for (const list of [w.out, w.errs, w.calls, w.fetched, w.asked]) list.length = 0;
};
function keyFile(w: World, content: string | Buffer, ...where: string[]): string {
  const file = path.join(w.root, ...(where.length ? where : ['usb', 'work-pc.key']));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const convexKey = (w: World) => path.join(w.home, 'secrets', 'convex-key');
const runnerJsonOf = (w: World) => path.join(w.home, 'runner.json');
const seedJson = (w: World, sync: Record<string, unknown> = { runnerId: RUNNER_ID, name: 'Work PC' }, extra: Record<string, unknown> = {}) => {
  fs.mkdirSync(w.home, { recursive: true });
  fs.writeFileSync(runnerJsonOf(w), JSON.stringify({ ...extra, sync }, null, 2));
};
const installerCalls = (w: World) => w.calls.filter((c) => /install-(windows|linux)\.mjs$/.test(c.args[0] ?? '')).map((c) => c.args[1]);
// Part one, as a person runs it: the runner id it made is the one the first computer would be given.
async function partOne(w: World, ...args: string[]): Promise<string> {
  assert.equal(await join(w, '--yes', ...args), 0, w.text());
  const id = readJson(runnerJsonOf(w)).sync.runnerId as string;
  forget(w);
  return id;
}
// Every file under some folders with its size and time, so "nothing changed" can be told from "rewritten the same".
function tree(...dirs: string[]): string {
  const rows: string[] = [];
  const walk = (dir: string, base: string) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      const s = fs.statSync(p);
      if (s.isDirectory()) {
        rows.push(`${path.relative(base, p)}/`);
        walk(p, base);
      } else rows.push(`${path.relative(base, p)} ${s.size} ${s.mtimeMs}`);
    }
  };
  for (const d of dirs) {
    rows.push(`# ${d}`);
    walk(d, d);
  }
  return rows.join('\n');
}
const asRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('join, part one: records the address and a runner id, says what to run on the first computer, and writes no key', async () => {
  const w = joinWorld({ installed: true });
  assert.equal(await join(w, '--name', 'Work PC', '--yes'), 0, w.text());
  const sync = readJson(runnerJsonOf(w)).sync;
  assert.deepEqual(Object.keys(sync), ['url', 'runnerId', 'name']);
  assert.equal(sync.url, URL_);
  assert.equal(sync.name, 'Work PC');
  assert.match(sync.runnerId, /^[0-9a-f]{12}$/);
  const text = w.text();
  assert.match(text, /Threadbear sync setup, joining another computer's backend/);
  for (const step of [
    /1\. This computer/,
    /2\. Packages\n {2}ok {4}skipped \(a joining computer deploys nothing\)/,
    /3\. Convex login\n {2}ok {4}skipped \(a Convex login can do anything to the deployment, so a joining computer has none\)/,
    /4\. Backend address/,
    /5\. Runner key/,
    /6\. runner\.json/,
    /7\. Backend and website\n {2}ok {4}skipped \(the first computer deploys them\)/,
    /8\. Restart the runner\n {2}ok {4}not needed yet: the runner has no key to use until it is in/,
  ]) assert.match(text, step);
  assert.match(text, new RegExp(`This computer is runner ${sync.runnerId} \\("Work PC"\\)\\. Its key comes from the first computer, which owns the backend\\. On the first computer, in your own terminal, run:`));
  assert.ok(w.out.includes(`    tb runner add "Work PC" --out E:\\desk-pc.key --id ${sync.runnerId}`), text);
  assert.match(text, /\(E: stands for a USB stick; use the path of yours\. Not Desktop or Documents if OneDrive backs them up, and not a Dropbox or shared folder\. If tb isn't found there, open a new terminal; the runner task has to have been installed for tb to exist\.\)/);
  assert.match(text, new RegExp(`Bring that file here \\(USB stick or your own network, not email or chat\\), then run:\\n {4}node scripts\\\\setup-sync\\.mjs --join --url ${asRegExp(URL_)} --key-file <that file>`));
  assert.match(text, /Part one done\. This computer is waiting for its key \(step 9\)\./);
  assert.doesNotMatch(text, /\nDone\./);
  assert.equal(fs.existsSync(path.join(w.home, 'secrets')), false, 'no key yet, so no secrets folder');
  // Only the address is asked of the network, and there is no key to send: once for the plan, once for the run.
  assert.deepEqual(w.fetched, [{ url: `${URL_}/version`, method: 'GET' }, { url: `${URL_}/version`, method: 'GET' }]);
  // The runner is not touched (it has no key to use yet), and nothing else is run: no git, npm, tar or Convex command.
  assert.deepEqual(w.calls, []);
});

test('join, part one: an id already in runner.json is kept, a name too, and everything else in it stays', async () => {
  const w = joinWorld();
  const before = { port: 8797, defaults: { cwd: 'D:\\Work', models: { claude: 'opus' } }, sync: { runnerId: RUNNER_ID, name: 'Study', pastedPictures: false }, somethingFromANewerRunner: [1, { a: 2 }] };
  fs.mkdirSync(w.home, { recursive: true });
  fs.writeFileSync(runnerJsonOf(w), JSON.stringify(before, null, 2));
  assert.equal(await join(w, '--yes'), 0, w.text());
  const after = readJson(runnerJsonOf(w));
  assert.deepEqual(after, { ...before, sync: { ...before.sync, url: URL_ } });
  assert.deepEqual(Object.keys(after), Object.keys(before), 'in the same order');
  assert.ok(w.out.some((l) => l.startsWith(`    tb runner add "Study" --out `) && l.endsWith(` --id ${RUNNER_ID}`)), w.text());
  // --name renames it, and the id is still the one it had.
  forget(w);
  assert.equal(await join(w, '--yes', '--name', 'Work PC'), 0, w.text());
  assert.equal(readJson(runnerJsonOf(w)).sync.name, 'Work PC');
  assert.equal(readJson(runnerJsonOf(w)).sync.runnerId, RUNNER_ID);
  // Run again with nothing new: nothing is written, nothing is asked.
  const stat = fs.statSync(runnerJsonOf(w)).mtimeMs;
  forget(w);
  assert.equal(await join(w), 0, w.text());
  assert.equal(fs.statSync(runnerJsonOf(w)).mtimeMs, stat);
  assert.match(w.text(), /runner\.json as it was/);
  assert.match(w.text(), new RegExp(`--id ${RUNNER_ID}`), 'the same instructions again');
});

test('join, part one with --dry-run: no id it would make is named, and nothing is made, not even the data folder', async () => {
  const w = joinWorld();
  assert.equal(await join(w, '--dry-run'), 0, w.text());
  const text = w.text();
  assert.match(text, /Threadbear sync setup, joining another computer's backend \(dry run: nothing changes\)/);
  assert.match(text, /todo {2}make the data folder/);
  assert.match(text, new RegExp(`todo {2}write .*runner\\.json: sync\\.url ${asRegExp(URL_)}, sync\\.runnerId \\(a new one, chosen when this is run for real\\) and sync\\.name DESK-PC; everything else in it stays`));
  assert.match(text, /This computer is a new runner, and its id is chosen when this is run for real \("DESK-PC"\)\. Its key comes from the first computer/);
  assert.match(text, /--id <shown when run for real>/);
  assert.match(text, /Dry run done\. Nothing was changed/);
  assert.equal(fs.existsSync(w.home), false);
  assert.deepEqual(w.fetched.map((f) => `${f.method} ${f.url}`), [`GET ${URL_}/version`], 'the address is looked at; that is a read');
  assert.deepEqual(w.calls, []);
  // With an id already in runner.json it is named.
  const x = joinWorld();
  seedJson(x);
  assert.equal(await join(x, '--dry-run'), 0, x.text());
  assert.match(x.text(), new RegExp(`--id ${RUNNER_ID}`));
  assert.doesNotMatch(x.text(), /shown when run for real|a new runner id/);
});

test('join, part two: the backend checks the key, then it is installed, runner.json and the runner follow, and the key is shown nowhere', async () => {
  const w = joinWorld({ installed: true, clone: false });
  const id = await partOne(w, '--name', 'Work PC');
  w.acct.runnerKeys.set(RK, { runnerId: id, live: true });
  const file = keyFile(w, RK + '\n');
  assert.equal(await join(w, '--key-file', file, '--yes'), 0, w.text());
  // The key, and only the key, is in secrets: written to a temporary file and renamed, so none is left.
  assert.equal(fs.readFileSync(convexKey(w), 'utf8'), RK + '\n');
  assert.deepEqual(fs.readdirSync(path.join(w.home, 'secrets')), ['convex-key']);
  assert.equal(fs.readFileSync(file, 'utf8'), RK + '\n', 'the file it was given is left as it was');
  assert.deepEqual(Object.keys(readJson(runnerJsonOf(w))), ['sync']);
  assert.match(w.text(), /ok {4}the backend accepts the key/);
  assert.match(w.text(), /ok {4}runner key saved in .*convex-key/);
  assert.deepEqual(installerCalls(w).filter((f) => f !== '--installed'), ['--stop', '--start']);
  assert.match(w.text(), /ok {4}the runner restarted/);
  assert.match(w.text(), /\nDone\./);
  assert.doesNotMatch(w.text(), /Part one done/);
  // What this computer can and cannot do.
  assert.match(w.text(), new RegExp(`This computer is runner ${id} \\("Work PC"\\) and has a key of its own\\. It acts as that runner and nothing else: it writes this computer's threads to the backend, but it can't make pairing codes, read the first computer's threads or deploy\\.`));
  assert.match(w.text(), /To pair a phone or sign a browser in, use Settings > Phone & browser on the first computer\. This computer's threads show there as "Work PC"\./);
  assert.ok(w.text().includes(`${file} is a second copy of the key. Delete it (--delete-key-file does that next time) and don't send it anywhere.`));
  assert.match(w.text(), /tb runner check here says if a deploy key or Convex login turns up later\./);
  assert.match(w.text(), /docs\/pairing\.md, "Joining from a second computer"/);
  // The only network calls: the address, and the key check, each once for the plan and once for the run. The key
  // is in the body of the check and nowhere else: not in an address, not in anything printed.
  assert.deepEqual(w.fetched.filter((f) => f.method === 'GET').map((f) => f.url), [`${URL_}/version`, `${URL_}/version`]);
  const checks = w.fetched.filter((f) => f.method === 'POST');
  assert.equal(checks.length, 2);
  for (const c of checks) {
    assert.equal(c.url, `${URL_}/api/query`);
    assert.deepEqual(JSON.parse(c.body ?? ''), { path: 'sync:messageHeads', args: { key: RK, runnerId: id }, format: 'json' });
  }
  for (const f of w.fetched) assert.ok(!f.url.includes(RK) && !f.url.includes(RK.slice(4)), f.url);
  for (const secret of [RK, RK.slice(4)]) assert.ok(!w.text().includes(secret), 'the key was printed');
  // No git, npm, tar, Convex command or deploy: only the installer's own checks of the runner.
  assert.deepEqual(w.calls.filter((c) => !/install-(windows|linux)\.mjs$/.test(c.args[0] ?? '')), []);
  assert.deepEqual(w.convexCalls(), []);
  assert.equal(fs.existsSync(path.join(w.repo, '.git')), false);
  assert.equal(fs.existsSync(path.join(w.repo, 'convex')) || fs.existsSync(path.join(w.repo, 'web')), false, 'a copy with no clone, convex/ or web/ is enough');
  assert.equal(fs.existsSync(path.join(w.home, 'convex-deploy.env')) || fs.existsSync(path.join(w.profile, '.convex')) || fs.existsSync(path.join(w.repo, 'node_modules')), false);
});

test('join, part two with the id given and no part one: --id is what the key was made for', async () => {
  const w = joinWorld();
  w.acct.runnerKeys.set(RK, { runnerId: 'bench-pc_01', live: true });
  assert.equal(await join(w, '--yes', '--no-restart', '--id', 'bench-pc_01', '--key-file', keyFile(w, RK)), 0, w.text());
  assert.deepEqual(readJson(runnerJsonOf(w)).sync, { url: URL_, runnerId: 'bench-pc_01', name: 'DESK-PC' });
  assert.equal(fs.readFileSync(convexKey(w), 'utf8'), RK + '\n', 'a file with no newline gets one');
});

test('join, run again: nothing is rewritten, nothing is asked, the runner is left alone, and it works with the key file gone', async () => {
  const w = joinWorld({ installed: true, tty: true });
  const id = await partOne(w);
  w.acct.runnerKeys.set(RK, { runnerId: id, live: true });
  const file = keyFile(w, RK + '\n');
  assert.equal(await join(w, '--key-file', file, '--yes'), 0, w.text());
  const before = tree(w.home);
  forget(w);
  w.deps.ask = async () => assert.fail('asked a question with nothing to do');
  assert.equal(await join(w, '--key-file', file), 0, w.text());
  assert.equal(tree(w.home), before, 'neither the key nor runner.json was rewritten');
  assert.match(w.text(), /runner\.json as it was/);
  assert.match(w.text(), /ok {4}the key already in .*convex-key is accepted by the backend/);
  assert.match(w.text(), /nothing the runner reads was changed in this run/);
  assert.doesNotMatch(w.text(), /\btodo\b/);
  assert.deepEqual(installerCalls(w), [], 'the runner was not touched');
  // The key checked again: it is cheap, and says if it has been revoked since.
  assert.equal(w.fetched.filter((f) => f.method === 'POST').length, 2);
  // The key file gone (a stick taken out, or --delete-key-file last time): the key already here is used.
  fs.rmSync(file);
  forget(w);
  assert.equal(await join(w, '--key-file', file), 0, w.text());
  assert.match(w.text(), /Couldn't find the key file .*work-pc\.key; using the key already in .*convex-key/);
  assert.equal(tree(w.home), before);
  forget(w);
  assert.equal(await join(w), 0, w.text());
  assert.equal(tree(w.home), before);
});

test('join, part two with --dry-run: the backend is asked to check the key, and nothing is changed or started', async () => {
  const w = joinWorld({ installed: true });
  const id = await partOne(w);
  w.acct.runnerKeys.set(RK, { runnerId: id, live: true });
  const file = keyFile(w, RK + '\n');
  const before = tree(w.home);
  assert.equal(await join(w, '--key-file', file, '--dry-run', '--delete-key-file'), 0, w.text());
  assert.match(w.text(), /todo {2}write the runner key from .*work-pc\.key to .*convex-key \(owner only\)/);
  assert.match(w.text(), /todo {2}delete .*work-pc\.key once the key is in place \(--delete-key-file\)/);
  assert.match(w.text(), /todo {2}restart the runner \(its Task Scheduler task\)/);
  assert.equal(tree(w.home), before);
  assert.equal(fs.existsSync(file), true);
  assert.equal(w.fetched.filter((f) => f.method === 'POST').length, 1, 'the key was checked, which is a read');
  assert.deepEqual(installerCalls(w).filter((f) => f !== '--installed'), []);
  assert.match(w.text(), /Dry run done\. Nothing was changed/);
});

// The five things tb runner check looks for beside a runner key: a computer with any of them is not joined.
const ADMIN_ITEMS: [string, (w: World) => void, RegExp][] = [
  ["setup's deploy key", (w) => keyFile(w, `CONVEX_DEPLOY_KEY=${DEPLOY_KEY}\n`, 'AppData', 'Roaming', 'Threadbear', 'secrets', 'convex-deploy.env'), /secrets\/convex-deploy\.env/],
  ["a self-hosted backend's admin key", (w) => keyFile(w, "CONVEX_SELF_HOSTED_URL='http://127.0.0.1:13210'\nCONVEX_SELF_HOSTED_ADMIN_KEY='x|y'\n", 'AppData', 'Roaming', 'Threadbear', 'secrets', 'convex-self-hosted.env'), /secrets\/convex-self-hosted\.env/],
  ['a Convex team token', (w) => keyFile(w, 'team-token-value', 'AppData', 'Roaming', 'Threadbear', 'secrets', 'convex-team-token'), /secrets\/convex-team-token/],
  ["the Convex panel's deploy key", (w) => keyFile(w, JSON.stringify({ name: 'threadbear-panel-desk-abc123', adminKey: 'prod:secret' }), 'AppData', 'Roaming', 'Threadbear', 'secrets', 'convex-panels', 'calm-fox-123.json'), /the Convex panel's deploy key threadbear-panel-desk-abc123/],
  ['a Convex CLI login', (w) => keyFile(w, '{}', 'profile', '.convex', 'config.json'), /a Convex CLI login \(~\/\.convex\/config\.json\)/],
];

for (const [what, make, shows] of ADMIN_ITEMS) {
  test(`join refuses a computer that has ${what}, with nothing changed, nothing asked of the network and no override`, async () => {
    for (const part of ['one', 'two'] as const) {
      const w = joinWorld({ installed: true });
      make(w);
      seedJson(w);
      w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
      const file = keyFile(w, RK + '\n');
      const before = tree(w.home, w.profile);
      assert.equal(await join(w, '--yes', ...(part === 'two' ? ['--key-file', file] : [])), 1, `${what}, part ${part}: ${w.text()}`);
      const said = w.errs.join('\n');
      assert.match(said, /Joining needs a computer with no admin power over the backend\. This computer also has /);
      assert.match(said, shows);
      assert.match(said, /Any of them can do anything to the deployment/);
      assert.match(said, /3\. Then rotate the main key, which they could read: tb runner rotate-owner on the first computer\. Only the first computer needs any of these\. Nothing has been changed\./);
      assert.doesNotMatch(said, /\bMac\b/, 'a Windows or Linux computer is not called a Mac');
      assert.deepEqual(w.fetched, []);
      assert.deepEqual(w.calls, []);
      assert.equal(tree(w.home, w.profile), before);
      assert.equal(fs.existsSync(convexKey(w)), false);
      for (const secret of [DEPLOY_KEY, 'SECRETDEPLOYKEYVALUE', 'prod:secret', RK]) assert.ok(!w.text().includes(secret), `${secret.slice(0, 8)} was printed`);
    }
  });
}

test('join names every admin item the computer has, and the dashboard page of the deployment it would join', async () => {
  const w = joinWorld();
  seedJson(w);
  for (const [, make] of ADMIN_ITEMS) make(w);
  assert.equal(await join(w, '--yes'), 1, w.text());
  const said = w.errs.join('\n');
  for (const [what, , shows] of ADMIN_ITEMS) assert.match(said, shows, what);
  assert.match(said, /https:\/\/dashboard\.convex\.dev\/d\/calm-fox-123\/settings/);
  assert.match(said, /npx convex deployment token delete threadbear-panel-desk-abc123 --deployment calm-fox-123/);
});

test('join: a main key in secrets/convex-key is never replaced, with or without a key file', async () => {
  for (const local of [MAIN_KEY + '\n', 'my-local-main-key\n']) {
    for (const withFile of [false, true]) {
      const w = joinWorld();
      seedJson(w);
      fs.mkdirSync(path.join(w.home, 'secrets'), { recursive: true });
      fs.writeFileSync(convexKey(w), local);
      w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
      const before = tree(w.home);
      assert.equal(await join(w, '--yes', ...(withFile ? ['--key-file', keyFile(w, RK + '\n')] : [])), 1, w.text());
      const said = w.errs.join('\n');
      assert.match(said, /convex-key holds the main key, not a runner key\. That is the key of the computer that owns the backend, or a copy someone made\. Joining would replace it, so this refuses\./);
      assert.match(said, /If this is the first computer, you don't want --join here\. If it is a second computer that was given a copy, move the file somewhere safe, run this again, then rotate the main key on the first computer \(tb runner rotate-owner\) so the copy stops working\. Nothing has been changed\./);
      assert.equal(fs.readFileSync(convexKey(w), 'utf8'), local);
      assert.equal(tree(w.home), before);
      assert.deepEqual(w.fetched, []);
      assert.ok(!w.text().includes(MAIN_KEY) && !w.text().includes('my-local-main-key'), 'the key was printed');
    }
  }
  // It is said before anything about the key file or the address, so a missing file is not "using the key already here".
  const w = joinWorld();
  fs.mkdirSync(path.join(w.home, 'secrets'), { recursive: true });
  fs.writeFileSync(convexKey(w), MAIN_KEY);
  assert.equal(await w.run('--join', '--url', 'https://example.com', '--yes', '--home', w.home, '--key-file', path.join(w.root, 'usb', 'gone.key')), 1);
  assert.match(w.errs.join('\n'), /convex-key holds the main key, not a runner key/);
  assert.doesNotMatch(w.text(), /using the key already in|wants a Convex cloud address/);
});

const BAD_KEY_FILES: [string, (w: World) => string, RegExp][] = [
  ['missing', (w) => path.join(w.root, 'usb', 'nope.key'), /Couldn't read the key file .*nope\.key \(ENOENT\)\. On the first computer, tb runner add "Work PC" --out .*nope\.key --id abc123def456 writes it\. Nothing has been changed\./],
  ['a folder', (w) => (fs.mkdirSync(path.join(w.root, 'usb', 'folder.key'), { recursive: true }), path.join(w.root, 'usb', 'folder.key')), /Couldn't read the key file .*folder\.key \(it is not a file\)\. On the first computer/],
  ['empty', (w) => keyFile(w, ''), /work-pc\.key is empty\. On the first computer, tb runner add/],
  ['over 1 KiB', (w) => keyFile(w, 'tbr_' + 'a'.repeat(2000)), /work-pc\.key is bigger than a key file ever is \(over 1 KiB\)\. On the first computer, tb runner add/],
  ['the main key', (w) => keyFile(w, MAIN_KEY + '\n'), /work-pc\.key holds the main key, not a runner key\. Don't copy the main key to another computer: delete that copy, and make a runner key for this one on the first computer with tb runner add\. Nothing has been changed\./],
  ['a deploy key', (w) => keyFile(w, `CONVEX_DEPLOY_KEY=${DEPLOY_KEY}\n`), /work-pc\.key holds a Convex deploy key, not a runner key\. A deploy key can do anything to the backend, so it doesn't belong on this computer: delete that copy, and make a runner key for this one on the first computer with tb runner add\. Nothing has been changed\./],
  ['the wrong shape', (w) => keyFile(w, 'SECRETFILETEXT\n'), /work-pc\.key doesn't hold a runner key \(tbr_ and then 64 digits and letters a to f\)\. Nothing has been changed\./],
  ['too short', (w) => keyFile(w, RK.slice(0, 40)), /work-pc\.key doesn't hold a runner key/],
  ['two lines', (w) => keyFile(w, `${RK}\n${RK}\n`), /work-pc\.key doesn't hold a runner key/],
  ['inside the clone', (w) => keyFile(w, RK + '\n', 'repo', 'secrets-here', 'work.key'), /work\.key is inside the repository clone, where git could pick it up\. Move it somewhere outside the clone and run this again\./],
];

for (const [what, make, said] of BAD_KEY_FILES) {
  test(`join refuses a key file that is ${what}: nothing is written or asked of the network, and nothing in it is shown`, async () => {
    const w = joinWorld();
    seedJson(w);
    w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
    const file = make(w);
    const before = tree(w.home);
    assert.equal(await join(w, '--yes', '--key-file', file), 1, w.text());
    assert.match(w.errs.join('\n'), said);
    assert.equal(tree(w.home), before);
    assert.deepEqual(w.fetched, []);
    assert.deepEqual(w.calls, []);
    for (const secret of [RK, RK.slice(4), MAIN_KEY, DEPLOY_KEY, 'SECRETDEPLOYKEYVALUE', 'SECRETFILETEXT']) assert.ok(!w.text().includes(secret), `${secret.slice(0, 8)} was printed`);
  });
}

test('join accepts a key file saved the way Windows tools save it: a byte order mark, UTF-16, CRLF, spaces', async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const utf16 = Buffer.from([0xff, 0xfe]);
  const files: [string, Buffer][] = [
    ['UTF-8 with a byte order mark', Buffer.concat([bom, Buffer.from(RK + '\r\n')])],
    ['UTF-16 LE, which Windows PowerShell 5.1 writes with >', Buffer.concat([utf16, Buffer.from(RK + '\r\n', 'utf16le')])],
    ['CRLF line ends', Buffer.from(RK + '\r\n')],
    ['spaces and blank lines around it', Buffer.from(`  ${RK}  \n\n`)],
    ['no newline at the end', Buffer.from(RK)],
  ];
  for (const [what, bytes] of files) {
    const w = joinWorld();
    seedJson(w);
    w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
    assert.equal(await join(w, '--yes', '--no-restart', '--key-file', keyFile(w, bytes)), 0, `${what}: ${w.text()}`);
    assert.equal(fs.readFileSync(convexKey(w), 'utf8'), RK + '\n', what);
    assert.equal(sync.parseKeyText(bytes), RK, what);
  }
  assert.equal(sync.parseKeyText(Buffer.alloc(0)), '');
  assert.equal(sync.parseKeyText(Buffer.from([0xff, 0xfe])), '');
});

const JSON_REFUSALS: [string, string, string[], RegExp][] = [
  ['an address that is not the one given', JSON.stringify({ sync: { url: 'https://other-bird-777.convex.cloud', runnerId: RUNNER_ID } }), [], /already mirrors to https:\/\/other-bird-777\.convex\.cloud, not https:\/\/calm-fox-123\.ap-southeast-2\.convex\.cloud\. What this computer has already sent stays in https:\/\/other-bird-777\.convex\.cloud\. If you do mean to move to https:\/\/calm-fox-123\.ap-southeast-2\.convex\.cloud, take the "url" line out of the "sync" part of that file and run this again\. Nothing has been changed\./],
  ['sync switched off', '{"sync": {"enabled": false}}', [], /has "sync": \{ "enabled": false \}, so the runner won't use a backend whatever this sets up/],
  ['a byte order mark', '\uFEFF{"port": 8797}', [], /byte order mark.*Nothing has been changed/],
  ['invalid JSON', '{"sync": {"url": ', [], /valid JSON.*Nothing has been changed/],
  ['an id that is not the --id given', JSON.stringify({ sync: { runnerId: RUNNER_ID, name: 'Work PC' } }), ['--id', 'someoneelse1'], /--id someoneelse1 isn't this computer's runner id: .*runner\.json says it is abc123def456, and a runner keeps its id\. Make the key for abc123def456 on the first computer: tb runner add "Work PC" --out .* --id abc123def456\. Nothing has been changed\./],
  ['an id that is not an id', JSON.stringify({ sync: { runnerId: 'a b' } }), [], /sync\.runnerId in .*runner\.json \("a b"\) isn't a runner id/],
];

for (const [what, text, extra, said] of JSON_REFUSALS) {
  test(`join refuses a runner.json with ${what}, and leaves it as it was`, async () => {
    const w = joinWorld();
    fs.mkdirSync(w.home, { recursive: true });
    fs.writeFileSync(runnerJsonOf(w), text);
    assert.equal(await join(w, '--yes', ...extra), 1, w.text());
    assert.match(w.errs.join('\n'), said);
    assert.equal(fs.readFileSync(runnerJsonOf(w), 'utf8'), text);
    assert.deepEqual(w.fetched, []);
    assert.equal(fs.existsSync(path.join(w.home, 'secrets')), false);
  });
}

test('join: what the backend says about the key decides, and a key it turns down is never installed', async () => {
  const outcomes: [string, (w: World) => void, RegExp][] = [
    ['replaced or revoked', (w) => w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: false }), /The backend turned the key down \(bad runner key\)\. It was replaced or revoked, or this address isn't the backend that made it\. On the first computer, make a new one: tb runner add "Work PC" --out .* --id abc123def456 --replace\. Nothing has been changed\./],
    ['not known to this backend', (w) => w.acct.runnerKeys.delete(RK), /The backend turned the key down \(bad runner key\)/],
    ['another runner\'s', (w) => w.acct.runnerKeys.set(RK, { runnerId: 'someoneelse1', live: true }), /That key is for a different runner than abc123def456\. The backend said: This runner's key can't act as runner abc123def456\. On the first computer, make a key for abc123def456: tb runner add "Work PC" --out .* --id abc123def456\. Nothing has been changed\./],
    ['an answer from the network that cannot be reached', (w) => (w.acct.net = { on: 'query', message: 'getaddrinfo ENOTFOUND calm-fox-123.ap-southeast-2.convex.cloud', code: 'ENOTFOUND' }), /Couldn't reach https:\/\/calm-fox-123\.ap-southeast-2\.convex\.cloud \(.*ENOTFOUND.*\)\. Check your internet connection \(and any proxy or VPN\), then run this again\. Nothing has been changed\./],
    ['a web page for an answer', (w) => (w.acct.queryReply = () => ({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('Unexpected token <')) })), /answered the key check with something that isn't a Convex reply \(HTTP 200\)\. Check the address against the first computer's runner\.json\. Nothing has been changed\./],
    ['a server error', (w) => (w.acct.queryReply = () => ({ ok: false, status: 503, json: async () => Promise.reject(new SyntaxError('Unexpected token <')) })), /isn't a Convex reply \(HTTP 503\)/],
    ['a Convex error it has no word for', (w) => (w.acct.queryReply = () => ({ ok: false, status: 500, json: async () => ({ status: 'error', errorMessage: `Server Error tbr_${'ab12'.repeat(16)} prod:calm-fox-123|SECRETDEPLOYKEYVALUE` }) })), /The backend couldn't check the key \(HTTP 500: Server Error \[key\] \[key\]\)\. Run this again in a minute\. Nothing has been changed\./],
  ];
  for (const [what, set, said] of outcomes) {
    const w = joinWorld({ installed: true });
    seedJson(w);
    w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
    set(w);
    const file = keyFile(w, RK + '\n');
    const before = tree(w.home);
    assert.equal(await join(w, '--yes', '--key-file', file, '--delete-key-file'), 1, `${what}: ${w.text()}`);
    assert.match(w.errs.join('\n'), said, what);
    assert.equal(tree(w.home), before, `${what}: nothing was written`);
    assert.equal(fs.existsSync(file), true, `${what}: the file was not deleted`);
    assert.deepEqual(installerCalls(w).filter((f) => f !== '--installed'), []);
    for (const secret of [RK, RK.slice(4), 'SECRETDEPLOYKEYVALUE']) assert.ok(!w.text().includes(secret), `${what}: ${secret.slice(0, 8)} was printed`);
  }

});

test('join: an address with no sync:messageHeads is not a Threadbear backend, and nothing is written for it', async () => {
  // Every backend that can make a runner key has this function (it was there before runner keys), so a deployment
  // without it is somebody else's: a typo in --url that is still a real *.convex.cloud name. The key is not
  // installed on its word, an old key is not replaced, and runner.json is not pointed at it.
  const noFunction = () => ({ ok: false, status: 560, json: async () => ({ status: 'error', errorMessage: "[Request ID: 3] Server Error\nCould not find public function for 'sync:messageHeads'. Did you forget to run `npx convex dev` or `npx convex deploy`?" }) });
  const said = /https:\/\/calm-fox-123\.ap-southeast-2\.convex\.cloud answers, but it isn't a Threadbear backend: it has no sync:messageHeads, which every backend that makes runner keys has\. Check the address against the first computer's runner\.json\. Nothing has been changed\./;
  for (const flags of [[], ['--delete-key-file'], ['--dry-run']]) {
    // No key here yet: the file's key is not installed.
    const fresh = joinWorld({ installed: true });
    seedJson(fresh);
    fresh.acct.queryReply = noFunction;
    const file = keyFile(fresh, RK + '\n');
    const jsonBefore = fs.readFileSync(runnerJsonOf(fresh), 'utf8');
    assert.equal(await join(fresh, '--yes', '--key-file', file, ...flags), 1, `${flags}: ${fresh.text()}`);
    assert.match(fresh.errs.join('\n'), said, `${flags}`);
    assert.doesNotMatch(fresh.text(), /older than this script expects|runner will say if it turns the key down/);
    assert.equal(fs.existsSync(path.join(fresh.home, 'secrets')), false, `${flags}: no key was written`);
    assert.equal(fs.readFileSync(runnerJsonOf(fresh), 'utf8'), jsonBefore, `${flags}: runner.json was not touched`);
    assert.equal(fs.existsSync(file), true, `${flags}: the file was not deleted`);
    assert.deepEqual(installerCalls(fresh).filter((f) => f !== '--installed'), [], `${flags}: the runner was not touched`);
    for (const secret of [RK, RK.slice(4)]) assert.ok(!fresh.text().includes(secret), `${flags}: ${secret.slice(0, 8)} was printed`);

    // A key already here that works elsewhere: not replaced by the file's.
    const kept = joinWorld({ installed: true });
    seedJson(kept);
    fs.mkdirSync(path.join(kept.home, 'secrets'), { recursive: true });
    fs.writeFileSync(convexKey(kept), RK + '\n');
    kept.acct.queryReply = noFunction;
    const before = tree(kept.home);
    assert.equal(await join(kept, '--yes', '--key-file', keyFile(kept, RK2 + '\n'), ...flags), 1, `${flags}: ${kept.text()}`);
    assert.match(kept.errs.join('\n'), said, `${flags}`);
    assert.equal(tree(kept.home), before, `${flags}: nothing was written`);
    assert.equal(fs.readFileSync(convexKey(kept), 'utf8'), RK + '\n', `${flags}: the key already here was not replaced`);

    // The key already here and no file: it is checked all the same.
    const alone = joinWorld({ installed: true });
    seedJson(alone);
    fs.mkdirSync(path.join(alone.home, 'secrets'), { recursive: true });
    fs.writeFileSync(convexKey(alone), RK + '\n');
    alone.acct.queryReply = noFunction;
    assert.equal(await join(alone, '--yes', ...(flags.includes('--delete-key-file') ? [] : flags)), 1, `${flags}: ${alone.text()}`);
    assert.match(alone.errs.join('\n'), said, `${flags}`);
  }
  // Only that error is this: a reply that names a different problem is still "couldn't check the key".
  const other = joinWorld();
  seedJson(other);
  other.acct.queryReply = () => ({ ok: false, status: 560, json: async () => ({ status: 'error', errorMessage: 'Server Error: Could not find the thing' }) });
  assert.equal(await join(other, '--yes', '--key-file', keyFile(other, RK + '\n')), 1);
  assert.match(other.errs.join('\n'), /The backend couldn't check the key \(HTTP 560: Server Error: Could not find the thing\)/);
});

test('join: a network that checks HTTPS traffic gets the hint for NODE_USE_SYSTEM_CA, and an ordinary failure does not', async () => {
  for (const code of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
    for (const on of ['version', 'query'] as const) {
      const w = joinWorld();
      seedJson(w);
      w.acct.net = { on, message: 'unable to verify the first certificate', code };
      assert.equal(await join(w, '--yes', ...(on === 'query' ? ['--key-file', keyFile(w, RK)] : [])), 1, w.text());
      assert.match(w.errs.join('\n'), /Couldn't reach https:\/\/calm-fox-123\.ap-southeast-2\.convex\.cloud \(.*unable to verify the first certificate/);
      assert.match(w.errs.join('\n'), /This network may be checking HTTPS traffic \(a work proxy\)\. Node doesn't use the Windows certificate store unless asked: set NODE_USE_SYSTEM_CA=1 in this terminal \(Node 24\.6 or newer\) and run this again\./, `${code} ${on}`);
      assert.match(w.errs.join('\n'), /Nothing has been changed/);
    }
  }
  const linux = joinWorld({ platform: 'linux' });
  linux.acct.net = { on: 'version', message: 'self signed certificate in certificate chain', code: 'SELF_SIGNED_CERT_IN_CHAIN' };
  assert.equal(await join(linux, '--yes'), 1);
  assert.match(linux.errs.join('\n'), /Node doesn't use the system's certificate store unless asked: set NODE_USE_SYSTEM_CA=1/);
  // No network, no DNS, a timeout: just the usual advice.
  for (const [message, code] of [['getaddrinfo ENOTFOUND calm-fox-123.ap-southeast-2.convex.cloud', 'ENOTFOUND'], ['connect ETIMEDOUT 1.2.3.4:443', 'ETIMEDOUT'], ['connect ECONNREFUSED', 'ECONNREFUSED']]) {
    const w = joinWorld();
    w.acct.net = { on: 'any', message, code };
    assert.equal(await join(w, '--yes'), 1);
    assert.match(w.errs.join('\n'), /Check your internet connection \(and any proxy or VPN\), then run this again\. Nothing has been changed\./);
    assert.doesNotMatch(w.errs.join('\n'), /NODE_USE_SYSTEM_CA/);
    assert.equal(fs.existsSync(w.home), false);
  }
  // An address that answers, but is not a deployment (a 404 from something else).
  const other = joinWorld();
  other.acct.prod = undefined;
  assert.equal(await join(other, '--yes'), 1);
  assert.match(other.errs.join('\n'), /answered, but it doesn't look like a Convex deployment \(HTTP 404\)\. Check the address against the first computer's runner\.json\. Nothing has been changed\./);
});

test('join: a different runner key in the file replaces the old one only after a yes, and an old key the first computer revoked is said so', async () => {
  const w = joinWorld({ tty: true });
  seedJson(w);
  fs.mkdirSync(path.join(w.home, 'secrets'), { recursive: true });
  fs.writeFileSync(convexKey(w), RK + '\n');
  // tb runner add --replace on the first computer made RK2 and ended RK.
  w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: false });
  w.acct.runnerKeys.set(RK2, { runnerId: RUNNER_ID, live: true });
  const file = keyFile(w, RK2 + '\n');
  w.answers.push('n');
  assert.equal(await join(w, '--no-restart', '--key-file', file), 0, w.text());
  assert.equal(w.asked.length, 1);
  assert.match(w.asked[0], /Go ahead\?/);
  assert.match(w.text(), /This will:\n {2}- replace the runner key in .*convex-key with the one in .*work-pc\.key: the first computer made it to replace the old one, which no longer works/);
  assert.match(w.text(), /Nothing was changed/);
  assert.equal(fs.readFileSync(convexKey(w), 'utf8'), RK + '\n', 'the old key is as it was');
  // With a yes it is replaced, and the runner is told to restart onto it.
  forget(w);
  w.answers.push('y');
  assert.equal(await join(w, '--no-restart', '--key-file', file), 0, w.text());
  assert.equal(fs.readFileSync(convexKey(w), 'utf8'), RK2 + '\n');
  assert.deepEqual(fs.readdirSync(path.join(w.home, 'secrets')), ['convex-key']);
  assert.match(w.text(), /ok {4}runner key in .*convex-key replaced with the one in .*work-pc\.key/);
  assert.match(w.text(), /First restart the runner \(step 8\), so it reads the new settings\./);
  // Without a terminal and without --yes it does not guess.
  const quiet = joinWorld();
  seedJson(quiet);
  fs.mkdirSync(path.join(quiet.home, 'secrets'), { recursive: true });
  fs.writeFileSync(convexKey(quiet), RK + '\n');
  quiet.acct.runnerKeys.set(RK2, { runnerId: RUNNER_ID, live: true });
  assert.equal(await join(quiet, '--key-file', keyFile(quiet, RK2)), 1);
  assert.match(quiet.errs.join('\n'), /Not asking, as there is no terminal/);
  assert.equal(fs.readFileSync(convexKey(quiet), 'utf8'), RK + '\n');
  // The key already here, once the first computer has revoked it and not given another.
  const stale = joinWorld();
  seedJson(stale);
  fs.mkdirSync(path.join(stale.home, 'secrets'), { recursive: true });
  fs.writeFileSync(convexKey(stale), RK + '\n');
  stale.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: false });
  assert.equal(await join(stale, '--yes'), 1);
  assert.match(stale.errs.join('\n'), /The backend turned the key down \(bad runner key\)/);
  assert.equal(fs.readFileSync(convexKey(stale), 'utf8'), RK + '\n', 'it is never taken out on the backend\'s word');
});

test('join: --url must be a Convex cloud address with nothing after the name, and is kept as its origin', async () => {
  const bad: [string, string][] = [
    ['plain http', 'http://calm-fox-123.convex.cloud'],
    ['a path', 'https://calm-fox-123.convex.cloud/api/query'],
    ['a port', 'https://calm-fox-123.convex.cloud:8443'],
    ['a name and password', 'https://me:hunter2@calm-fox-123.convex.cloud'],
    ['a query', 'https://calm-fox-123.convex.cloud/?x=1'],
    ['a fragment', 'https://calm-fox-123.convex.cloud/#x'],
    ['another host', 'https://example.com'],
    ['a host that only ends the same way', 'https://calm-fox-123.convex.cloud.example.com'],
    ['the site address', 'https://calm-fox-123.convex.site'],
    ['more labels than a region', 'https://a.b.c.convex.cloud'],
    ['no scheme', 'calm-fox-123.convex.cloud'],
    ['an escape in it', 'https://calm-fox-123.convex.cloud\u001b[2J/x'],
    ['nothing', ''],
  ];
  for (const [what, url] of bad) {
    const w = joinWorld();
    assert.equal(await w.run('--join', '--url', url, '--yes', '--home', w.home), 1, `${what}: ${w.text()}`);
    const said = w.errs.join('\n');
    assert.match(said, /--url wants a Convex cloud address like https:\/\/calm-fox-123\.convex\.cloud or https:\/\/calm-fox-123\.ap-southeast-2\.convex\.cloud, with nothing after the name, not "/, what);
    assert.match(said, /A self-hosted backend can't be joined from here yet \(docs\/self-hosting\.md\)\. Nothing has been changed\./);
    assert.ok(!said.includes('hunter2') && !said.includes('\u001b'), `${what}: a password or an escape was echoed`);
    assert.deepEqual(w.fetched, []);
    assert.equal(fs.existsSync(w.home), false);
  }
  // The address in runner.json is held to the same rule, and named as that.
  const saved = joinWorld();
  seedJson(saved, { url: 'http://127.0.0.1:3210', runnerId: RUNNER_ID });
  assert.equal(await saved.run('--join', '--yes', '--home', saved.home), 1);
  assert.match(saved.errs.join('\n'), /The sync\.url in .*runner\.json wants a Convex cloud address like/);

  // No address at all: it says where to find one.
  const none = joinWorld();
  assert.equal(await none.run('--join', '--yes', '--home', none.home), 1);
  assert.match(none.errs.join('\n'), /A joining computer needs the address of the backend the first computer made\. Run this again with --url https:\/\/<name>\.convex\.cloud\. The address is sync\.url in runner\.json on the first computer \(on Windows: %APPDATA%\\Threadbear\\runner\.json, on a Mac or Linux: ~\/Library\/Application Support\/Threadbear\/runner\.json\), and it is on the deployment's page in the Convex dashboard\. Nothing has been changed\./);
  assert.deepEqual(none.fetched, []);

  // Accepted: any case and a trailing slash, kept as the origin the runner can use. The address in runner.json alone will do.
  const ok = joinWorld();
  ok.acct.prod = 'https://calm-fox-123.ap-southeast-2.convex.cloud';
  assert.equal(await ok.run('--join', '--url', 'https://Calm-Fox-123.AP-SOUTHEAST-2.convex.cloud/', '--yes', '--home', ok.home), 0, ok.text());
  assert.equal(readJson(runnerJsonOf(ok)).sync.url, 'https://calm-fox-123.ap-southeast-2.convex.cloud');
  assert.equal(await ok.run('--join', '--yes', '--home', ok.home), 0, ok.text());
  // The same address with a different spelling is not a different address.
  assert.equal(await ok.run('--join', '--url', 'https://calm-fox-123.ap-southeast-2.convex.cloud', '--yes', '--home', ok.home), 0, ok.text());
  const short = joinWorld();
  short.acct.prod = 'https://calm-fox-123.convex.cloud';
  assert.equal(await short.run('--join', '--url', 'https://calm-fox-123.convex.cloud', '--yes', '--home', short.home), 0, short.text());
});

test('join: --id is used when runner.json has none, accepted when it is the same, and refused when it is not an id', async () => {
  const w = joinWorld();
  w.acct.runnerKeys.set(RK, { runnerId: 'bench-pc_01', live: true });
  assert.equal(await join(w, '--yes', '--no-restart', '--id', 'bench-pc_01', '--key-file', keyFile(w, RK)), 0, w.text());
  assert.equal(readJson(runnerJsonOf(w)).sync.runnerId, 'bench-pc_01');
  forget(w);
  assert.equal(await join(w, '--yes', '--no-restart', '--id', 'bench-pc_01'), 0, w.text());
  for (const bad of ['any', 'a'.repeat(65), 'a b', '', 'ünï', 'x/y', ' bench-pc_01']) {
    const x = joinWorld();
    assert.equal(await join(x, '--yes', '--id', bad), 1, JSON.stringify(bad));
    assert.match(x.errs.join('\n'), /--id wants a runner id \(1 to 64 letters, digits, - or _, and not "any"\), not /);
    assert.deepEqual(x.fetched, []);
    assert.equal(fs.existsSync(x.home), false);
  }
  // A key file and no id anywhere: the key does not say whose it is, so it cannot be checked.
  const n = joinWorld();
  assert.equal(await join(n, '--yes', '--key-file', keyFile(n, RK)), 1);
  assert.match(n.errs.join('\n'), /no sync\.runnerId in runner\.json\), and a runner key doesn't say which runner it is for, so it can't be checked\. Run this again with --id and the id the key was made for \(tb runner list on the first computer shows it\)\. Nothing has been changed\./);
  assert.deepEqual(n.fetched, []);
  assert.equal(fs.existsSync(path.join(n.home, 'secrets')), false);
  // The pattern is the backend's.
  const source = fs.readFileSync(path.join(REPO, 'convex', 'runnerAccess.ts'), 'utf8');
  assert.equal(String(sync.RUNNER_ID), source.match(/export const RUNNER_ID = (\/.*\/);/)?.[1]);
  assert.match(source, /return RUNNER_ID\.test\(id\) && id !== 'any';/);
});

test('join: --delete-key-file removes the file only once the key reads back, and never after a refusal', async () => {
  // Without it the file stays, and the message says how to remove it.
  const w = joinWorld();
  seedJson(w);
  w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
  const file = keyFile(w, RK + '\n');
  assert.equal(await join(w, '--yes', '--no-restart', '--key-file', file), 0, w.text());
  assert.equal(fs.existsSync(file), true);
  assert.ok(w.text().includes(`${file} is a second copy of the key. Delete it (--delete-key-file does that next time) and don't send it anywhere.`));
  // With it, on the next run (the key is already in place and the file is the same).
  forget(w);
  assert.equal(await join(w, '--yes', '--no-restart', '--key-file', file, '--delete-key-file'), 0, w.text());
  assert.equal(fs.existsSync(file), false);
  assert.match(w.text(), /ok {4}deleted .*work-pc\.key/);
  assert.equal(fs.readFileSync(convexKey(w), 'utf8'), RK + '\n');
  assert.doesNotMatch(w.text(), /is a second copy of the key/);

  // First time with it: the plan lists the delete, and it happens after the key is in.
  const x = joinWorld();
  seedJson(x);
  x.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
  const xf = keyFile(x, RK + '\n');
  assert.equal(await join(x, '--no-restart', '--key-file', xf, '--delete-key-file'), 1, 'asked, and nobody to ask');
  assert.match(x.text(), /This will:\n(?: {2}- .*\n)* {2}- delete .*work-pc\.key once the key is in place \(--delete-key-file\)/);
  assert.equal(fs.existsSync(xf), true);
  assert.equal(await join(x, '--yes', '--no-restart', '--key-file', xf, '--delete-key-file'), 0, x.text());
  assert.equal(fs.existsSync(xf), false);
  assert.equal(fs.readFileSync(convexKey(x), 'utf8'), RK + '\n');

  // A refusal (here a main key already in place) leaves it.
  const y = joinWorld();
  seedJson(y);
  fs.mkdirSync(path.join(y.home, 'secrets'), { recursive: true });
  fs.writeFileSync(convexKey(y), MAIN_KEY);
  const yf = keyFile(y, RK + '\n');
  assert.equal(await join(y, '--yes', '--key-file', yf, '--delete-key-file'), 1);
  assert.equal(fs.existsSync(yf), true);
  // Part one has no file to delete, and the flag without a file is a usage error.
  const z = world();
  assert.equal(await z.run('--join', '--url', URL_, '--delete-key-file', '--home', z.home), 2);
});

test('join: a key file that is the installed key itself, spelt any way, is refused, and --delete-key-file never deletes the only copy', async () => {
  // secrets/convex-key read back as the key file would equal the key, so the plan was "keep", the check passed and
  // --delete-key-file removed the computer's only copy of its key. The backend keeps only a hash, so it could not
  // be got back: the first computer would have to make a new one (tb runner add --replace).
  const spellings: [string, (w: World) => string | undefined][] = [
    ['the same path', (w) => convexKey(w)],
    ['with a dot and a .. in it', (w) => [w.home, 'secrets', '.', 'elsewhere', '..', 'convex-key'].join(path.sep)],
    ['in upper case, as Windows paths may be', (w) => convexKey(w).toUpperCase()],
    ['in lower case', (w) => convexKey(w).toLowerCase()],
    ['through a link to the secrets folder', (w) => {
      const link = path.join(w.root, 'usb', 'secrets-link');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      try {
        fs.symlinkSync(path.dirname(convexKey(w)), link, 'junction');
      } catch {
        return undefined; // this system won't make one for this user
      }
      return path.join(link, 'convex-key');
    }],
    ['as a second name for the same file (a hard link)', (w) => {
      const other = path.join(w.root, 'usb', 'work-pc.key');
      fs.mkdirSync(path.dirname(other), { recursive: true });
      try {
        fs.linkSync(convexKey(w), other);
      } catch {
        return undefined;
      }
      return other;
    }],
  ];
  const said = /is the runner key this computer already uses \(.*convex-key\), not a key file from the first computer\. --key-file wants the file that tb runner add --out wrote there\. Leave this one where it is \(deleting it would leave this computer with no key\)\. Nothing has been changed\./;
  for (const [what, spell] of spellings) {
    for (const flags of [['--delete-key-file'], [], ['--dry-run', '--delete-key-file']]) {
      const w = joinWorld({ installed: true });
      seedJson(w);
      fs.mkdirSync(path.join(w.home, 'secrets'), { recursive: true });
      fs.writeFileSync(convexKey(w), RK + '\n');
      w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
      const file = spell(w);
      if (file === undefined) continue;
      const before = tree(w.home);
      assert.equal(await join(w, '--yes', '--key-file', file, ...flags), 1, `${what} ${flags}: ${w.text()}`);
      assert.match(w.errs.join('\n'), said, `${what} ${flags}`);
      assert.equal(fs.readFileSync(convexKey(w), 'utf8'), RK + '\n', `${what} ${flags}: the key is still where the runner reads it`);
      assert.equal(tree(w.home), before, `${what} ${flags}: nothing was changed`);
      assert.deepEqual(w.fetched, [], `${what} ${flags}: refused before the network was asked`);
      assert.deepEqual(installerCalls(w).filter((f) => f !== '--installed'), [], `${what} ${flags}: the runner was not touched`);
      assert.doesNotMatch(w.text(), /second copy of the key|ok {4}deleted/, `${what} ${flags}`);
      for (const secret of [RK, RK.slice(4)]) assert.ok(!w.text().includes(secret), `${what} ${flags}: ${secret.slice(0, 8)} was printed`);
    }
  }
  // Not too eager: a copy of the key somewhere else is a copy, and is deleted as before.
  const w = joinWorld();
  seedJson(w);
  fs.mkdirSync(path.join(w.home, 'secrets'), { recursive: true });
  fs.writeFileSync(convexKey(w), RK + '\n');
  w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
  const copy = keyFile(w, RK + '\n');
  assert.equal(await join(w, '--yes', '--no-restart', '--key-file', copy, '--delete-key-file'), 0, w.text());
  assert.equal(fs.existsSync(copy), false);
  assert.equal(fs.readFileSync(convexKey(w), 'utf8'), RK + '\n');
});

test('join: the runner is restarted as for a first computer: the standard folder only, never inside a thread, and not with --no-restart', async () => {
  const prepare = (w: World, home = w.home) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ sync: { runnerId: RUNNER_ID, name: 'Work PC' } }));
    w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
    return keyFile(w, RK + '\n');
  };
  // The standard folder: stopped and started.
  // (The installer's --installed is asked in the plan and again in the run; that is only a look.)
  const acts = (w: World) => installerCalls(w).filter((f) => f !== '--installed');
  const a = joinWorld({ installed: true });
  assert.equal(await join(a, '--yes', '--key-file', prepare(a)), 0, a.text());
  assert.deepEqual(acts(a), ['--stop', '--start']);
  assert.doesNotMatch(a.text(), /First restart the runner/);
  // Another folder: the installed runner uses the standard one, so it is left alone and the end says so.
  const b = joinWorld({ installed: true });
  const other = path.join(b.root, 'another runner data');
  assert.equal(await joinAt(b, other, '--yes', '--key-file', prepare(b, other)), 0, b.text());
  assert.deepEqual(installerCalls(b), []);
  assert.match(b.text(), /uses the standard data folder/);
  assert.ok(b.text().includes(`THREADBEAR_HOME set to ${other}`));
  assert.match(b.text(), /First restart the runner \(step 8\), so it reads the new settings\./);
  // Inside a Threadbear thread: never, and the commands are given for a terminal outside.
  const c = joinWorld({ installed: true, env: { THREADBEAR_THREAD_ID: 'a1b2c3d4' } });
  assert.equal(await join(c, '--yes', '--key-file', prepare(c)), 0, c.text());
  assert.deepEqual(installerCalls(c), []);
  assert.match(c.text(), /Not restarting: this is running inside a Threadbear thread/);
  assert.match(c.text(), /from a terminal outside any thread/);
  // --no-restart: the commands are given.
  const d = joinWorld({ installed: true });
  assert.equal(await join(d, '--yes', '--no-restart', '--key-file', prepare(d)), 0, d.text());
  assert.deepEqual(installerCalls(d), []);
  assert.match(d.text(), /Not restarting \(--no-restart\)/);
  assert.match(d.text(), /install-windows\.mjs --stop/);
  // No Task Scheduler task: said so.
  const e = joinWorld({ installed: false });
  assert.equal(await join(e, '--yes', '--key-file', prepare(e)), 0, e.text());
  assert.deepEqual(acts(e), []);
  assert.match(e.text(), /No Task Scheduler task for the runner was found/);
  // On a terminal it asks before ending the runner, and "no" leaves it.
  const f = joinWorld({ installed: true, tty: true, answers: ['y', 'n'] });
  assert.equal(await join(f, '--key-file', prepare(f)), 0, f.text());
  assert.match(f.asked[1] ?? '', /Restart the runner now\?/);
  assert.deepEqual(acts(f), []);
  assert.match(f.text(), /Not restarting\. To make the runner read the new settings/);
});

test('join on Linux: the same two parts, restarted through the systemd service, and the key owner-only', async () => {
  const w = joinWorld({ platform: 'linux', installed: true });
  assert.equal(await join(w, '--yes'), 0, w.text());
  const id = readJson(runnerJsonOf(w)).sync.runnerId as string;
  assert.match(w.text(), /ok {4}Linux x64/);
  assert.ok(w.out.includes(`    tb runner add "DESK-PC" --out /media/usb/desk-pc.key --id ${id}`), w.text());
  assert.match(w.text(), /node scripts\/setup-sync\.mjs --join --url /);
  assert.match(w.text(), /\(\/media\/usb stands for a USB stick; use the path of yours/);
  assert.equal(w.calls.length, 0);
  forget(w);
  w.acct.runnerKeys.set(RK, { runnerId: id, live: true });
  assert.equal(await join(w, '--yes', '--key-file', keyFile(w, RK + '\n')), 0, w.text());
  assert.deepEqual(installerCalls(w).filter((f) => f !== '--installed'), ['--stop', '--start']);
  assert.ok(w.calls.some((c) => /install-linux\.mjs$/.test(c.args[0] ?? '')));
  assert.match(w.text(), /ok {4}the runner restarted/);
  assert.equal(fs.readFileSync(convexKey(w), 'utf8'), RK + '\n');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(convexKey(w)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(w.home, 'secrets')).mode & 0o777, 0o700);
  }
  // Without the restart, the systemd line is given.
  const help = joinWorld({ platform: 'linux' });
  seedJson(help);
  help.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
  assert.equal(await join(help, '--yes', '--no-restart', '--key-file', keyFile(help, RK)), 0, help.text());
  assert.match(help.text(), /systemctl --user restart com\.mikerosoft\.threadbear\.runner\.service/);
});

test('join: options that belong together are checked first, and a mistake is exit 2 with the usage', async () => {
  const table: [string[], RegExp][] = [
    [['--join', '--team', 'my-team'], /^--team doesn't go with --join: a joining computer makes no project and no deployment\. Leave out --team, --project and --region\./],
    [['--join', '--project', 'x'], /^--project doesn't go with --join: /],
    [['--join', '--region', 'aws-eu-west-1'], /^--region doesn't go with --join: /],
    [['--url', URL_], /^--url goes with --join: it is the address of the backend the first computer made\. Add --join, or leave --url out\./],
    [['--key-file', 'x.key'], /^--key-file goes with --join: it is the file that tb runner add --out wrote on the first computer\. Add --join, or leave --key-file out\./],
    [['--id', 'abc'], /^--id goes with --join: it is the runner id the first computer made the key for\. Add --join, or leave --id out\./],
    [['--delete-key-file'], /^--delete-key-file goes with --join: /],
    [['--join', '--delete-key-file'], /^--delete-key-file needs --key-file\./],
  ];
  for (const [args, said] of table) {
    const w = world();
    assert.equal(await w.run(...args, '--home', w.home), 2, args.join(' '));
    assert.match(w.errs.join('\n'), said, args.join(' '));
    assert.match(w.errs.join('\n'), /node scripts\/setup-sync\.mjs --join /, 'the usage follows');
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.fetched, []);
    assert.equal(fs.existsSync(w.home), false);
  }
  assert.equal(sync.joinUsageProblem({}), undefined);
  assert.equal(sync.joinUsageProblem({ join: true, url: URL_, 'key-file': 'x', id: 'y', 'delete-key-file': true }), undefined);
  assert.equal(sync.joinUsageProblem({ join: true, 'dry-run': true, yes: true, name: 'x', home: 'y', 'no-restart': true }), undefined);
  assert.match(sync.joinUsageProblem({ team: 'x' }) ?? 'none', /none/, 'the first-computer options alone are fine');
  assert.match(sync.joinUsageProblem({ url: URL_ }) ?? '', /--url goes with --join/);
  const h = world();
  assert.equal(await h.run('--help'), 0);
  for (const flag of ['--join', '--url URL', '--key-file FILE', '--id RUNNERID', '--delete-key-file']) assert.ok(h.out.join('\n').includes(flag), flag);
});

test('join on a Mac says to use ./threadbear setup --existing, and touches nothing', async () => {
  const w = world({ platform: 'darwin' });
  assert.equal(await join(w, '--yes'), 1);
  assert.match(w.errs.join('\n'), /This script is for Windows and Linux\. On a Mac, run \.\/threadbear setup --existing instead: it joins the backend another Mac set up \(docs\/setup-and-updates\.md, section 2\.2\)\./);
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.fetched, []);
  assert.equal(fs.existsSync(w.home), false);
});

test('join: warnings come in the list before the yes: a sync address in the environment, a key file in a synced folder, a data folder outside the profile', async () => {
  const warning = "The data folder D:\\Shared\\Threadbear is outside your user profile folder (C:\\Users\\me), so other people who use this PC may be able to read the runner's token and secrets there.";
  const w = joinWorld({ tty: false, env: { THREADBEAR_SYNC_URL: 'https://elsewhere.example/secret-path' }, homeWarning: warning });
  seedJson(w);
  w.acct.runnerKeys.set(RK, { runnerId: RUNNER_ID, live: true });
  const file = keyFile(w, RK + '\n', 'Users', 'me', 'OneDrive - Contoso', 'Desktop', 'work-pc.key');
  assert.equal(await join(w, '--key-file', file), 1, 'it asks, and nobody can be asked');
  const text = w.text();
  assert.match(text, /Take care: THREADBEAR_SYNC_URL is set in this environment, and a runner started with it mirrors to that address instead of the one in runner\.json\. Unset it unless you mean it\./);
  assert.match(text, /Take care: The key file .*work-pc\.key is in a folder that looks synced or backed up \(OneDrive, Dropbox or Google Drive\), so a copy of the key may already be somewhere else\./);
  assert.match(text, /Take care: The data folder D:\\Shared\\Threadbear is outside your user profile.* This setup writes the runner key there\./);
  assert.doesNotMatch(text, /elsewhere\.example|secret-path/, 'the value is not repeated');
  assert.equal(fs.existsSync(convexKey(w)), false);
});

test('parseKeyText and oneLine: what is read from a file, and what is let into a message', () => {
  assert.equal(sync.parseKeyText(Buffer.from('  abc \r\n')), 'abc');
  // A terminal escape sequence goes whole; other control characters and zero-width marks become blanks.
  assert.equal(sync.oneLine('a\u001b[2Jb\n\tc\u200bd   e', 20), 'ab c d e');
  assert.equal(sync.oneLine('x'.repeat(300), 10), 'xxxxxxxxx…');
  assert.equal(sync.oneLine(undefined), '');
});
