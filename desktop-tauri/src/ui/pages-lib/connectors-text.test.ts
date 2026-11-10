// node --test desktop-tauri/src/ui/pages-lib/connectors-text.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ABOUT_GATEWAY, buttonTitle, emptyLine, guideUrl, hasPage, host, list, manageUrl, needsYou, quiet, serviceUrl, stateLine, tooltip, whyOff } from './connectors-text.ts';
import type { ConnectorService, ConnectorsStatus } from '../../core/types.ts';

const svc = (id: string, state: ConnectorService['state'], extra: Partial<ConnectorService> = {}): ConnectorService => ({ id, title: id[0]!.toUpperCase() + id.slice(1), state, ...extra });
const ok = (services: ConnectorService[], extra: Partial<ConnectorsStatus> = {}): ConnectorsStatus => ({ state: 'ok', url: 'https://bruce.example.ts.net:7200', services, ...extra });

test('the accent dot is for a service that is signed out, and the quiet one for trouble that mends itself', () => {
  assert.equal(needsYou(undefined), false);
  assert.equal(needsYou(ok([svc('gmail', 'connected')])), false);
  assert.equal(needsYou(ok([svc('gmail', 'signed_out')])), true);
  // A signed-out service only counts when the gateway answered.
  assert.equal(needsYou({ state: 'unreachable', services: [svc('gmail', 'signed_out')] }), false);
  assert.equal(quiet(undefined), false);
  assert.equal(quiet({ state: 'unreachable', services: [] }), true);
  assert.equal(quiet(ok([svc('notion', 'connecting')])), true);
  assert.equal(quiet(ok([svc('notion', 'error')])), true);
  assert.equal(quiet(ok([svc('notion', 'connected')])), false);
  assert.equal(quiet({ state: 'off', services: [] }), false);
});

