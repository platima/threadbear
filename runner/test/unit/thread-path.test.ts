// What a thread's shell finds `tb` on (restart.ts, threadPath).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BIN_DIR, threadPath } from '../../src/restart.ts';

test("the runner's bin folder comes first, then what the runner had, on a Mac or Linux", () => {
  assert.equal(threadPath('/usr/bin:/bin', '/opt/node/bin/node', false), `${BIN_DIR}${path.delimiter}/usr/bin:/bin`);
  assert.equal(threadPath(undefined, '/opt/node/bin/node', false), BIN_DIR);
});

test("on Windows the runner's own Node is on the thread's PATH too, unless it already is", () => {
  const node = 'C:\\Program Files\\Threadbear\\node\\node.exe';
  const folder = 'C:\\Program Files\\Threadbear\\node';
  const withNode = threadPath('C:\\Windows\\System32', node, true).split(path.delimiter);
  assert.equal(withNode[0], BIN_DIR);
  assert.equal(withNode[1], folder, "beside the runner's bin folder, ahead of the rest");
  assert.equal(withNode[2], 'C:\\Windows\\System32');
  // Already there, in any case or with a trailing slash: not added a second time.
  const base = 'C:\\Windows;c:\\program files\\threadbear\\NODE\\';
  const again = threadPath(base, node, true);
  assert.equal(again.toLowerCase().split('program files\\threadbear\\node').length - 1, 1, 'once');
  assert.equal(threadPath(undefined, node, true), `${BIN_DIR}${path.delimiter}${folder}`);
});
