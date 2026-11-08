import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePairing, siteToDeployment } from './pairing.ts';

test('a phone pairing link (the QR code the apps draw) gives the deployment, the token and the runner key', () => {
  const p = parsePairing('threadbear://pair?url=https%3A%2F%2Fearnest-puffin-640.ap-southeast-2.convex.cloud&token=aa_Xy-9.z&key=r1%3AAbCd%2Bef%3D');
  assert.deepEqual(p, { url: 'https://earnest-puffin-640.ap-southeast-2.convex.cloud', token: 'aa_Xy-9.z', key: 'r1:AbCd+ef=' });
});

test('the same link with the parts unencoded, spaces around it, or as a pasted line of text', () => {
  const want = { url: 'https://x-1.convex.cloud', token: 'tok_1' };
  assert.deepEqual(parsePairing('  threadbear://pair?url=https://x-1.convex.cloud&token=tok_1\n'), want);
  assert.deepEqual(parsePairing('Pair me: threadbear://pair?url=https://x-1.convex.cloud&token=tok_1 thanks'), want);
});

test("the website's sign-in link pairs too: its deployment is the .convex.cloud of the .convex.site it is served from", () => {
  assert.deepEqual(parsePairing('https://opulent-moose-249.ap-southeast-2.convex.site/#token=abc_123'), { url: 'https://opulent-moose-249.ap-southeast-2.convex.cloud', token: 'abc_123' });
  assert.deepEqual(parsePairing('https://opulent-moose-249.convex.site/t/abc#token=abc_123&x=1'), { url: 'https://opulent-moose-249.convex.cloud', token: 'abc_123' });
  assert.equal(siteToDeployment('https://opulent-moose-249.convex.site'), 'https://opulent-moose-249.convex.cloud');
  assert.equal(siteToDeployment('https://example.com'), undefined, 'a site that is not Convex-hosted says nothing about its deployment');
});

test('a self-hosted backend is paired by the address in the link', () => {
  assert.deepEqual(parsePairing('threadbear://pair?url=https%3A%2F%2Fmac.tail1.ts.net%3A3210&token=t'), { url: 'https://mac.tail1.ts.net:3210', token: 't' });
  assert.deepEqual(parsePairing('threadbear://pair?url=http%3A%2F%2F192.168.1.5%3A3210&token=t'), { url: 'http://192.168.1.5:3210', token: 't' });
});

test('anything else is no pairing: other schemes, no token, no address, an address that is not a web one', () => {
  for (const bad of [
    '',
    'hello',
    'threadbear://quickask?url=https://x.convex.cloud&token=t',
    'threadbear://pair?url=https://x.convex.cloud',
    'threadbear://pair?token=t',
    'threadbear://pair?url=javascript:alert(1)&token=t',
    'threadbear://pair?url=file:///etc/passwd&token=t',
    'threadbear://pair?url=ftp://x/&token=t',
    'threadbear://pair?url=not a url&token=t',
    'https://example.com/#token=abc',
    'https://x.convex.site/#nothing=here',
    'https://user:pass@x.convex.cloud/#token=a',
    'threadbear://pair?url=https://x.convex.cloud&token=' + 'a'.repeat(600),
    'threadbear://pair?url=https://x.convex.cloud&token=has%20space',
    'threadbear://pair?url=https://x.convex.cloud&token=a%0Ab',
  ]) {
    assert.equal(parsePairing(bad), undefined, bad);
  }
});

test('only the first link in a text counts, and its parts are read once', () => {
  const p = parsePairing('threadbear://pair?url=https://a.convex.cloud&token=one and threadbear://pair?url=https://b.convex.cloud&token=two');
  assert.deepEqual(p, { url: 'https://a.convex.cloud', token: 'one' });
});
