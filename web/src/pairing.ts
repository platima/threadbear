// Pairing: what a link says about which Convex deployment to talk to and the
// token to do it with. The Android app is built for no deployment in
// particular (the website is built for the one that serves it), so a link
// is how it learns both. Two kinds:
//
//   threadbear://pair?url=<deployment>&token=<token>&key=<runnerId>:<key>
//       the QR code a phone is paired with (docs/protocol.md, `devices.pair`)
//   https://<name>.convex.site/#token=<token>
//       the website's sign-in link, whose deployment is the .convex.cloud of
//       the .convex.site it is served from
//
// Nothing here touches the page or storage, so it can be tested alone.

export type Pairing = { url: string; token: string; key?: string };

// What a phone token looks like: letters, digits and a few signs, and not long.
const TOKEN = /^[A-Za-z0-9._~+/=-]{1,512}$/;

// The deployment a Convex-hosted site belongs to: the same name on
// .convex.cloud. A site anywhere else (a self-hosted backend's, say) says
// nothing about its deployment.
export function siteToDeployment(site: string): string | undefined {
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return undefined;
  }
  const m = /^(.+)\.convex\.site$/i.exec(u.hostname);
  return u.protocol === 'https:' && m ? `https://${m[1]!.toLowerCase()}.convex.cloud` : undefined;
}

// A deployment's address as the app connects to it: an http or https one with
// no sign-in details in it, as its origin alone.
function deploymentAddress(text: string | null): string | undefined {
  if (!text) return undefined;
  try {
    const u = new URL(text);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

function tokenOf(text: string | null): string | undefined {
  return text !== null && TOKEN.test(text) ? text : undefined;
}

function fromLink(link: string): Pairing | undefined {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return undefined;
  }
  if (u.protocol === 'threadbear:') {
    if (u.hostname !== 'pair') return undefined;
    const url = deploymentAddress(u.searchParams.get('url'));
    const token = tokenOf(u.searchParams.get('token'));
    if (!url || !token) return undefined;
    const key = u.searchParams.get('key');
    return { url, token, ...(key ? { key } : {}) };
  }
  if (u.protocol === 'https:' && !u.username && !u.password) {
    const token = tokenOf(new URLSearchParams(u.hash.slice(1)).get('token'));
    const url = siteToDeployment(u.origin);
    return token && url ? { url, token } : undefined;
  }
  return undefined;
}

// The first pairing in a text: a link alone, or one in a line someone sent.
// Any other text, scheme or address is no pairing.
export function parsePairing(text: string): Pairing | undefined {
  for (const m of text.matchAll(/(?:threadbear|https):\/\/[^\s<>"']+/gi)) {
    const found = fromLink(m[0]);
    if (found) return found;
  }
  return undefined;
}
