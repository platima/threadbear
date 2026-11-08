Threadbear for Linux
====================

A window for your Threadbear threads, and the runner behind it. This folder is
the whole thing: it brings its own Node, so nothing else has to be installed
for it, apart from the libraries a desktop program needs (below).

What you need
-------------
 - A Linux desktop on x86-64 or arm64 with WebKitGTK 4.1 (the package is
   libwebkit2gtk-4.1-0 on Debian and Ubuntu, webkit2gtk4.1 on Fedora, and
   webkit2gtk-4.1 on Arch). Ubuntu 22.04 and Debian 12 or later have it.
 - systemd with user services (any current desktop distribution), so the runner
   can start when you log in. Without it the app still works; start the runner
   by hand with: node/bin/node runner/scripts/windows-run.mjs
 - Claude Code, signed in (the runner starts your own claude; it never reads
   its sign-in). Git, and bash for patch commands.
 - The notification area (a tray) is optional. GNOME shows none without an
   extension, so closing the window ends the app there; the runner goes on.

Starting it
-----------
    ./threadbear-desktop

or run ./install.sh once to add Threadbear to your applications menu. The first
time it opens it offers to set the runner up: a systemd user service named
threadbear-runner.service (no root) and a tb command in ~/.local/bin.

    ./threadbear-desktop --runner --dry-run     say what that would do
    ./threadbear-desktop --runner --status      is it installed and running
    ./threadbear-desktop --runner --uninstall   take the service and tb away

The Claude Agent SDK is not in this folder (it is Anthropic's). The runner
fetches it from npm the first time it starts, checked against the hash in
runner/package-lock.json, into ~/.cache/threadbear/sdk.

Where things are
----------------
 - The runner's data folder is ~/Library/Application Support/Threadbear, the
   name macOS gives it, which the runner keeps on Linux. Its token and
   secrets are in it.
 - Its log is ~/Library/Logs/threadbear-runner.log, and the supervisor's
   runner-supervisor.log beside it.

THIRD-PARTY-NOTICES.txt has the licence of everything in this folder. The
source is at https://github.com/mikecann/threadbear and this port's at
https://github.com/platima/threadbear.
