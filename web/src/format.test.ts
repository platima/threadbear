// node --test web/src/format.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderName } from './format.ts';

test('a folder is named by the last part of its path', () => {
  assert.equal(folderName('/Users/mike/dev/acme-web'), 'acme-web');
  assert.equal(folderName('/Users/mike/dev/acme-web/'), 'acme-web');
  assert.equal(folderName('acme-web'), 'acme-web');
});

test('a Windows folder is named the same way, not shown whole', () => {
  // The whole path was a 40 character label that left the thread's title no room in
  // the wide header, and filled the second line of every row in the list.
  assert.equal(folderName('D:\\Repos\\Y - Third Party\\threadbear'), 'threadbear');
  assert.equal(folderName('C:\\Users\\Owner\\Documents\\Projects\\acme-web-storefront\\'), 'acme-web-storefront');
  assert.equal(folderName('C:/Users/Owner/work/site'), 'site');
  assert.equal(folderName('C:\\Users/Owner\\mixed'), 'mixed');
});

test('a path with no folder in it is shown as it is', () => {
  assert.equal(folderName('/'), '/');
  assert.equal(folderName(''), '');
  assert.equal(folderName('C:\\'), 'C:');
});
