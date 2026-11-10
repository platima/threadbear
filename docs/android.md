# Threadbear on Android

Two ways, and the first needs nothing built.

Both ways need a Convex deployment of your own for the computer to pair with. On
Windows and Linux, `node scripts/setup-sync.mjs` from a clone of the repository
makes one and turns on the "Show a code" button; docs/pairing.md says how, what it
creates, what it costs and how to undo it.

## 1. The website, installed

`web/` (docs/website.md) is a client of the phone API and is laid out for a
phone. In Chrome on Android, open the sign-in link from the Mac or Windows
app (Settings, Phone and browser, Open signed in, or the QR code for another
device), then the menu's **Install app**. It opens from the home screen
without the browser's bar. `web/public/manifest.webmanifest` is what makes
Chrome offer it.

What it can't do: a notification while it isn't open. A web page can only show
one if the browser delivers a Web Push to it, which would need a third kind of
sender. The app has notifications (below).

## 2. The app (`android/`)

The same website in an app of its own, for a phone that should have an icon, a
window and a way in that isn't a browser tab. It is built for no deployment in
particular. It is told which one to talk to by the link that pairs it:

- **The QR code for a phone**, which the Mac or Windows app draws under
  Settings, Phone and browser, Pair a phone: `threadbear://pair?url=…&token=…`.
  Point the phone's camera at it and open the link; Android offers it to
  Threadbear because the app is registered for that kind of link
  (`android/src-tauri/tauri.conf.json`, `plugins.deep-link`).
- **Or scan it inside the app**: the first screen's "Scan the code" opens
  Google's code scanner over the app (a command of the push plugin,
  `plugin:threadbear-push|scan`, in `android/plugins/push`). It needs Google
  Play services, has its own camera screen and asks for no camera permission
  of the app's own. Its module is fetched by Google Play services: the manifest asks
  for it at install (`com.google.mlkit.vision.DEPENDENCIES`), which only works for an
  app installed from the Play Store, so the plugin also asks for it when the app starts
  (`ModuleInstall`). On an APK installed by hand the first scan can still find it
  fetching and says to wait a minute and try again. What it reads goes through the same
  check as a pasted link, so a code that is not a pairing (a Wi-Fi code, a menu)
  offers nothing. Backing out, or a phone without Play services, leaves the paste box.
- **Or paste** that link, or the website's sign-in link, into the app's first
  screen (`web/src/pair.tsx`).

Either way the app asks "Pair with <address>?" before it keeps anything, since
the token goes to that address. The address and the token are kept in the app's
own storage (`web/src/deployment.ts`). `web/src/pairing.ts` reads the links, and
its tests (`npm run web:test`) hold what counts as one.

It sees what the iPhone app and the website see (messages and one line per tool
call, with no tool output), and everything it does is a command the runner
applies. It does not need the computer to be on the same network: it talks to
the Convex deployment, as the iPhone does.

### Getting it

GitHub builds it: the **android** workflow (`.github/workflows/android.yml`)
runs on Ubuntu, which has the Android SDK, an NDK and a JDK, and leaves a
`threadbear-android-apk` artifact on its run, and on a release when one is
made with the release key (below). Download the `.apk`, copy it to the phone,
and open it (Android asks to allow installs from that app, once).

It is a release build, signed by `android/scripts/sign-apk.sh`:

- **With the release key** (the four secrets below), every build has the same
  signature, so a phone takes each one as an update of the last. Only a
  release tag, and a rehearsal started by hand from `main`, are signed with
  it: the signing job runs in the repository's `release` environment, which
  holds the key and lets only those refs in. For a release that job is in
  `release.yml` (`sign-android`), not in `android.yml`, because a job of a
  called workflow does not receive an environment's secrets.
- **Without it**, with a key made for that run (every push to a branch, and a
  pull request): enough to install it once, but the next build has another
  key, so the phone has to remove the app first. A release (`release.yml`)
  leaves such an APK off, and says so in its log.

To make the release key, once, and keep the file somewhere safe (lose it and
nobody can update the app without removing it):

    keytool -genkeypair -v -keystore threadbear-release.jks -alias threadbear -keyalg RSA -keysize 4096 -validity 10000

