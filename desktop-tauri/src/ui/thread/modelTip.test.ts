// node --test desktop-tauri/src/ui/thread/modelTip.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelMenuTip } from './modelTip.ts';

test('the model menu says why it has nothing to offer: no runner, no login, or no models learned yet', () => {
  assert.match(modelMenuTip({ offline: true, models: 0, hasAccount: false }), /Not connected to the runner/);
  // Not connected wins over whatever else is true, as for a new thread before anything has loaded.
  assert.match(modelMenuTip({ offline: true, models: 3, hasAccount: true }), /Not connected/);
  assert.equal(modelMenuTip({ models: 3, hasAccount: true }), 'Choose the model');
  assert.match(modelMenuTip({ models: 0, hasAccount: false }), /hasn't found a login/);
  assert.match(modelMenuTip({ models: 0, hasAccount: true }), /models haven't been listed yet/);
});

test('it never tells a person with a login to sign in again, or names one provider', () => {
  for (const o of [{ models: 0, hasAccount: true }, { models: 0, hasAccount: false }, { offline: true, models: 0, hasAccount: false }]) {
    const tip = modelMenuTip(o);
    assert.doesNotMatch(tip, /claude auth login|Claude Code/i);
  }
  assert.doesNotMatch(modelMenuTip({ models: 0, hasAccount: true }), /sign in|found a login/i, 'a login was found, so it is not about signing in');
});
