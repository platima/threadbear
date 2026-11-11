Threadbear for Windows
======================

Run Threadbear.exe to open the app. Closing its window keeps it in the system
tray; Quit in the tray menu ends it. (Settings, This app has an Exit on close box
if you would rather closing the window ended it.)

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
and puts the "tb" command on your PATH. If you say no, it offers a second way:
a runner that starts only while Threadbear is open (the same task with nothing
that starts it at sign-in; the app starts it when it opens and stops it when you
quit). Say no to both and nothing starts, and the app shows "Not connected to the
runner" with a Start the runner button. You can set either kind up later from the
tray menu, or with "Threadbear.exe --runner" (at sign-in) or
"Threadbear.exe --runner --on-demand" (only while the app is open). Other switches:

  Threadbear.exe --runner --mode        sign-in, on-demand or none
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
release over this one is the update. The setup exe asks Threadbear to quit and
its runner to stop first, then waits up to 20 seconds for their files to be
free. If a program is still using them, it says which and asks whether to end
it. A /VERYSILENT install cannot ask, so it ends nothing unless it is run with
/ENDRUNNING=1. If something it may not end, or was not allowed to end, is in
the way, it stops before changing any file and says which file and program.
Threadbear and its runner have been stopped by then, if it asked them to: it
asks the runner to start again, and you open Threadbear from the Start menu.
It will not install into a folder that other programs share, such as Program
Files itself or a drive root: choose a folder of its own. The MSI asks
Threadbear to quit too but does not wait for it, so quit Threadbear yourself
before running the MSI.

Licences
--------
LICENSE is Threadbear's own. THIRD-PARTY-NOTICES.txt lists the other software in
this folder with each licence's text. Node.js's licence is node\LICENSE.
