// Makes the .deb from the folder installer/linux/stage.mjs staged.
//
//   node installer/linux/stage.mjs --arch x64 --shell desktop/src-tauri/target/release/threadbear-desktop
//   node installer/linux/deb.mjs --arch x64
//
// The package puts that folder in /opt/threadbear, a launcher and an icon where
// the applications menu looks, and a threadbear-desktop command in /usr/bin that
// points back into /opt (the shell finds the bridge and the runner from where
// its own file really is, so the link changes nothing). It has no maintainer
// scripts: dpkg's triggers refresh the menu and the icon cache by themselves,
// and the runner's service is set up per user by the app on its first open, as
// it is from the tarball. Removing the package leaves a user's data and service
// alone, as that belongs to the user.
//
// Options: --arch x64|arm64 (default: this machine's), --version (default:
// desktop/package.json's), --stage (default: build/linux-<arch>/threadbear-v<version>-linux-<arch>),
// --out (default: the folder above the stage), --maintainer (default: the
// THREADBEAR_PUBLISHER variable, else Platima).

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const ARCHES = { x64: 'amd64', arm64: 'arm64' };
const arch = arg('arch', os.arch() === 'arm64' ? 'arm64' : 'x64');
if (!ARCHES[arch]) throw new Error(`--arch is x64 or arm64, not ${arch}`);

const version = arg('version') || execFileSync(process.execPath, [path.join(repo, 'desktop', 'scripts', 'version.mjs'), '--print'], { encoding: 'utf8' }).trim();
// A pre-release has to sort before the release it leads to: Debian does that
// with ~ where semantic versioning uses -, so 0.1.0-rc.1 becomes 0.1.0~rc.1.
// Semantic versioning has no + or : or a second - in the part before it, so
// nothing else needs changing; a build part (+) is kept, as Debian allows it.
function debVersion(v) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(v)) throw new Error(`${v} is not a semantic version`);
  return v.replace('-', '~');
}

const name = `threadbear-v${version}-linux-${arch}`;
const stage = path.resolve(arg('stage', path.join(repo, 'build', `linux-${arch}`, name)));
const outDir = path.resolve(arg('out', path.dirname(stage)));
if (!fs.existsSync(path.join(stage, 'threadbear-desktop'))) throw new Error(`${stage} is not a stage. Run installer/linux/stage.mjs first.`);
const maintainer = arg('maintainer', `${process.env.THREADBEAR_PUBLISHER || 'Platima'} <13729856+platima@users.noreply.github.com>`);
if (/[\r\n]/.test(maintainer)) throw new Error('The maintainer is one line');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-deb-'));
try {
  // --- /opt/threadbear: the staged folder, less the tarball's own launcher script
  const opt = path.join(root, 'opt', 'threadbear');
  fs.mkdirSync(path.dirname(opt), { recursive: true });
  fs.cpSync(stage, opt, { recursive: true, force: true, dereference: false });
  fs.rmSync(path.join(opt, 'install.sh'));

  // Directories 755, programs 755, everything else 644, and no link followed.
  const normalise = (dir) => {
    fs.chmodSync(dir, 0o755);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) normalise(p);
      else if (e.isFile()) fs.chmodSync(p, fs.statSync(p).mode & 0o111 ? 0o755 : 0o644);
    }
  };
  normalise(opt);

  // --- The command, the menu entry, the icon, and the copyright file
  const usrBin = path.join(root, 'usr', 'bin');
  fs.mkdirSync(usrBin, { recursive: true });
  fs.symlinkSync('/opt/threadbear/threadbear-desktop', path.join(usrBin, 'threadbear-desktop'));

  const apps = path.join(root, 'usr', 'share', 'applications');
  fs.mkdirSync(apps, { recursive: true });
  fs.writeFileSync(
    path.join(apps, 'threadbear.desktop'),
    ['[Desktop Entry]', 'Type=Application', 'Name=Threadbear', 'Comment=Your threads, in a window of their own', 'Exec=/opt/threadbear/threadbear-desktop', 'Icon=threadbear', 'Terminal=false', 'Categories=Development;Utility;', 'StartupWMClass=threadbear-desktop', ''].join('\n'),
  );
  fs.chmodSync(path.join(apps, 'threadbear.desktop'), 0o644);

  const icons = path.join(root, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps');
  fs.mkdirSync(icons, { recursive: true });
  fs.copyFileSync(path.join(opt, 'threadbear.png'), path.join(icons, 'threadbear.png'));
  fs.chmodSync(path.join(icons, 'threadbear.png'), 0o644);

  const doc = path.join(root, 'usr', 'share', 'doc', 'threadbear');
  fs.mkdirSync(doc, { recursive: true });
  fs.copyFileSync(path.join(opt, 'LICENSE'), path.join(doc, 'copyright'));
  fs.chmodSync(path.join(doc, 'copyright'), 0o644);

  // --- DEBIAN/control. Installed-Size is in KiB, from the files that go in.
  let bytes = 0;
  const size = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) size(p);
      else if (e.isFile()) bytes += fs.statSync(p).size;
    }
  };
  size(root);
  const control = [
    'Package: threadbear',
    `Version: ${debVersion(version)}`,
    `Architecture: ${ARCHES[arch]}`,
    `Maintainer: ${maintainer}`,
    `Installed-Size: ${Math.ceil(bytes / 1024)}`,
    // The window needs WebKitGTK 4.1 and GTK 3. The runner needs git and bash
    // wherever it runs, and the runner's network calls need the CA store.
    'Depends: libwebkit2gtk-4.1-0, libgtk-3-0, git, bash, ca-certificates',
    // The tray icon, where the desktop has somewhere to show one.
    'Recommends: libayatana-appindicator3-1',
    'Section: devel',
    'Priority: optional',
    'Homepage: https://github.com/platima/threadbear',
    'Description: Your Claude Code threads, in a window of their own',
    ' Threadbear drives the official Claude Code command line tool and shows',
    ' its threads in a desktop window. This package carries its own Node and',
    ' the runner, so nothing else has to be installed apart from Claude Code',
    ' itself. The runner is set up as a systemd user service by the app, for',
    ' the user who opens it.',
    '',
  ].join('\n');
  const dpkgDir = path.join(root, 'DEBIAN');
  fs.mkdirSync(dpkgDir);
  fs.chmodSync(dpkgDir, 0o755);
  fs.writeFileSync(path.join(dpkgDir, 'control'), control);
  fs.chmodSync(path.join(dpkgDir, 'control'), 0o644);

  // --- Build, owned by root whoever builds it, xz packed (what Debian uses)
  fs.mkdirSync(outDir, { recursive: true });
  const deb = path.join(outDir, `${name}.deb`);
  fs.rmSync(deb, { force: true });
  execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', root, deb], { stdio: ['ignore', 'inherit', 'inherit'] });
  const sum = crypto.createHash('sha256').update(fs.readFileSync(deb)).digest('hex');
  fs.writeFileSync(`${deb}.sha256`, `${sum}  ${name}.deb\n`);
  console.log(`${deb}\n${sum}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
