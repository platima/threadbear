# Threadbear on Linux

Two things, and they are separate:

- **A runner on Linux** (INSTALL.md, section 6): the runner as a systemd user
  service, installed by `runner/scripts/install-runner.sh`, built from a git
  checkout and following `main`. That is the original, for a server.
- **The desktop app on Linux** (this page): the window for your threads that the
  Windows app is, built from the same code (`desktop/`), packaged with its own
  Node and the runner as a `.tar.gz`. It runs the runner from the files it was
  installed with, as the Windows one does, and sets it up as a systemd user
  service of its own. Use one of the two runner installs on a machine, not both.

## What it is

`threadbear-v<version>-linux-<x64|arm64>.tar.gz`, from the **linux** workflow
(`.github/workflows/linux.yml`), which builds each architecture on GitHub's
Ubuntu image of that kind and attaches the tarball to its run:

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
| Packages | setup exe, MSI, portable zip | `.tar.gz` |
| Signing | Azure Artifact Signing (optional) | none: a tarball, and a SHA-256 beside it |

## Not done

- A `.deb`, an `.rpm` or an AppImage. Tauri's bundler can make them, but the
  package here carries the runner and a Node beside the shell, which the
  bundler's resource folders put elsewhere than `find_desktop_dir` looks; that
  needs a pass on a real distribution.
- Wayland and X11 differences, and HiDPI, were not looked at on a real desktop:
  the workflow shows the window starts under a virtual X screen, no more.
- A release on GitHub with these attached: `release.yml` makes the Windows ones.
- It was built and started on GitHub's runners, not used on a desktop.
