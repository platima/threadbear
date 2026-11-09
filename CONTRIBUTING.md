# Contributing

This repository, [platima/threadbear](https://github.com/platima/threadbear),
is the Windows, Android and Linux port of Mike Cann's
[Threadbear](https://github.com/mikecann/threadbear), kept in step with his
repository. Where a change goes depends on what it is.

## Where things go

| What | Where |
|---|---|
| A bug in the Windows, Android or Linux app, or in how they are packaged and released | An [issue here](https://github.com/platima/threadbear/issues), or a pull request here |
| A bug in the Mac or iPhone app, or in code both share | Mike's repository: an [issue](https://github.com/mikecann/threadbear/issues), or a pull request |
| A fix to code that is Mike's (the runner, the backend, the push relay), found while working on a port | A pull request to [mikecann/threadbear](https://github.com/mikecann/threadbear), from a branch of this fork |
| A change a port needs in that code (a new API version, say) | The same: a pull request to Mike's repository, drafted until he has had a look |
| An idea for a new feature, in any of the apps | A discussion on Mike's repository first (once he has Discussions on; until then an issue there). Please do not open a pull request for a feature before that |
| A question about the Windows, Android or Linux apps | An issue here |

The line is Mike's: bug fixes and what the ports need come back to him as pull
requests, and features are talked about before they are written. The code
that only exists here (`desktop/`, `android/`, `installer/`, the packaging and
release workflows) is this repository's to change.

## Pull requests to this repository

- Work on a branch of your own fork and open the pull request against `main`.
- The checks run on GitHub's machines. `windows.yml` runs the runner's tests
  on Windows (it reports but does not block, so a Windows test never holds
  back a Mac release), `linux.yml` and `android.yml` build and run the Linux
  and Android apps, and `installers.yml` builds the Windows packages.
- Do not put anything private in a pull request: no keys, no signing
  certificates, no `google-services.json`, no service account files. The
  Android release key is a secret of the `release` environment, the Firebase
  files are repository secrets (`docs/android.md`), and a pull request from a
  fork never gets either.
- Keep to the style of the file you are in. Commit messages say what changed
  and why, in plain words.
- If your change touches code that came from Mike, say so in the pull request.
  It may need to go to him as well, and merging his `main` into this one is
  simpler when the change is the same on both sides.

## Linux

The Linux port is kept working here, but it is built and tested only on
GitHub's Ubuntu machines. If you run Threadbear on a Linux desktop every day and
would like to look after it, open an issue and say so.

## Reporting a security problem

See [SECURITY.md](SECURITY.md). Please do not open a public issue for one.
