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

- Threadbear for Windows: a window and a tray icon around the same threads, asks, approvals and panels the Mac app has. Closing the window keeps it in the tray, and Quit ends it.
- The runner runs on Windows 10 and 11, with Claude Code. It starts when you sign in, through a Task Scheduler task the app offers to set up the first time you open it.
- Toasts when a thread needs you or finishes, a folder picker for new threads, and links that open in your browser.
- Setup exe, MSI and a portable zip, for x64 and for Windows on Arm. Node comes inside, so nothing else has to be installed except Claude Code itself and Git for Windows.
- Codex works too, when its `codex.exe` is on your PATH. Threadbear does not install or update it on Windows.

### Added

- The desktop app: threads, the transcript, the composer with pictures, asks and review cards, Projects, Schedules, Usage, Runners and Settings pages, Highlights, Actions, Agents and Files panes, a first-run tour, and the shortcuts sheet.
- `Threadbear.exe --runner [--status | --installed | --stop | --uninstall | --dry-run]` and `--quit`, for installers and for people who like a terminal.
- A launch key on the bridge between the window and the runner, so no other program on the PC can use it.
- Windows support in the runner: process handling, Git Bash as the shell, a Task Scheduler install, Windows paths in messages and links.
