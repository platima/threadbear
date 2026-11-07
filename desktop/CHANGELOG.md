# Changelog

The Windows app (`desktop/`) and its installers (`installer/`). The runner and
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

- Threadbear for Windows: a window and a tray icon around the threads, asks and approvals the Mac app has, and most of its panels. Closing the window keeps it in the tray, and Quit ends it.
- The runner runs on Windows 11, with Claude Code. It starts when you sign in, through a Task Scheduler task the app offers to set up the first time you open it, and the app starts it again after an update.
- Toasts when a thread needs you or finishes, a folder picker for new threads, and links that open in your browser.
- Setup exe, MSI and a portable zip, for x64 and for Windows on Arm (the Arm builds are made by the same workflow but have not been run on an Arm PC yet). Node comes inside, so nothing else has to be installed except Claude Code itself and Git for Windows. The Claude Agent SDK is Anthropic's and is not in the package: the runner downloads it from npm (about 4 MB, checked against its hash) the first time it starts, so that start needs an internet connection.
- Codex works too, when its `codex.exe` is on your PATH. Threadbear does not install or update it on Windows.
- Not on Windows: BrowserBear, ComputerCub, docker sandboxes, spotting a stuck CLI, and runner updates that follow `main`.

### Added

- The desktop app: threads, the transcript, the composer with pictures, asks and review cards, Projects, Schedules, Usage, Runners and Settings pages, Highlights, Actions, Agents and Files panes, a first-run tour, and the shortcuts sheet.
- `Threadbear.exe --runner [--status | --start | --installed | --stop | --uninstall | --dry-run]` and `--quit`, for installers and for people who like a terminal. Their answers print to the terminal that ran them.
- A launch key on the bridge between the window and the runner, so no other program on the PC can use it. The bridge keeps the same address between launches, so the app remembers its settings, and sends a content security policy, so a remote picture in a message shows as its description.
- A check once a day for a newer release of the fork, shown as a link in the rail. It downloads nothing, and Settings, "This app", turns it off.
- Windows support in the runner: process handling, Git Bash as the shell, a Task Scheduler install, Windows paths in messages and links, and trust checks that follow the spellings Windows gives a path (short names, `/c/...`, `.cmd` and `.exe` programs).
- Licence notices for everything in the package (`THIRD-PARTY-NOTICES.txt`) and a `README-WINDOWS.txt` in the zip.
