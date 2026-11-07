Threadbear for Windows
======================

Run Threadbear.exe to open the app. Closing its window keeps it in the system
tray; Quit in the tray menu ends it.

What it needs, and does not install
-----------------------------------
- Git for Windows (git-scm.com). The runner uses its bash to run patch actions
  and project checks, and for "tb land". Without it those fail; the rest works.
- Claude Code (the "claude" command), signed in. Open a terminal and run
  "claude auth login" once. Threadbear only ever starts the official claude, and
  under your own login.
- Microsoft Edge WebView2, which Windows 11 already has. The installers check
  for it.
- An internet connection the first time the runner starts. It downloads the
  Claude Agent SDK (about 4 MB, from registry.npmjs.org) once for each version
  of Threadbear, because the SDK is Anthropic's and is not part of this
  package. It is kept in %LOCALAPPDATA%\Threadbear\sdk. If the download fails,
  the runner says why in %LOCALAPPDATA%\Threadbear\Logs\runner-supervisor.log
  and tries again. Behind a proxy, set NODE_USE_ENV_PROXY=1 and HTTPS_PROXY in
  your user environment.

Node.js comes inside this folder (node\node.exe), so nothing else is needed.

The runner
----------
The first time the app opens it offers to start the runner when you sign in to
Windows. That adds one Task Scheduler task for your account (no admin rights)
and puts the "tb" command on your PATH. You can say no and set it up later from
the tray menu, or with "Threadbear.exe --runner". Other switches:

  Threadbear.exe --runner --status      is the task there, and running
  Threadbear.exe --runner --stop        end it (it stays registered)
  Threadbear.exe --runner --uninstall   remove the task and "tb"

Your data
---------
Threads and settings are in %APPDATA%\Threadbear and the logs in
%LOCALAPPDATA%\Threadbear. Uninstalling removes the task and "tb" and leaves
your data alone. (The setup exe's uninstaller also removes the downloaded SDK;
the MSI leaves it in %LOCALAPPDATA%\Threadbear\sdk, which you can delete.)

Updates
-------
The app says in its side rail when a newer release is out. Installing that
release over this one is the update.

Licences
--------
LICENSE is Threadbear's own. THIRD-PARTY-NOTICES.txt lists the other software in
this folder with each licence's text. Node.js's licence is node\LICENSE.
