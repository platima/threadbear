// Gets the Claude Agent SDK to a Windows install without shipping it.
//
// The SDK (@anthropic-ai/claude-agent-sdk) is Anthropic's, "all rights
// reserved, use subject to the Legal Agreements", so the installers do not
// carry a copy. A Mac install gets it the way every dependency is got, by `npm
// ci` on the person's own machine; this does the same for a Windows install,
// which has no npm: it downloads the one version package-lock.json names from
// the registry, checks it against the lock's hash (what npm itself checks), and
// unpacks it under %LOCALAPPDATA%\Threadbear\sdk\<version>. That folder is the
// person's own, so a machine-wide install, whose own folder a normal user
// can't write to, works the same as a per-user one.
//
// The runner imports the SDK by its package name, which Node looks for in
// node_modules folders above the importing file. A resolve hook (below) sends
// that one name to the downloaded copy when it isn't found the usual way, so a
// checkout with `npm ci` run in it never goes near any of this.
//
// agent-sdk-preload.mjs calls this before the runner's own code loads
// (node --import), and windows-run.mjs starts the runner that way.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

export const SDK = '@anthropic-ai/claude-agent-sdk';
const SDK_PARTS = SDK.split('/');
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_DOWNLOAD_MS = 120_000;

// ---------------------------------------------------------------- the lock

// The version, tarball address and hash package-lock.json holds for the SDK.
export function lockedSdk(root) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  } catch (e) {
    throw new Error(`package-lock.json in ${root} can't be read (${e.code ?? e.message})`);
  }
  const entry = lock.packages?.[`node_modules/${SDK}`];
  if (!entry?.version || !entry.resolved || !entry.integrity) {
    throw new Error(`package-lock.json does not say where to get ${SDK} (it needs a version, a resolved address and an integrity hash)`);
  }
  return { version: entry.version, resolved: entry.resolved, integrity: entry.integrity };
}

function versionIn(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.name === SDK ? pkg.version : null;
  } catch {
    return null;
  }
}

// Where downloaded copies go: one folder per version under here.
export function sdkHome(env = process.env, platform = process.platform) {
  if (env.THREADBEAR_SDK_DIR) return path.resolve(env.THREADBEAR_SDK_DIR);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Threadbear', 'sdk');
  return path.join(os.homedir(), '.cache', 'threadbear', 'sdk');
}

// ------------------------------------------------------------- the hash

// "sha512-<base64>", as npm writes it; several, separated by spaces, are allowed.
export function checkIntegrity(bytes, integrity) {
  const wanted = String(integrity)
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => /^(sha(?:256|384|512))-([A-Za-z0-9+/=]+)$/.exec(s))
    .filter(Boolean);
  if (wanted.length === 0) throw new Error(`the lock's integrity value (${String(integrity).slice(0, 40)}) is not a SHA-256, 384 or 512 hash`);
  for (const [, algo, b64] of wanted) {
    const got = crypto.createHash(algo).update(bytes).digest('base64');
    if (got !== b64) throw new Error(`the download does not match the hash in package-lock.json (${algo}), so it was thrown away`);
  }
}

// ------------------------------------------------------------ the tarball

const cstr = (buf, from, len) => {
  const slice = buf.subarray(from, from + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? len : end).toString('utf8');
};

// "<len> <key>=<value>\n" records of a pax extended header.
function paxRecords(body) {
  const out = {};
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space < 0) break;
    const len = parseInt(body.subarray(pos, space).toString('ascii'), 10);
    if (!(len > 0) || pos + len > body.length) break;
    const record = body.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

// Where an entry's name lands under `dest`, with npm's leading "package/"
// dropped. Anything that could leave `dest` is an error: a name with "..", a
// drive or stream colon, a backslash, or an absolute path.
export function entryTarget(dest, name) {
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  // Checked before the first folder is dropped, so "../x" is as unsafe as "x/../../y".
  if (parts.some((p) => p === '..' || /[:\\\0]/.test(p)) || name.startsWith('/')) throw new Error(`the tarball has an unsafe name: ${JSON.stringify(name)}`);
  parts.shift();
  if (parts.length === 0) return null;
  const target = path.join(dest, ...parts);
  if (!target.startsWith(dest + path.sep)) throw new Error(`the tarball has a name that leaves its folder: ${JSON.stringify(name)}`);
  return target;
}

