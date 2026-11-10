// The Bash check of the secrets guard (src/secrets-guard.ts) on the ways a thread's shell on
// Windows can spell the runner's data folder. None of these commands contains the words
// runner-token, which the guard refuses on sight, so each one is held back (or let through) by
// the spelling of the folder alone. They run on any system: a spelling that is wrong for the
// machine is still a spelling someone could send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { denySecrets } from '../../src/secrets-guard.ts';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guard-')));
const deny = (command: string) => denySecrets('Bash', { command }, home);

test('the variables every thread is given, in each shell\'s spelling, name the data folder', () => {
  for (const command of [
    'Get-Content $env:THREADBEAR_HOME\\secrets\\*',
    'Get-Content $env:THREADBEAR_HOME\\secrets\\convex-deploy.env',
    'type %THREADBEAR_HOME%\\secrets\\*',
    'type %THREADBEAR_HOME%\\secrets\\convex-deploy.env',
    'cat $THREADBEAR_RUNNER_HOME/secrets/convex-deploy.env',
    'cat "${THREADBEAR_RUNNER_HOME}/secrets/convex-deploy.env"',
    'Get-Content $env:THREADBEAR_RUNNER_HOME\\secrets\\convex-deploy.env',
    'type %THREADBARE_HOME%\\secrets\\convex-deploy.env',
  ]) assert.ok(deny(command), command);
});

test('a path is the same path in other letters, as the file system sees it', () => {
  const upper = home.toUpperCase();
  assert.ok(deny(`type ${upper}\\SECRETS\\convex-deploy.env`), 'upper case, backslashes');
  assert.ok(deny(`type ${upper.replace(/\\/g, '/')}/Secrets/convex-deploy.env`), 'mixed case, forward slashes');
  assert.ok(deny('type %APPDATA%\\threadbear\\SECRETS\\convex-deploy.env'), '%APPDATA% with a different case');
  assert.ok(deny('Get-Content $env:APPDATA\\Threadbear\\secrets\\convex-deploy.env'), '$env:APPDATA');
});

test('a short (8.3) name or a UNC share of the same drive names the same folder', () => {
  assert.ok(deny('type C:\\Users\\me\\AppData\\Roaming\\THREAD~1\\SECRET~1\\convex-deploy.env'), 'THREAD~1 and SECRET~1');
  assert.ok(deny('type C:\\Users\\me\\AppData\\Roaming\\Threadbear\\secrets\\RUNNER~1'), 'RUNNER~1 is the token file');
  assert.ok(deny('type C:\\Users\\me\\AppData\\Roaming\\THREAD~1\\*'), 'THREAD~1 with a wildcard');
  if (/^[A-Za-z]:\\/.test(home)) {
    const unc = `\\\\localhost\\${home[0]!.toLowerCase()}$\\${home.slice(3)}\\secrets\\convex-deploy.env`;
    assert.ok(deny(`type ${unc}`), unc);
    assert.ok(deny(`type \\\\?\\${home}\\secrets\\convex-deploy.env`), 'a \\\\?\\ prefix');
  }
});

test('a short name counts only beside the data folder: Git revisions that look like one are left alone', () => {
  for (const command of ['git show runner~1', 'git diff feature/runner~1', 'git log runner~2..HEAD', 'git rev-parse HEAD~1 runner~3', 'type C:\\work\\THREAD~1\\notes.txt']) {
    assert.equal(deny(command), undefined, command);
  }
  // From inside the secrets folder, the short name of the token file is the token file.
  assert.ok(denySecrets('Bash', { command: 'type RUNNER~1' }, home, path.join(home, 'secrets')), 'run from the secrets folder');
  assert.equal(denySecrets('Bash', { command: 'git show runner~1' }, home, os.tmpdir()), undefined, 'the same words from anywhere else');
  assert.ok(deny(`type ${home}\\RUNNER~1`), "after the data folder's own path");
});

test('ordinary commands that only look near it are left alone', () => {
  for (const command of [
    'ls secrets',
    'git status',
    'dir C:\\work\\proj\\secrets',
    'Get-ChildItem C:\\work',
    'type C:\\work\\proj\\README.md',
    'echo hello',
    'node -e "console.log(1)"',
    'type C:\\work\\THREAD~1\\notes.txt',
    'git grep -n secrets src',
  ]) assert.equal(deny(command), undefined, command);
});
