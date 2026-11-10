# Threadbear on Linux

Two things, and they are separate:

- **A runner on Linux** (INSTALL.md, section 6): the runner as a systemd user
  service, installed by `runner/scripts/install-runner.sh`, built from a git
  checkout and following `main`. That is the original, for a server.
- **The desktop app on Linux** (this page): the window for your threads that the
  Windows app is, built from the same code (`desktop-tauri/`), packaged with its own
  Node and the runner as a `.tar.gz`. It runs the runner from the files it was
  installed with, as the Windows one does, and sets it up as a systemd user
  service of its own. Use one of the two runner installs on a machine, not both.

## What it is

`threadbear-v<version>-linux-<x64|arm64>.tar.gz`, from the **linux** workflow
(`.github/workflows/linux.yml`), which builds each architecture on GitHub's
Ubuntu image of that kind and attaches the tarball to its run. A release
(`release.yml`) runs that workflow too, checks both packages of both
architectures (`installer/validate-release-assets.sh`), and attaches them to
the GitHub release beside the Windows ones, with their SHA-256 in
`CHECKSUMS.txt`. They are not signed.

    threadbear-desktop         the shell (Tauri 2, WebKitGTK)
    node/bin/node              the pinned Node (installer/node.json)
    runner/  desktop/  docs/   what the shell and the runner need, in the repo's own layout
    install.sh                 adds a launcher to the applications menu
    README-LINUX.txt  THIRD-PARTY-NOTICES.txt  LICENSE  README.md  INSTALL.md

Unpack it anywhere, run `./threadbear-desktop`, or `./install.sh` once to get a
menu entry. The first time it opens it offers to set the runner up
(`threadbear-desktop --runner --dry-run` says what that does first):

- `~/.config/systemd/user/threadbear-runner.service`, which runs the
  supervisor (`runner/scripts/windows-run.mjs`, shared with Windows) with the
  package's Node. It starts when you log in, restarts the runner after longer
  and longer waits while it keeps failing, and stops by itself when another
  runner has the data folder.
- `~/.local/bin/tb`, a two-line script that runs `tb` with that Node.
- Nothing else outside the unpacked folder, apart from the runner's data
  (`~/Library/Application Support/Threadbear`, the name macOS gives it, which the
  runner keeps on Linux), its logs in `~/Library/Logs`, and the Claude Agent
  SDK it fetches from npm on the first start into `~/.cache/threadbear/sdk`
  (it is Anthropic's, all rights reserved, so it is not in the package).

The service's PATH is the one of the program that installed it, with
`~/.local/bin` (where `claude` is) and the app's Node first, because a systemd
user service starts with almost none.

### The .deb

The same folder as a Debian package, `threadbear-v<version>-linux-<x64|arm64>.deb`
(installer/linux/deb.mjs, built by the same workflow). It puts the folder in
`/opt/threadbear`, a menu entry and icon where the desktop looks, and a
`threadbear-desktop` command in `/usr/bin`:

    sudo apt install ./threadbear-v0.1.0-linux-x64.deb

It needs `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `git`, `bash` and `ca-certificates`
(apt fetches them), and recommends `libayatana-appindicator3-1` for the tray.
A pre-release's version is spelled with a `~` (`0.1.0~rc.1`), so apt sorts it
before the release it leads to. The package has no install scripts. The runner's
systemd user service is set up per user by the app when it first opens, as from
the tarball, so `apt remove threadbear` takes the program away and leaves each
user's data and service for them to decide about (`systemctl --user disable
--now threadbear-runner` and `~/.local/bin/tb` are theirs to remove). The
workflow installs it on an Ubuntu runner, starts the window from `/usr/bin` as
an ordinary user, and removes it again.

## Pairing a phone or a browser

Settings > Phone & browser stays greyed ("no sync.url in runner.json") until the
sync backend exists. It is a Convex deployment in your own account, and
`node scripts/setup-sync.mjs`, run from a clone of the repository, makes it and
restarts the runner (it asks first, and `--dry-run` shows what it would do).
docs/pairing.md has the steps, what it creates, what it costs and how to undo it.
It needs Node 24 or newer, git, tar and flock (util-linux). A server install with
`install-runner.sh` (INSTALL.md, section 6) joins a backend that a Mac set up
instead.

## What it needs

WebKitGTK 4.1 (Debian and Ubuntu: `libwebkit2gtk-4.1-0`), a desktop session,
systemd for the service (not for the window), and the same things the runner
needs anywhere: Claude Code signed in, git, and bash. The window needs
nothing else installed: the Node and the packages are in the folder.

A tray icon is made when there is somewhere to show it. On GNOME there is none
without an extension, so the window's close button ends the app there rather
than hiding it (on Windows it hides to the tray). The runner goes on either way.

## Where it differs from Windows

| | Windows | Linux |
|---|---|---|
| Runner set-up | Task Scheduler task, `install-windows.mjs` | systemd user service, `install-linux.mjs` |
| Data folder | `%APPDATA%\Threadbear` | `~/Library/Application Support/Threadbear` |
| Logs | `%LOCALAPPDATA%\Threadbear\Logs` | `~/Library/Logs` |
| Window | WebView2 | WebKitGTK |
| Close button | hides to the tray | ends the app |
| Packages | setup exe, MSI, portable zip | `.tar.gz`, `.deb` |
| Signing | Azure Artifact Signing (optional) | none: a tarball, and a SHA-256 beside it |

## Not done

- An `.rpm` or an AppImage. Tauri's bundler can make them, but the package here
  carries the runner and a Node beside the shell, which the bundler's resource
  folders put elsewhere than `find_desktop_dir` looks. The `.deb` is made
  from the same folder by hand instead (installer/linux/deb.mjs); an `.rpm` could
  be made the same way.
- Wayland and X11 differences, and HiDPI, were not looked at on a real desktop:
  the workflow shows the window starts under a virtual X screen, no more.
- A signature. The Windows packages are signed with Azure Artifact Signing; a
  Linux package would be signed with a key the person publishing it makes and
  keeps (a GPG key and a repository, for `apt` to trust it). Today the SHA-256
  beside each file is what there is.
- It was built and started on GitHub's runners, not used on a desktop.
