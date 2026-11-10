# Changelog

The Windows app (`desktop-tauri/`) and its installers (`installer/`). The runner and
the Mac and iPhone apps have their own history in git; this file is only for
what a person installing the Windows app would notice.

Versions follow [semantic versioning](https://semver.org). While the major is 0,
a minor bump is a round of features or a change in how the app behaves, and a
patch bump is fixes only. Each entry opens with a `### ✨ Highlights` list: three
to six bullets in plain language, naming anything that is not on every platform.
`installer/release-notes.sh` publishes it as the GitHub release notes, and the
release stops before anything is published if it is missing.

## [0.1.0] - Unreleased

### ✨ Highlights

- Threadbear for Windows: a window and a tray icon around the threads, asks and approvals the Mac app has, and most of its panels, a Terminal included (PowerShell, WSL, Git Bash). Closing the window keeps it in the tray, and Quit ends it.
- The runner runs on Windows 11, with Claude Code. It starts when you sign in, through a Task Scheduler task the app offers to set up the first time you open it, and the app starts it again after an update. If you would rather it did not run all the time, say no and the app offers a runner that starts only while Threadbear is open and stops when you quit it.
- rc.4: the Start the runner button in the connection banner now works when no runner is set up (it did nothing in rc.3): it offers "Only while Threadbear is open" and "When I sign in" in the window itself. What the app does about the runner is written to `shell.log` in `%LOCALAPPDATA%\Threadbear`, so if it still fails there is something to read.
- rc.5: the Start the runner button now waits for the runner to answer instead of offering a second click, and says where `shell.log` is if it never does. The Terminal draws in the font Windows Terminal is set to, so the symbols an oh-my-posh or Powerline prompt uses show up (a Nerd Font is still needed), with a Font menu in its header. The Connectors button is in the rail even when the runner has no gateway, with a page that says so.
- rc.5: a phone or a browser can be paired from Windows and Linux. The sync backend it needs is set up by `node scripts/setup-sync.mjs` from a clone of the repository (`docs/pairing.md`), which makes a Convex project in your own account. Android: Scan the code in the app failed with a raw null error, because the release build's shrinker had removed what ML Kit starts itself from. The build now keeps it and a failure says where it came from. The emulator check reaches Google's scanner; the camera itself has not been tried on a phone.
- When a login has run out, the error is shown once, with a button for each of `claude auth login` and `claude setup-token` that opens a terminal on it. Settings, "This app", has an Exit on close box (off by default, so closing the window still leaves the app in the tray).
- Toasts when a thread needs you or finishes, a folder picker for new threads, and links that open in your browser. Several approvals at once come as one card with a tick on each call, as on the Mac, so a reply with eight edits is one click and not eight.
- Setup exe, MSI and a portable zip, for x64 and for Windows on Arm (the Arm builds are made by the same workflow but have not been run on an Arm PC yet). Node comes inside, so nothing else has to be installed except Claude Code itself and Git for Windows. The Claude Agent SDK is Anthropic's and is not in the package: the runner downloads it from npm (about 4 MB, checked against its hash) the first time it starts, so that start needs an internet connection.
- Codex works too, when its `codex.exe` is on your PATH. Threadbear does not install or update it on Windows.
- Not on Windows: BrowserBear, ComputerCub, docker sandboxes, spotting a stuck CLI, and runner updates that follow `main`.
- Linux too: a `.deb` and a `.tar.gz` for x64 and arm64, with the same window and its own Node, and the runner as a systemd user service (`docs/linux.md`). They are not signed, and have been started on GitHub's Ubuntu machines but not used on a desktop yet.

### Added

- The desktop app: threads, the transcript, the composer with pictures, asks and review cards, Projects, Schedules, Usage, Runners and Settings pages, Highlights, Actions, Agents and Files panes, a first-run tour, and the shortcuts sheet.
- A Terminal under the thread (Ctrl+J), as the Mac app has: a real shell in the thread's folder, one for each thread, started only when you ask and kept running while you look at other threads, and found again if the window is reloaded. It starts PowerShell 7 if the PC has it and Windows PowerShell 5.1 otherwise; WSL distributions (listed by `wsl.exe`), Git Bash and Command Prompt are offered too, and the menu in its header, or Settings, "This app", changes the default. On Linux it uses your login shell. The shells are children of the app's bridge and end with it; the pseudo-terminal is `@lydell/node-pty` (prebuilt, MIT, with Microsoft's ConPTY files on Windows).
- The rail is laid out as the Mac app's is: Threads, Projects and Scheduled at the top, and Connectors, Runners, Updates, Usage and Settings together at the foot. Usage is a honey pot filled to the room left on the login with the most room, and its tooltip says how much.
- An Updates page, as the Mac app has an Updates panel: this app's version and whether a newer release is out, how the runner updates and whether threads are still finishing on a previous version, and Claude Code's updates, in one place.
- A Connectors page, for a runner that has a Connectors gateway set up: the services your agents get from it, which need signing in, and buttons that open each sign-in page in your browser. For a runner with no gateway the page says there is none, what one is for, and links to the guide; the button is left out of the rail only for a runner too old to answer, and gets a dot when a service needs you. The window never talks to the gateway; the runner does.
- `Threadbear.exe --runner [--status | --start | --installed | --stop | --uninstall | --dry-run]` and `--quit`, for installers and for people who like a terminal. Their answers print to the terminal that ran them.
- A launch key on the bridge between the window and the runner, so no other program on the PC can use it. The bridge keeps the same address between launches, so the app remembers its settings, and sends a content security policy, so a remote picture in a message shows as its description.
- A check once a day for a newer release of the fork, shown as a link in the rail. It downloads nothing, and Settings, "This app", turns it off.
- Windows support in the runner: process handling, Git Bash as the shell, a Task Scheduler install, Windows paths in messages and links, and trust checks that follow the spellings Windows gives a path (short names, `/c/...`, `.cmd` and `.exe` programs).
- Licence notices for everything in the package (`THIRD-PARTY-NOTICES.txt`) and a `README-WINDOWS.txt` in the zip.
- A second kind of runner, started with `--runner --on-demand` or from the offer, tray menu or the connection banner's Start the runner button: no sign-in trigger, started by the app when it opens and stopped when it quits. `--runner --mode` says which kind is set up. The same on Linux, as a systemd user service that is not enabled.
- Exit on close (Settings, "This app", Windows only). On Linux closing the window always ends the app.
- An Updates button in the rail, always there, with a dot while a newer release is out (it opens the Updates page, below). A copy that is itself a pre-release (every release so far) is now told about newer pre-releases, which the check never did before.
- Tooltips that say what a control is for (pages and panes carry a hint), and a test that keeps every control's tooltip from being only its label.
- A Font menu in the Terminal's header: Same as Windows Terminal (its default profile's font and size, read from its `settings.json` when the panel opens, and only the font names and the size are taken from it), Default, or a font name, or a comma-separated list of names as Windows Terminal takes, that you type. Windows Terminal's 12 points is drawn as 16 pixels, so the Terminal is larger than it was. The Nerd Fonts that are installed supply the symbols the chosen font lacks.
- `node scripts/setup-sync.mjs` (Windows and Linux): Convex login, a project and production deployment of your own, the keys, `runner.json`, the backend and website deployed, and the runner restarted. It is safe to run again, `--dry-run` shows what it would do, and `docs/pairing.md` says what it makes and how to undo it. Settings, Phone & browser, says to run it when sync is off.

### Fixed

- A turn that failed because the login ran out showed its error twice.
- The Archive menu in the done card was cut off by the scrolling box around it, and the first message's Edit button by the top of the window. Every menu list is now fixed to the window from its button.
- Your own messages sit on the right, no wider than most of the column.
- The pairing button and the model menu say why they are greyed out (no runner connected, no login found, or no models listed yet) and no longer tell a Codex user to run Claude Code.
- The connection banner's Start the runner button did nothing in 0.1.0-rc.3 when no runner was set up, and so did the Exit on close box and the sign-in buttons: Tauri 2.11 refuses the app's own commands to a page served from `127.0.0.1` unless each is granted, and none was. They are granted now. The button asks how the runner is set up and, with none, offers "Only while Threadbear is open" and "When I sign in" in the window itself, and it gives up with a message after a minute rather than staying on "Starting...". What the app does about the runner is kept in `shell.log` in `%LOCALAPPDATA%\Threadbear`.
- After Start the runner said it had started the runner, the banner kept showing the button until the app's next reconnect try. The app now tries at once and for about 20 seconds, shows "Waiting for the runner to answer..." in place of the button, and says where `shell.log` is if the runner still cannot be reached.
- The Terminal drew a fixed list of fonts, so the private use symbols of an oh-my-posh or Powerline prompt showed as boxes for anyone who had set a Nerd Font in Windows Terminal.
- On Windows, a thread's `tb` and its secrets check now work out which thread a connection comes from (`netstat` and a PowerShell process query), and the secrets folder is refused under more spellings (case, `$env:THREADBEAR_HOME`, `%THREADBEAR_HOME%`, short names). The runner's own Node is on a thread's PATH.