test('the tooltip names the services that need a look, or says all is well', () => {
  assert.match(tooltip(undefined), /^Connectors/);
  assert.match(tooltip(ok([svc('gmail', 'signed_out')])), /Gmail needs signing in/);
  assert.match(tooltip(ok([svc('gmail', 'signed_out'), svc('notion', 'signed_out'), svc('sentry', 'signed_out')])), /Gmail, Notion and Sentry need signing in/);
  assert.match(tooltip(ok([svc('gmail', 'error'), svc('notion', 'error')])), /Gmail and Notion have problems/);
  assert.match(tooltip(ok([svc('gmail', 'connected')])), /Everything is signed in/);
  assert.match(tooltip(ok([])), /No services yet/);
  assert.match(tooltip({ state: 'unreachable', services: [] }), /Can't reach the gateway/);
  assert.equal(list(['a']), 'a');
  assert.equal(list(['a', 'b']), 'a and b');
});

test('the gateway is named by its machine, and the empty panel says why it is empty', () => {
  assert.equal(host(ok([])), 'bruce');
  assert.equal(host({ state: 'ok', services: [] }), undefined);
  assert.equal(host({ state: 'ok', url: 'not a url', services: [] }), undefined);
  assert.equal(emptyLine(undefined), 'Checking the gateway.');
  assert.equal(emptyLine({ state: 'off', services: [] }), 'No Connectors gateway is set up for this runner.');
  assert.equal(emptyLine({ state: 'unreachable', url: 'https://bruce.example.ts.net', error: 'timed out', services: [] }), "Can't reach bruce: timed out.");
  assert.equal(emptyLine({ state: 'unreachable', services: [] }), "Can't reach the gateway.");
  assert.equal(emptyLine(ok([])), 'The gateway has no services set up.');
  assert.equal(emptyLine(ok([svc('gmail', 'connected')])), undefined);
});

test("a service's words and button: Connect when signed out, Reconnect when not working, nothing when signed in or off", () => {
  assert.equal(stateLine(svc('a', 'connected')), 'Signed in');
  assert.equal(stateLine(svc('a', 'signed_out')), 'Signed out');
  assert.equal(stateLine(svc('a', 'error')), 'Not working');
  assert.equal(stateLine(svc('a', 'disabled')), 'Turned off');
  assert.equal(stateLine({ ...svc('a', 'unknown'), state: 'half_open' as never }), 'Half open');
  const url = 'https://bruce.example.ts.net:7200/admin/connect/gmail';
  assert.equal(buttonTitle(svc('gmail', 'signed_out', { connectUrl: url })), 'Connect');
  assert.equal(buttonTitle(svc('gmail', 'error', { connectUrl: url })), 'Reconnect');
  assert.equal(buttonTitle(svc('gmail', 'connecting', { connectUrl: url })), 'Reconnect');
  assert.equal(buttonTitle(svc('gmail', 'connected', { connectUrl: url })), undefined);
  assert.equal(buttonTitle(svc('gmail', 'disabled', { connectUrl: url })), undefined);
  assert.equal(buttonTitle(svc('gmail', 'signed_out')), undefined, 'no address, nothing to open');
});

test("the gateway's own pages: admin, and a service's page whatever its state; only web addresses are opened", () => {
  assert.equal(manageUrl(ok([])), 'https://bruce.example.ts.net:7200/admin');
  assert.equal(manageUrl({ state: 'off', url: 'https://x.test', services: [] }), undefined);
  assert.equal(manageUrl({ state: 'ok', url: 'file:///etc/passwd', services: [] }), undefined);
  const s = ok([]);
  assert.equal(serviceUrl(s, svc('gmail', 'signed_out', { connectUrl: 'https://bruce.example.ts.net:7200/admin/connect/gmail?x=1' })), 'https://bruce.example.ts.net:7200/admin/connect/gmail?x=1');
  assert.equal(serviceUrl(s, svc('gmail', 'connected')), 'https://bruce.example.ts.net:7200/admin/connect/gmail');
  assert.equal(serviceUrl(s, svc('a/b', 'connected')), 'https://bruce.example.ts.net:7200/admin/connect/a%2Fb');
  assert.equal(serviceUrl(s, svc('gmail', 'signed_out', { connectUrl: 'javascript:alert(1)' })), 'https://bruce.example.ts.net:7200/admin/connect/gmail', 'a script address is never opened');
});

// rc.4 left the button out for a runner with no gateway, and the person who went looking for it
// (the test list said to try Connectors) found nothing and no word about why.
test('the page is there once the runner has answered, with a gateway or without, and not for one too old to answer', () => {
  assert.equal(hasPage(undefined), false, 'a runner from before Connectors says -32601 and the store keeps none');
  assert.equal(hasPage({ state: 'off', services: [] }), true, 'no gateway set up: the page says so');
  assert.equal(hasPage({ state: 'off', error: 'connectors.url in runner.json is not https', services: [] }), true);
  assert.equal(hasPage({ state: 'checking', url: 'https://bruce.example.ts.net:7200', services: [] }), true);
  assert.equal(hasPage({ state: 'unreachable', url: 'https://bruce.example.ts.net:7200', error: 'timed out', services: [] }), true);
  assert.equal(hasPage(ok([svc('gmail', 'connected')])), true);
});

test('with no gateway the page says there is none, what one is for, and where it is written up, with no dot or button to press', () => {
  const off: ConnectorsStatus = { state: 'off', services: [] };
  assert.equal(emptyLine(off), 'No Connectors gateway is set up for this runner.');
  assert.match(ABOUT_GATEWAY, /signs in to services such as Notion and Sentry once/);
  assert.match(ABOUT_GATEWAY, /claude\.ai's connectors/);
  assert.equal(guideUrl('platima/threadbear'), 'https://github.com/platima/threadbear/blob/main/docs/guide.md#connectors');
  assert.equal(whyOff(off), undefined, 'no word about an address when none was found');
  // Nothing for the person to do from the rail, so no dot; and no gateway to manage or sign in to.
  assert.equal(needsYou(off), false);
  assert.equal(quiet(off), false);
  assert.equal(manageUrl(off), undefined);
});

test('an address that was found and refused is said, so the person can fix it', () => {
  const refused: ConnectorsStatus = { state: 'off', error: 'connectors.url in runner.json is plain http to bruce:8443, so its keys would go in the clear; use https', services: [] };
  assert.equal(whyOff(refused), 'An address for one was found but not used: connectors.url in runner.json is plain http to bruce:8443, so its keys would go in the clear; use https.');
  assert.equal(whyOff({ ...refused, error: "isn't a URL." }), "An address for one was found but not used: isn't a URL.", 'one full stop, not two');
  assert.equal(whyOff(ok([])), undefined, 'only a gateway that is off has a reason');
  assert.equal(whyOff(undefined), undefined);
});
