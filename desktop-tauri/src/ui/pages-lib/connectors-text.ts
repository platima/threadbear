// What the Connectors page and its rail button say about the gateway's services, from
// the runner's connectors.status (docs/protocol.md, "Connectors"). The same words and
// rules as the Mac app's ConnectorsText: the accent dot only when a service is signed
// out (that is the person's to fix), a quiet one while the gateway cannot be reached or a
// service is connecting or in error (those usually sort themselves out). Kept apart from
// the page so it can be tested with node --test (connectors-text.test.ts).

import type { ConnectorService, ConnectorsStatus } from '../../core/types.ts';

type Status = ConnectorsStatus | undefined;

// Whether the page and its rail button are there: once the runner has answered connectors.status.
// A runner from before Connectors never does (it says -32601, which leaves this undefined), and the
// page is left out for it. One with no gateway answers state 'off', and the page says so: the Mac
// app leaves the button out then, but a copy where the gateway can't be set up from the app (a
// Windows or Linux PC, whose only gateway is another machine's) would otherwise have no button
// and no word about why.
export const hasPage = (s: Status): boolean => s !== undefined;

// What a gateway is for, said where there is none.
export const ABOUT_GATEWAY =
  "A Connectors gateway is a small server of your own that signs in to services such as Notion and Sentry once, and gives all your agents the same address for them. Without one, your agents only get claude.ai's connectors, which are signed in on claude.ai for each login.";

// Why a gateway address was found and not used (it is not https), when the runner says so.
export const whyOff = (s: Status): string | undefined => (s?.state === 'off' && s.error ? `An address for one was found but not used: ${s.error.replace(/\.+$/, '')}.` : undefined);

// Where the gateway is written up: the Connectors section of this copy's own guide (`repo` is
// owner/name, as updates.ts has it).
export const guideUrl = (repo: string): string => `https://github.com/${repo}/blob/main/docs/guide.md#connectors`;

// The services that need signing in again.
export const signedOut = (s: Status): ConnectorService[] => (s?.state === 'ok' ? s.services.filter((x) => x.state === 'signed_out') : []);

export const needsYou = (s: Status): boolean => signedOut(s).length > 0;

// The quiet dot: something is off that is not the person's to fix yet.
export function quiet(s: Status): boolean {
  if (!s) return false;
  if (s.state === 'unreachable') return true;
  return s.state === 'ok' && s.services.some((x) => x.state === 'error' || x.state === 'connecting');
}

// "Gmail", "Gmail and Notion", "Gmail, Notion and Sentry".
export const list = (names: string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? ''));

// The rail button's tooltip: the name, then what needs a look, or that everything is signed in.
export function tooltip(s: Status): string {
  const lines = ['Connectors: the services your agents get from the Connectors gateway'];
  switch (s?.state) {
    case 'ok': {
      const out = signedOut(s).map((x) => x.title);
      if (out.length) lines.push(`${list(out)} ${out.length === 1 ? 'needs' : 'need'} signing in`);
      const broken = s.services.filter((x) => x.state === 'error').map((x) => x.title);
      if (broken.length) lines.push(`${list(broken)} ${broken.length === 1 ? 'has a problem' : 'have problems'}`);
      if (!out.length && !broken.length) lines.push(s.services.length ? 'Everything is signed in' : 'No services yet');
      break;
    }
    case 'unreachable':
      lines.push("Can't reach the gateway");
      break;
    case 'checking':
      lines.push('Checking');
      break;
  }
  return lines.join('. ');
}

// The gateway's machine as its owner calls it: "bruce" for bruce.example.ts.net.
export function host(s: Status): string | undefined {
  try {
    const h = s?.url ? new URL(s.url).hostname : '';
    return h ? (h.split('.')[0] ?? h) : undefined;
  } catch {
    return undefined;
  }
}

const isWeb = (u: URL) => u.protocol === 'https:' || u.protocol === 'http:';

function adminUrl(s: Status, path: string): string | undefined {
  if (!s || s.state === 'off' || !s.url) return undefined;
  try {
    const u = new URL(s.url);
    if (!isWeb(u)) return undefined;
    u.pathname = path;
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return undefined;
  }
}

// The gateway's admin page, where every service can be connected, signed out or retried.
export const manageUrl = (s: Status): string | undefined => adminUrl(s, '/admin');

// One service's page on the gateway (its Connect, Disconnect or Try again), whatever its
// state. The runner only sends a connect address for a service that is not signed in, so a
// signed-in one gets the gateway's page for it, as the runner's own fallback does.
export function serviceUrl(s: Status, service: ConnectorService): string | undefined {
  if (service.connectUrl) {
    try {
      if (isWeb(new URL(service.connectUrl))) return service.connectUrl;
    } catch {
      // not an address: the gateway's page for it
    }
  }
  return adminUrl(s, `/admin/connect/${encodeURIComponent(service.id)}`);
}

// What to say when there are no services to list, or nothing at all.
export function emptyLine(s: Status): string | undefined {
  if (!s) return 'Checking the gateway.';
  switch (s.state) {
    case 'off':
      return 'No Connectors gateway is set up for this runner.';
    case 'checking':
      return 'Checking the gateway.';
    case 'unreachable':
      return `Can't reach ${host(s) ?? 'the gateway'}${s.error ? `: ${s.error}.` : '.'}`;
    default:
      return s.services.length ? undefined : 'The gateway has no services set up.';
  }
}

// A service's state in a word or two.
export function stateLine(service: ConnectorService): string {
  switch (service.state) {
    case 'connected':
      return 'Signed in';
    case 'signed_out':
      return 'Signed out';
    case 'connecting':
      return 'Connecting';
    case 'error':
      return 'Not working';
    case 'disabled':
      return 'Turned off';
    default: {
      const words = String(service.state).replace(/_/g, ' ');
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

// The button beside a service, or undefined when there is nothing to press.
export function buttonTitle(service: ConnectorService): string | undefined {
  if (!service.connectUrl) return undefined;
  if (service.state === 'connected' || service.state === 'disabled') return undefined;
  return service.state === 'signed_out' ? 'Connect' : 'Reconnect';
}
