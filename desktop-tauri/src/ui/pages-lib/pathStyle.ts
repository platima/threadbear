// Paths come back from the runner in its own style: C:\Users\mike\site on a
// Windows runner, /Users/mike/site on a Mac or Linux one. These handle both
// without assuming which, and never use the browser's own idea of a path.

export type Sep = '\\' | '/';

const DRIVE = /^([A-Za-z]:)(?:[\\/]|$)/;
const UNC = /^\\\\([^\\/]+)[\\/]+([^\\/]+)/;

export function isWindowsPath(p: string): boolean {
  return DRIVE.test(p) || UNC.test(p);
}

// The separator a path is written with.
export function sepOf(p: string): Sep {
  if (!isWindowsPath(p)) return '/';
  return p.includes('\\') || !p.includes('/') ? '\\' : '/';
}

export type Parsed = { root: string; parts: string[]; sep: Sep };

// "C:\a\b" is root "C:\" and parts [a, b]; "/a/b" is root "/" and the same.
export function parsePath(p: string): Parsed {
  const sep = sepOf(p);
  let root = '';
  let rest = p;
  const unc = UNC.exec(p);
  const drive = DRIVE.exec(p);
  if (unc) {
    root = `\\\\${unc[1]}\\${unc[2]}\\`;
    rest = p.slice(unc[0].length);
  } else if (drive) {
    root = `${drive[1]}${sep}`;
    rest = p.slice(drive[1]!.length);
  } else if (p.startsWith('/')) {
    root = '/';
  }
  const parts = rest.split(sep === '\\' ? /[\\/]+/ : /\/+/).filter(Boolean);
  return { root, parts, sep };
}

export function buildPath(root: string, parts: string[], sep: Sep): string {
  if (!parts.length) return root || sep;
  const head = root || '';
  return head + parts.join(sep);
}

// The folder above, or undefined at the top of a drive or of /.
export function parentPath(p: string): string | undefined {
  const { root, parts, sep } = parsePath(p);
  if (!parts.length) return undefined;
  return buildPath(root, parts.slice(0, -1), sep);
}

export function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  if (/[\\/]$/.test(dir)) return dir + name;
  return `${dir}${sep}${name}`;
}

// The last part: "site" for C:\work\site and /work/site.
export function baseName(p: string): string {
  const { parts, root } = parsePath(p);
  return parts.at(-1) ?? (root || p);
}

// The folder a file is in, as written.
export function dirName(p: string): string {
  return parentPath(p) ?? p;
}

export type Crumb = { label: string; path: string };

// One entry per level, from the top: C:, Users, mike, site.
export function crumbs(p: string): Crumb[] {
  const { root, parts, sep } = parsePath(p);
  const out: Crumb[] = [];
  if (root) out.push({ label: root.replace(/[\\/]+$/, '') || '/', path: root });
  parts.forEach((part, i) => out.push({ label: part, path: buildPath(root, parts.slice(0, i + 1), sep) }));
  return out;
}

const norm = (p: string): string => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindowsPath(p) ? s.toLowerCase() : s;
};

// `p` below `base`, relative and written the way p is: "src\ui\a.ts". Undefined
// when p is not inside base.
export function relativeTo(base: string, p: string): string | undefined {
  const b = norm(base);
  const n = norm(p);
  if (n === b) return '';
  if (!n.startsWith(`${b}/`)) return undefined;
  const sep = sepOf(p);
  return p.slice(b.length + 1).replace(/[\\/]+/g, sep);
}

export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}
