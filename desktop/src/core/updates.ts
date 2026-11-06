// Is there a newer release of the Windows app? One request to GitHub's
// releases API, at most once a day, for the repository named in REPO. Nothing
// is downloaded or installed: the rail shows a link to the release page, and
// the person decides. Settings > This app turns the check off.
//
// What it sends is the request itself, so GitHub sees this PC's address, and
// nothing else (docs/on-your-mac.md). The logic is here, with the fetch and the
// storage passed in, so it can be tested with node --test (updates.test.ts).

// The repository whose releases are checked. A fork changes this (docs/forking.md).
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

const parse = (v: string) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])] as const, pre: m[4] } : undefined;
};

// Semantic versions: numbers first, and a pre-release is older than its release.
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i]! > b.n[i]!;
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  return a.pre > b.pre;
}

export function pick(release: Release, current: string, arch: Arch): Available | undefined {
  const tag = release.tag_name ?? '';
  if (release.draft || release.prerelease || !isNewer(tag, current) || !release.html_url) return undefined;
  const wanted = SUFFIX[arch].toLowerCase();
  const asset = release.assets?.find((a) => (a.name ?? '').toLowerCase().endsWith(wanted));
  return { version: tag.replace(/^v/, ''), page: release.html_url, ...(asset?.browser_download_url ? { download: asset.browser_download_url } : {}) };
}

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const KEY = 'threadbear.update';
const OFF_KEY = 'threadbear.updateCheck';
const DAY_MS = 24 * 60 * 60 * 1000;

export const updateCheckOn = (store: Storage): boolean => {
  try {
    return store.getItem(OFF_KEY) !== 'off';
  } catch {
    return true;
  }
};
export function setUpdateCheck(store: Storage, on: boolean): void {
  try {
    store.setItem(OFF_KEY, on ? 'on' : 'off');
  } catch {
    // not kept
  }
}

// The newer release, if there is one. Asks GitHub when it last asked more than
// a day ago (or `force`), else answers from the last answer. Any failure is
// "no update": a check that can't reach GitHub should never be a message.
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
  try {
    const kept = JSON.parse(opts.store.getItem(KEY) ?? 'null') as { at: number; found?: Available } | null;
    if (!opts.force && kept && now - kept.at < DAY_MS) return kept.found && isNewer(kept.found.version, opts.current) ? kept.found : undefined;
  } catch {
    // unreadable: ask again
  }
  let found: Available | undefined;
  try {
    const res = await opts.fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) return undefined;
    found = pick((await res.json()) as Release, opts.current, opts.arch);
  } catch {
    return undefined;
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
