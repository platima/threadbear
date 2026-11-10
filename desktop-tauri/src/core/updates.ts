// Is there a newer release of the Windows app? One request to GitHub's
// releases API (the latest release, or the recent ones for a copy that is itself
// a pre-release), at most once a day, for the repository named in REPO. Nothing
// is downloaded or installed: the rail shows a link to the release page, and
// the person decides. Settings > This app turns the check off.
//
// What it sends is the request itself, so GitHub sees this PC's address, and
// nothing else (docs/on-your-mac.md). The logic is here, with the fetch and the
// storage passed in, so it can be tested with node --test (updates.test.ts).

// The repository whose releases are checked, and whose guide the Connectors page links to
// (guideUrl in pages-lib/connectors-text.ts). A fork changes this (docs/forking.md).
export const REPO = 'platima/threadbear';

// How a release asset's name ends, per architecture. installer/validate-release-assets.sh
// reads the two strings below, so a release whose assets stop matching them
// fails before anything is published, instead of leaving installed copies
// unable to find an update. Keep them in double quotes, and keep that pattern
// out of the comments in this file.
const SUFFIX = { x64: "-setup-win-x64.exe", arm64: "-setup-win-arm64.exe" } as const;

export type Arch = keyof typeof SUFFIX;
export type Available = { version: string; page: string; download?: string };

type Release = { tag_name?: string; html_url?: string; prerelease?: boolean; draft?: boolean; assets?: { name?: string; browser_download_url?: string }[] };

// A semantic version, whole: 1.2.3, optionally with -pre.release and +build,
// and a leading v. Anything else ("1.2.3garbage", "1.2") is not a version.
const parse = (v: string) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(v.trim());
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])] as const, pre: m[4] ? m[4].split('.') : [] } : undefined;
};

// Pre-release parts as semver.org rules them (section 11): numbers by value,
// and below words; words by their letters; a shorter run is older.
function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1; // a release is newer than its pre-releases
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Semantic versions: numbers first, and a pre-release is older than its release.
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i]! > b.n[i]!;
  return comparePre(a.pre, b.pre) > 0;
}

