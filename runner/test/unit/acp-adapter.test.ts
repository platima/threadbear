// AcpAdapter against a pretend agent (helpers/fake-acp-agent.mjs) that
// behaves as OpenCode was seen to: it runs tools unasked unless told otherwise.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AcpAdapter, AcpSession, EDIT_RULE, modelChoices } from '../../src/adapters/acp/adapter.ts';
import { ACP_AGENTS, acpAccounts, isCursorBinary, opencodeEnv } from '../../src/adapters/acp/agents.ts';
import type { AcpAgent } from '../../src/adapters/acp/agents.ts';
import { AcpMcpServer } from '../../src/adapters/acp/mcp-http.ts';
import type { AdapterOutput, SessionSink, StartSessionOptions, ToolApprovalAnswer, ToolApprovalRequest } from '../../src/adapters/types.ts';
import type { Account, PermissionMode } from '../../src/protocol.ts';
import { nullLogger } from '../../src/log.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { z } from 'zod';

const FAKE = path.join(import.meta.dirname, '..', 'helpers', 'fake-acp-agent.mjs');

// Real folders on the temp volume, as adapters compare and resolve them.
function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-acp-')));
}

const made: string[] = [];
const sessions: { end(o?: { hard?: boolean }): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.end({ hard: true }).catch(() => undefined)));
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function rig(o: { mode?: PermissionMode; agent?: AcpAgent; env?: Record<string, string>; opts?: Partial<StartSessionOptions>; deny?: boolean; answer?: (r: ToolApprovalRequest) => ToolApprovalAnswer | Promise<ToolApprovalAnswer>; on?: boolean } = {}) {
  const root = tmp();
  made.push(root);
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const logFile = path.join(root, 'agent.log');
  const account: Account = { id: 'opencode-main', provider: 'opencode', title: 'OpenCode', configDir: root };
  const outputs: AdapterOutput[] = [];
  const cards: ToolApprovalRequest[] = [];
  let exitedWith: Error | undefined | null = null;
  let exitWaiters: (() => void)[] = [];
  const results: (() => void)[] = [];
  const sink: SessionSink = {
    output(out) {
      outputs.push(out);
      if (out.kind === 'result') results.splice(0).forEach((f) => f());
    },
    async requestApproval(req) {
      cards.push(req);
      return o.answer ? o.answer(req) : { decision: o.deny ? 'deny' : 'allow' };
    },
    async requestQuestion() {
      return { answers: null };
    },
    exited(e) {
      exitedWith = e;
      exitWaiters.splice(0).forEach((f) => f());
    },
  };
  const agent: AcpAgent = o.agent ?? ACP_AGENTS.opencode;
  const adapter = new AcpAdapter({
    agent,
    binary: () => FAKE,
    on: () => o.on !== false,
    registry: new ProcessRegistry(path.join(root, 'run'), nullLogger),
    log: nullLogger,
    env: { PATH: process.env.PATH, FAKE_ACP_LOG: logFile, ...o.env },
    timings: { closeWaitMs: 300 },
  });
  const start = (): AcpSession => {
    const s = adapter.start(
      { threadId: 't1', cwd, account, permissionMode: o.mode ?? 'ask', sessionId: 'unused', resume: false, mediaDir: path.join(root, 'media'), blobsDir: path.join(root, 'blobs'), tmpDir: root, ...o.opts },
      sink,
    ) as AcpSession;
    sessions.push(s);
    return s;
  };
  const nextResult = () => new Promise<void>((r) => results.push(r));
  const exited = () => (exitedWith !== null ? Promise.resolve() : new Promise<void>((r) => exitWaiters.push(r)));
  const log = (): Record<string, unknown>[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, cwd, adapter, start, cards, outputs, nextResult, exited, log, account, exitError: () => exitedWith };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const results = (out: AdapterOutput[]) => out.filter((o): o is Extract<AdapterOutput, { kind: 'result' }> => o.kind === 'result').map((o) => o.result);
const events = (out: AdapterOutput[], type: string) => out.flatMap((o) => (o.kind === 'event' && o.event.type === type ? [o.event as never] : []));

async function turn(r: ReturnType<typeof rig>, s: AcpSession, text: string, id = 'turn-1'): Promise<void> {
  const done = r.nextResult();
  s.send({ id, text, images: [] });
  await done;
}

// ---- Asking

test('Ask: a write waits for the card and runs only once allowed', async () => {
  const r = rig({ mode: 'ask' });
  const s = r.start();
  const file = path.join(r.cwd, 'a.txt');
  await turn(r, s, `write ${file} hi`);
  assert.equal(r.cards.length, 1, 'the agent asked, and the card was put up');
  assert.equal(r.cards[0].name, 'apply_patch');
  assert.equal(r.cards[0].title, 'Edit a.txt');
  assert.equal(fs.readFileSync(file, 'utf8'), 'hi');
  assert.deepEqual((r.log().find((l) => l.answered) as { answered: unknown }).answered, { outcome: { outcome: 'selected', optionId: 'once' } });
});

test('Ask: denying a card stops the write', async () => {
  const r = rig({ mode: 'ask', deny: true });
  const s = r.start();
  const file = path.join(r.cwd, 'a.txt');
  await turn(r, s, `write ${file} hi`);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual((r.log().find((l) => l.answered) as { answered: unknown }).answered, { outcome: { outcome: 'selected', optionId: 'reject' } });
});

// The test Mike asked for: without the row's env the pretend agent, like the
// real one, writes with no request at all (the assertion below then fails).
for (const mode of ['ask', 'auto', 'plan'] as PermissionMode[]) {
  test(`${mode}: the row forces asking, and a folder's own config can't turn it off`, async () => {
    const r = rig({ mode, deny: true });
    fs.writeFileSync(path.join(r.cwd, 'opencode.json'), JSON.stringify({ permission: { edit: 'allow', bash: 'allow', '*': 'allow' } }));
    const s = r.start();
    const file = path.join(r.cwd, 'a.txt');
    await turn(r, s, `write ${file} hi`);
    assert.equal(r.cards.length, 1, `${mode} must ask`);
    assert.equal(fs.existsSync(file), false);
  });
}

test('the row turns the folder config, plugins and the agent\'s updates off', () => {
  const env = opencodeEnv();
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  const conf = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(conf.permission['*'], 'ask', 'a tool no one has heard of asks too');
  assert.equal(conf.agent.build.permission['*'], 'ask', "an agent's own rules outrank the top level");
  assert.equal(conf.agent.plan.permission['*'], 'ask');
  assert.ok(ACP_AGENTS.opencode.args.includes('--pure'));
});

test("a folder's plugin doesn't run", async () => {
  const r = rig({ mode: 'full' });
  fs.mkdirSync(path.join(r.cwd, '.opencode', 'plugins'), { recursive: true });
  const marker = path.join(r.root, 'ran');
  fs.writeFileSync(path.join(r.cwd, '.opencode', 'plugins', 'run.txt'), marker);
  const s = r.start();
  await turn(r, s, 'hello');
  assert.equal(fs.existsSync(marker), false);
});

test('a thread\'s own environment cannot take the forced asking off', async () => {
  const r = rig({ mode: 'ask', deny: true, opts: { env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"}}', OPENCODE_DISABLE_PROJECT_CONFIG: '0' } } });
  fs.writeFileSync(path.join(r.cwd, 'opencode.json'), JSON.stringify({ permission: { '*': 'allow' } }));
  const s = r.start();
  const file = path.join(r.cwd, 'a.txt');
  await turn(r, s, `write ${file} hi`);
  assert.equal(r.cards.length, 1);
  assert.equal(fs.existsSync(file), false);
});

test('Full runs without a card, but still through a request answered once', async () => {
  const r = rig({ mode: 'full' });
  const s = r.start();
  const file = path.join(r.cwd, 'a.txt');
  await turn(r, s, `write ${file} hi`);
  assert.equal(r.cards.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hi');
  assert.deepEqual((r.log().find((l) => l.answered) as { answered: unknown }).answered, { outcome: { outcome: 'selected', optionId: 'once' } });
});

test('leaving Full takes effect on the very next request', async () => {
  const r = rig({ mode: 'full', deny: true });
  const s = r.start();
  await turn(r, s, 'hello');
  await s.setPermissionMode('ask');
  const file = path.join(r.cwd, 'a.txt');
  await turn(r, s, `write ${file} hi`, 'turn-2');
  assert.equal(r.cards.length, 1);
  assert.equal(fs.existsSync(file), false);
});

test("an agent's own \"always\" is never picked: Always allow stays Threadbear's", async () => {
  const r = rig({ mode: 'ask', answer: () => ({ decision: 'allowAlways' }) });
  const s = r.start();
  await turn(r, s, `write ${path.join(r.cwd, 'a.txt')} hi`);
  assert.deepEqual((r.log().find((l) => l.answered) as { answered: unknown }).answered, { outcome: { outcome: 'selected', optionId: 'once' } });
  assert.ok(r.outputs.some((o) => o.kind === 'allowRules' && o.rules.includes(EDIT_RULE)));
  await turn(r, s, `write ${path.join(r.cwd, 'b.txt')} hi`, 'turn-2');
  assert.equal(r.cards.length, 1, 'the second edit needed no card');
});

test('no plain allow on offer: it is cancelled, never allowed', async () => {
  const r = rig({ mode: 'full', env: { FAKE_ACP_NO_ONCE: '1' } });
  const s = r.start();
  const file = path.join(r.cwd, 'a.txt');
  await turn(r, s, `write ${file} hi`);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual((r.log().find((l) => l.answered) as { answered: unknown }).answered, { outcome: { outcome: 'cancelled' } });
});

// ---- Files that run as code

for (const [name, rel] of [['a patch', '.threadbear/patches/x.ts'], ['Claude settings', '.claude/settings.json'], ['an MCP config', '.mcp.json']] as const) {
  test(`editing ${name} always asks, with no Always allow, past an earlier one`, async () => {
    const r = rig({ mode: 'ask', opts: { allowRules: [EDIT_RULE] } });
    fs.mkdirSync(path.dirname(path.join(r.cwd, rel)), { recursive: true });
    const s = r.start();
    await turn(r, s, `write ${path.join(r.cwd, rel)} code`);
    assert.equal(r.cards.length, 1);
    assert.equal(r.cards[0].canAlwaysAllow, false);
    assert.match(r.cards[0].title, /runs this file as code/);
  });
}

test('runsAsCode from the runner counts too, and a path outside the names', async () => {
  const r = rig({ mode: 'ask', opts: { runsAsCode: (f) => f.endsWith('helper.ts') } });
  const s = r.start();
  await turn(r, s, `write ${path.join(r.cwd, 'helper.ts')} code`);
  assert.equal(r.cards[0].canAlwaysAllow, false);
});

// ---- Commands

test('a command that can run other code gets no Always allow', async () => {
  const r = rig({ mode: 'ask' });
  const s = r.start();
  await turn(r, s, 'exec npm test');
  assert.equal(r.cards[0].name, 'shell');
  assert.equal(r.cards[0].canAlwaysAllow, false);
});

test('a plain command can be always allowed, exactly', async () => {
  const r = rig({ mode: 'ask', answer: () => ({ decision: 'allowAlways' }) });
  const s = r.start();
  await turn(r, s, 'exec ls -la');
  assert.equal(r.cards[0].canAlwaysAllow, true);
  await turn(r, s, 'exec ls -la', 'turn-2');
  assert.equal(r.cards.length, 1);
  await turn(r, s, 'exec ls -l', 'turn-3');
  assert.equal(r.cards.length, 2, 'a different command asks');
});

// ---- Refusals

test('a thread in the sandbox is refused', () => {
  const r = rig({ opts: { confined: true } });
  assert.throws(() => r.start(), /runs in a sandbox, and OpenCode can't/);
});

test('with the experiment off it refuses to start', () => {
  const r = rig({ on: false });
  assert.throws(() => r.start(), /acpAgents experiment/);
});

test("the wrong program under the agent's name is refused", async () => {
  const r = rig({ env: { FAKE_ACP_NAME: 'Grok' }, agent: ACP_AGENTS.cursor });
  r.start();
  await r.exited();
  assert.match(String(r.exitError()), /isn't Cursor/);
});

test('an ACP version it does not speak is refused', async () => {
  const r = rig({ env: { FAKE_ACP_VERSION: '2' } });
  r.start();
  await r.exited();
  assert.match(String(r.exitError()), /version 2/);
});

test('needing a login says how', async () => {
  const r = rig({ env: { FAKE_ACP_NEEDS_LOGIN: '1' } });
  r.start();
  await r.exited();
  assert.match(String(r.exitError()), /opencode auth login/);
});

test('Cursor fails closed if it can\'t be put in a read-only mode', async () => {
  const r = rig({ mode: 'ask', env: { FAKE_ACP_NAME: 'Cursor', FAKE_ACP_NO_SET_MODE: '1' }, agent: ACP_AGENTS.cursor });
  r.start();
  await r.exited();
  assert.match(String(r.exitError()), /ask mode/);
});

test('Cursor runs Ask threads in its read-only mode', async () => {
  const r = rig({ mode: 'ask', env: { FAKE_ACP_NAME: 'Cursor' }, agent: ACP_AGENTS.cursor });
  const s = r.start();
  await turn(r, s, 'hello');
  assert.ok(r.log().some((l) => (l.set as { mode?: string } | undefined)?.mode === 'ask'));
});

test('resume: a session the agent lost starts fresh', async () => {
  const r = rig({ opts: { resume: true, sessionId: 'gone' } });
  r.start();
  await r.exited();
  assert.equal((r.exitError() as Error).name, 'SessionNotFoundError');
});

test('resume goes through session/resume, with no first-message preamble', async () => {
  const r = rig({ opts: { resume: true, sessionId: 'ses-old', instructions: 'SECRET BRIEF' } });
  const s = r.start();
  await turn(r, s, 'hello');
  assert.ok(r.log().some((l) => l.resumed === 'ses-old'));
  assert.ok(!r.log().some((l) => String(l.prompt ?? '').includes('SECRET BRIEF')));
});

// ---- Turns

test('a new session gets its instructions before the first message only', async () => {
  const r = rig({ opts: { instructions: 'THE BRIEF' } });
  const s = r.start();
  await turn(r, s, 'hello');
  await turn(r, s, 'hello', 'turn-2');
  const prompts = r.log().filter((l) => l.prompt).map((l) => String(l.prompt));
  assert.match(prompts[0], /THE BRIEF/);
  assert.doesNotMatch(prompts[1], /THE BRIEF/);
});

test('the reply, its usage and cost come through; messages sent during a turn run next', async () => {
  const r = rig({ mode: 'full' });
  const s = r.start();
  const done = r.nextResult();
  s.send({ id: 'a', text: 'hello', images: [] });
  s.send({ id: 'b', text: 'hello', images: [] });
  await done;
  const [first] = results(r.outputs);
  assert.equal(first.outcome, 'completed');
  assert.equal(first.answers, 'a');
  assert.equal(first.queuedTurns, 1);
  assert.equal(first.totalCostUsd, 0.25);
  await until(() => results(r.outputs).length === 2);
  assert.equal(results(r.outputs)[1].answers, 'b');
  assert.equal((events(r.outputs, 'assistant.text')[0] as { text: string }).text, 'all done');
  assert.ok(r.outputs.some((o) => o.kind === 'context' && o.contextTokens === 1000 && o.contextWindow === 200000));
  assert.ok(r.outputs.some((o) => o.kind === 'cliVersion' && o.version === '9.9.9'));
});

test('Plan first: the last reply is proposed as the plan', async () => {
  const r = rig({ mode: 'plan' });
  const s = r.start();
  await turn(r, s, 'hello');
  assert.ok(r.log().some((l) => (l.set as { mode?: string } | undefined)?.mode === 'plan'));
  assert.ok(r.outputs.some((o) => o.kind === 'planProposed' && o.text === 'all done'));
});

test('Stop cancels the turn and answers an open card as cancelled', async () => {
  const seen: { signal?: AbortSignal } = {};
  const r = rig({
    mode: 'ask',
    answer: (req) =>
      new Promise((res) => {
        seen.signal = req.signal;
        req.signal.addEventListener('abort', () => res({ decision: 'expired' }));
      }),
  });
  const s = r.start();
  const file = path.join(r.cwd, 'a.txt');
  s.send({ id: 'a', text: `write ${file} hi`, images: [] });
  await until(() => r.cards.length === 1);
  await s.interrupt();
  await until(() => r.log().some((l) => l.cancelled));
  assert.equal(seen.signal?.aborted, true);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual((r.log().find((l) => l.answered) as { answered: unknown }).answered, { outcome: { outcome: 'cancelled' } });
});

test('models come from session/new', async () => {
  const r = rig();
  const models = await r.adapter.models(r.account);
  assert.deepEqual(models.map((m) => m.id), ['fake/one', 'fake/two']);
});

test('modelChoices reads named groups too', () => {
  const opts = [{ category: 'model', options: [{ group: 'a', options: [{ value: 'x', name: 'X' }] }, { value: 'y' }] }];
  assert.deepEqual(modelChoices(opts).map((m) => [m.id, m.title]), [['x', 'X'], ['y', 'y']]);
});

// ---- Which program is it

test('a binary counts as Cursor only by where it really lives', () => {
  const d = tmp();
  made.push(d);
  const real = path.join(d, 'cursor-agent', 'versions', '1', 'cursor-agent');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 });
  const grok = path.join(d, 'grok');
  fs.writeFileSync(grok, '#!/bin/sh\n', { mode: 0o755 });
  const good = path.join(d, 'good');
  fs.symlinkSync(real, good);
  const bad = path.join(d, 'agent');
  fs.symlinkSync(grok, bad);
  assert.equal(isCursorBinary(good), true);
  assert.equal(isCursorBinary(bad), false, "an `agent` that's Grok's isn't Cursor");
});

test("Cursor isn't offered when the only `agent` is another program's", () => {
  const home = tmp();
  made.push(home);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'));
  fs.writeFileSync(path.join(home, '.cursor', 'cli-config.json'), '{}');
  const grok = path.join(home, 'grok');
  fs.writeFileSync(grok, '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(grok, path.join(home, '.local', 'bin', 'agent'));
  assert.deepEqual(acpAccounts({ home, pathEnv: path.join(home, '.local', 'bin') }).map((a) => a.id), []);
  const dir = path.join(home, '.local', 'share', 'cursor-agent', 'versions', '1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cursor-agent'), '#!/bin/sh\n', { mode: 0o755 });
  fs.rmSync(path.join(home, '.local', 'bin', 'agent'));
  fs.symlinkSync(path.join(dir, 'cursor-agent'), path.join(home, '.local', 'bin', 'agent'));
  assert.deepEqual(acpAccounts({ home, pathEnv: path.join(home, '.local', 'bin') }).map((a) => a.id), ['cursor-main']);
});

// ---- The MCP endpoint

function mcp(o: { mode?: PermissionMode; answer?: ToolApprovalAnswer['decision'] } = {}) {
  const calls: string[] = [];
  const cards: ToolApprovalRequest[] = [];
  const tool = (name: string, readOnly = false) => ({
    name,
    description: name,
    inputSchema: { what: z.string().optional() },
    annotations: readOnly ? { readOnlyHint: true } : undefined,
    handler: async () => {
      calls.push(name);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });
  const server = new AcpMcpServer([tool('delete_thread'), tool('list_threads', true), tool('create_thread')], {
    log: nullLogger,
    label: 't',
    requestApproval: async (r) => {
      cards.push(r);
      return { decision: o.answer ?? 'allow' };
    },
    cwd: () => '/tmp',
    mode: () => o.mode ?? 'full',
    rules: () => [],
    addRules: () => undefined,
  });
  return { server, calls, cards };
}

async function post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json?: any }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: d.startsWith('{') ? JSON.parse(d) : undefined }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const callBody = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

test('MCP: delete_thread asks even in Full', async () => {
  const m = mcp({ mode: 'full', answer: 'deny' });
  const url = await m.server.listen();
  const r = await post(url, callBody('delete_thread'), { authorization: `Bearer ${m.server.token}` });
  m.server.close();
  assert.equal(m.cards.length, 1);
  assert.equal(m.cards[0].canAlwaysAllow, false);
  assert.deepEqual(m.calls, [], 'denied: it never ran');
  assert.equal(r.json.result.isError, true);
});

test('MCP: Ask puts up a card for a tool that changes something, not for a read', async () => {
  const m = mcp({ mode: 'ask' });
  const url = await m.server.listen();
  const auth = { authorization: `Bearer ${m.server.token}` };
  await post(url, callBody('list_threads'), auth);
  assert.equal(m.cards.length, 0);
  await post(url, callBody('create_thread'), auth);
  m.server.close();
  assert.equal(m.cards.length, 1);
  assert.deepEqual(m.calls, ['list_threads', 'create_thread']);
});

test('MCP: no token, a wrong token, a browser or a rebound Host are all turned away', async () => {
  const m = mcp();
  const url = await m.server.listen();
  const port = new URL(url).port;
  assert.equal((await post(url, callBody('list_threads'), {})).status, 401);
  assert.equal((await post(url, callBody('list_threads'), { authorization: 'Bearer nope' })).status, 401);
  const good = { authorization: `Bearer ${m.server.token}` };
  assert.equal((await post(url, callBody('list_threads'), { ...good, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(url, callBody('list_threads'), { ...good, host: `evil.example:${port}` })).status, 403);
  assert.deepEqual(m.calls, []);
  const ok = await post(url, callBody('list_threads'), good);
  m.server.close();
  assert.equal(ok.status, 200);
  assert.deepEqual(m.calls, ['list_threads']);
});

test('MCP: tools/list and an unknown tool answer as MCP says', async () => {
  const m = mcp();
  const url = await m.server.listen();
  const auth = { authorization: `Bearer ${m.server.token}` };
  const list = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
  assert.deepEqual(list.json.result.tools.map((t: { name: string }) => t.name), ['delete_thread', 'list_threads', 'create_thread']);
  const nope = await post(url, callBody('nope'), auth);
  m.server.close();
  assert.equal(nope.json.result.isError, true);
});