// Unpacks an npm tarball (gzip of tar) into `dest`. Files and folders only: a
// link or a device in a package is an error, as nothing here has any.
export function extractTarball(gz, dest) {
  const tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  dest = path.resolve(dest);
  fs.mkdirSync(dest, { recursive: true });
  let off = 0;
  let nextName = null;
  let files = 0;
  let ended = false;
  while (off + 512 <= tar.length) {
    const head = tar.subarray(off, off + 512);
    if (head.every((b) => b === 0)) {
      ended = true;
      break;
    }
    const type = head[156] === 0 ? '0' : String.fromCharCode(head[156]);
    const size = parseInt(cstr(head, 124, 12).trim() || '0', 8);
    if (!(size >= 0) || off + 512 + size > tar.length) throw new Error('the tarball is cut short');
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') {
      nextName = paxRecords(body).path ?? nextName;
      continue;
    }
    if (type === 'L') {
      nextName = cstr(body, 0, body.length);
      continue;
    }
    const prefix = cstr(head, 345, 155);
    const name = nextName ?? (prefix ? `${prefix}/` : '') + cstr(head, 0, 100);
    nextName = null;
    if (type === '5') {
      const dir = entryTarget(dest, name);
      if (dir) fs.mkdirSync(dir, { recursive: true });
    } else if (type === '0') {
      const file = entryTarget(dest, name);
      if (!file) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      files++;
    } else {
      throw new Error(`the tarball has an entry of a kind this does not unpack (${JSON.stringify(type)}: ${name})`);
    }
  }
  if (!ended) throw new Error('the tarball is cut short (no end marker)');
  return files;
}

// ------------------------------------------------------------- the fetch

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Antivirus and the indexer hold a new folder for a moment on Windows.
async function moveInto(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(50 * 2 ** i);
    }
  }
}

const rmQuiet = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

// Makes sure the SDK the lock names can be imported, and says where from:
//   { where: 'in place' }  node_modules next to the runner has it (a checkout)
//   { where: 'cached', base }   an earlier start downloaded it
//   { where: 'fetched', base }  this start did
// `base` is the folder with node_modules\@anthropic-ai\claude-agent-sdk in it.
export async function ensureAgentSdk({ root, home = sdkHome(), fetchFn = globalThis.fetch, log = () => {} }) {
  const want = lockedSdk(root);
  if (versionIn(path.join(root, 'node_modules', ...SDK_PARTS)) === want.version) return { where: 'in place', version: want.version };

  const base = path.join(home, want.version);
  const there = () => versionIn(path.join(base, 'node_modules', ...SDK_PARTS)) === want.version;
  if (there()) return { where: 'cached', version: want.version, base };

  log(`Getting the Claude Agent SDK ${want.version} from npm (once per version; ${want.resolved})`);
  const res = await fetchFn(want.resolved, { signal: AbortSignal.timeout(MAX_DOWNLOAD_MS) });
  if (!res.ok) throw new Error(`${want.resolved} answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  checkIntegrity(bytes, want.integrity);

  fs.mkdirSync(home, { recursive: true });
  const tmp = path.join(home, `.${want.version}.${process.pid}.tmp`);
  rmQuiet(tmp);
  try {
    extractTarball(bytes, path.join(tmp, 'node_modules', ...SDK_PARTS));
    const got = versionIn(path.join(tmp, 'node_modules', ...SDK_PARTS));
    if (got !== want.version) throw new Error(`the package inside is ${got ?? 'not the SDK'}, not ${want.version}`);
    rmQuiet(base); // a half-made earlier try
    try {
      await moveInto(tmp, base);
    } catch (e) {
      if (!there()) throw e; // another runner start got there first
    }
  } finally {
    rmQuiet(tmp);
  }

  // Other versions are from earlier releases. Only version-named folders: a
  // dot-named one is another start's download in progress.
  try {
    for (const name of fs.readdirSync(home)) {
      if (name !== want.version && /^\d+\.\d+\.\d+/.test(name)) rmQuiet(path.join(home, name));
    }
  } catch {
    // a copy in use by another runner keeps its folder; the next start tries again
  }
  log(`The Claude Agent SDK ${want.version} is in ${base}`);
  return { where: 'fetched', version: want.version, base };
}

// ---------------------------------------------------------------- the hook

// Imports of the SDK that Node can't find in a node_modules above the runner
// are looked for as if they came from a file in the downloaded copy's folder.
export function useSdkFrom(base) {
  const parentURL = pathToFileURL(path.join(base, 'resolve-from.mjs')).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (e) {
        if ((specifier === SDK || specifier.startsWith(`${SDK}/`)) && e?.code === 'ERR_MODULE_NOT_FOUND') {
          return nextResolve(specifier, { ...context, parentURL });
        }
        throw e;
      }
    },
  });
}

// What agent-sdk-preload.mjs runs.
export async function preload({ root, home, fetchFn, log = (s) => process.stderr.write(`${s}\n`) }) {
  let got;
  try {
    got = await ensureAgentSdk({ root, home, fetchFn, log });
  } catch (e) {
    throw new Error(`Threadbear could not get the Claude Agent SDK from npm: ${e.message}. It needs this PC to reach registry.npmjs.org once (behind a proxy, set NODE_USE_ENV_PROXY=1 and HTTPS_PROXY), or run "npm ci --omit=dev" in ${root}.`);
  }
  if (got.base) useSdkFrom(got.base);
  return got;
}