// An address from GitHub's answer that this app will show or open: https, on
// github.com itself (no other host, no sign-in part, no port), under this
// repository's releases. The answer is data from the network, and the rail and
// Settings turn it into links, so anything else is dropped.
export function releaseUrl(raw: unknown, repo: string = REPO): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password || u.port) return undefined;
  if (!u.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/`)) return undefined;
  return u.href;
}

// A copy that is itself a pre-release (0.1.0-rc.2) follows pre-releases too. GitHub's
// answer for "the latest release" never includes one, so a copy that only asked for
// that would never be told about the next candidate. A stable copy is never offered a
// pre-release.
export const followsPrereleases = (current: string): boolean => (parse(current)?.pre.length ?? 0) > 0;

export function pick(release: Release, current: string, arch: Arch, opts: { prereleases?: boolean } = {}): Available | undefined {
  const tag = release.tag_name ?? '';
  if (release.draft || (release.prerelease && !opts.prereleases) || !isNewer(tag, current)) return undefined;
  const page = releaseUrl(release.html_url);
  if (!page) return undefined;
  const wanted = SUFFIX[arch].toLowerCase();
  const asset = release.assets?.find((a) => (a.name ?? '').toLowerCase().endsWith(wanted));
  const download = releaseUrl(asset?.browser_download_url);
  return { version: tag.replace(/^v/, ''), page, ...(download ? { download } : {}) };
}

// The newest release in a list (GitHub's answer for the repository's releases) that is
// newer than this copy, pre-releases included: the stable release of a version comes
// after its candidates, so it wins once it is out. Drafts and anything not a version are left out.
export function pickNewest(list: unknown, current: string, arch: Arch): Available | undefined {
  if (!Array.isArray(list)) return undefined;
  let best: Available | undefined;
  for (const r of list as Release[]) {
    const found = r && typeof r === 'object' ? pick(r, current, arch, { prereleases: true }) : undefined;
    if (found && (!best || isNewer(found.version, best.version))) best = found;
  }
  return best;
}

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const KEY = 'threadbear.update';
const OFF_KEY = 'threadbear.updateCheck';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Whether the daily check may run by itself. On until someone turns it off,
// but a setting that can't be read at all counts as off: the person may have
// turned it off, and the check is the one thing here that contacts a server.
export const updateCheckOn = (store: Storage): boolean => {
  try {
    return store.getItem(OFF_KEY) !== 'off';
  } catch {
    return false;
  }
};
// Gives back whether the choice stuck (storage can be blocked or full).
export function setUpdateCheck(store: Storage, on: boolean): boolean {
  try {
    store.setItem(OFF_KEY, on ? 'on' : 'off');
    return store.getItem(OFF_KEY) === (on ? 'on' : 'off');
  } catch {
    return false;
  }
}

// How long to leave it after a check: a day, and after failures an hour,
// two, four and so on up to a day, so a PC that can't reach GitHub does not try
// on every start.
const waitAfter = (fails: number): number => (fails > 0 ? Math.min(DAY_MS, HOUR_MS * 2 ** (fails - 1)) : DAY_MS);

type Kept = { at: number; found?: Available; fails?: number };

// The newer release, if there is one. Asks GitHub when it last asked more than
// a day ago (or `force`), else answers from the last answer. Any failure is
// "no update": a check that can't reach GitHub should never be a message. A
// failed try is remembered too, and the next one waits longer.
export async function checkForUpdate(opts: {
  current: string;
  arch: Arch;
  store: Storage;
  fetch: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  now?: number;
  force?: boolean;
}): Promise<Available | undefined> {
  const now = opts.now ?? Date.now();
  if (!opts.force && !updateCheckOn(opts.store)) return undefined;
  let kept: Kept | null = null;
  try {
    kept = JSON.parse(opts.store.getItem(KEY) ?? 'null') as Kept | null;
    if (kept && (typeof kept.at !== 'number' || (kept.found && !releaseUrl(kept.found.page)))) kept = null;
  } catch {
    kept = null; // unreadable: ask again
  }
  const stillNewer = (f?: Available) => (f && isNewer(f.version, opts.current) ? f : undefined);
  if (!opts.force && kept && now - kept.at < waitAfter(kept.fails ?? 0)) return stillNewer(kept.found);
  let found: Available | undefined;
  try {
    const pre = followsPrereleases(opts.current);
    const res = await opts.fetch(pre ? `https://api.github.com/repos/${REPO}/releases?per_page=10` : `https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) throw new Error('not ok');
    const body = await res.json();
    found = pre ? pickNewest(body, opts.current, opts.arch) : pick(body as Release, opts.current, opts.arch);
  } catch {
    try {
      const next: Kept = { at: now, fails: (kept?.fails ?? 0) + 1, ...(kept?.found ? { found: kept.found } : {}) };
      opts.store.setItem(KEY, JSON.stringify(next));
    } catch {
      // not kept
    }
    return stillNewer(kept?.found);
  }
  try {
    opts.store.setItem(KEY, JSON.stringify({ at: now, ...(found ? { found } : {}) }));
  } catch {
    // not kept
  }
  return found;
}

// This PC's architecture as the page can tell it. The browser engine reports
// it in high-entropy client hints; with none, assume x64 (Windows on Arm runs
// x64 programs too, so the worst case is a slower download).
export async function detectArch(): Promise<Arch> {
  try {
    const ua = (navigator as unknown as { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ architecture?: string }> } }).userAgentData;
    const got = await ua?.getHighEntropyValues(['architecture']);
    return got?.architecture === 'arm' ? 'arm64' : 'x64';
  } catch {
    return 'x64';
  }
}