First limit the `release` environment to the refs that may use it (Settings,
Environments, `release`, Deployment branches and tags, **Selected branches and
tags**: the branch `main` and the tag pattern `v*`). A newly made environment
lets every branch and tag in, so without this a workflow on any branch could
name `release` and read the key. Only then add four secrets to it
(**Environment secrets** on the same page; not the repository's own secrets,
which any workflow on any branch can read): `ANDROID_KEYSTORE_BASE64` (the file,
base64 on one line: `base64 -w0 threadbear-release.jks`, or in PowerShell
`[Convert]::ToBase64String([IO.File]::ReadAllBytes("threadbear-release.jks"))`),
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`threadbear` above) and
`ANDROID_KEY_PASSWORD`. The same key later signs a Play Store upload.

A second job in the same workflow runs the release build on an Android 14
emulator (x86_64, with KVM) on every change: it installs the APK, opens it from
the launcher, sends it a `threadbear://pair` link and keeps the screenshots
and log (`threadbear-android-emulator`). That shows the app starts and takes a
link; it is not a phone with a camera or a notification shade.

To build it yourself you need Android Studio (for the SDK, an NDK and a JDK),
Rust with the Android targets (`rustup target add aarch64-linux-android
armv7-linux-androideabi`), and `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME`
set. Then, in `android/`:

    npm ci
    npx tauri android init
    npx tauri android build --apk --debug --target aarch64

`npx tauri android dev` runs it on a phone with USB debugging, or an emulator.

### Notifications

A thread that needs the person becomes a notification, with the app closed, as
on the iPhone: the text is sealed on the person's own backend with a key only
that phone and the backend hold, and the push relay (docs/push-relay.md) carries
only the sealed bytes through Firebase Cloud Messaging.

- **On the phone**: the gear menu's **Notifications on this phone**, in the app
  (not the browser), once it is paired. It asks Android for the permission, then
  registers the phone's Firebase token and its own push key with the backend
  (`phone:registerDevice` with `platform: "android"`, API 66). The same row turns
  it off. Android is asked only when the row is turned on, never at start.
- **The plugin** is `android/plugins/push`: Kotlin that starts Firebase from the
  project's `google-services.json`, makes the push key (kept wrapped by a key in
  the Android Keystore), and receives the message in a `FirebaseMessagingService`
  that opens the sealed text and posts the notification, with the app running or
  not. A thin Rust side lets the page call it. Tapping a notification opens the
  app; going to the thread from it is not done.
- **Which backend and relay**: the backend needs API 66 (the gear row says so
  when it is older) and the relay needs its Firebase sender (`relay/convex/fcm.ts`)
  and `FCM_SERVICE_ACCOUNT`. Deploy the relay first: an old relay turns an
  Android token down as a bad request, and the backend would report its pushes as
  failing.

Whoever publishes the app owns the Firebase project, since the relay's key sends
for every phone that has the app built for it. To set one up:

1. In the Firebase console, make a project and add an Android app with the
   package name in `android/src-tauri/tauri.conf.json` (`com.tinkerware.threadbear`
   here). Download its `google-services.json`.
2. Add it to the repository as the secret `ANDROID_GOOGLE_SERVICES_JSON` (the
   file's contents). Builds without it have no notifications and work as before.
   To build by hand, put the file in
   `android/plugins/push/android/src/main/assets/`.
3. Make a service account key (Project settings, Service accounts, Generate new
   private key). Give its contents to the relay as `FCM_SERVICE_ACCOUNT`
   (`npx convex env set FCM_SERVICE_ACCOUNT -- "$(cat key.json)"` in `relay/`).
   Keep the file out of every repository.
4. Optionally the same contents as the repository secret `FIREBASE_SERVICE_ACCOUNT`:
   the emulator job then sends the app a sealed notification and looks for it in
   the notification shade. It builds its own copy of the app for that, with a
   push key it knows and the token logged; the app people install has neither.

### What is not done

- **Going to the thread from a notification**, and grouping several.
- **Notifications on a real phone.** They have been seen on an emulator only
  (the check above); Firebase's delivery to a sleeping phone, its battery
  savers and a manufacturer's own app killers are not tested here.
- **Scanning the code inside the app on a phone without Google Play
  services.** The scanner is Google's; such a phone uses its camera app or the
  paste box. The scanner has not been run on a phone yet: it is checked by
  the build and by the page's tests against a stand-in for it.
- **A Play Store listing.** It needs a release signing key, a developer
  account, the data safety form and a privacy policy; none of that is in the
  repo. `tauri android build --aab` makes the bundle once there is a key.
- **A tighter content security policy.** `tauri.conf.json` sets it to null,
  as the Windows app does; the page only loads its own files and the
  deployment's address, so a policy that says so is the next thing to try on a
  real phone.

None of it has been run on a phone yet: it was written and built without one,
and run on an emulator in CI.
