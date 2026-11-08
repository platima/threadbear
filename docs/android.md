# Threadbear on Android

Two ways, and the first needs nothing built.

## 1. The website, installed

`web/` (docs/website.md) is a client of the phone API and is laid out for a
phone. In Chrome on Android, open the sign-in link from the Mac or Windows
app (Settings, Phone and browser, Open signed in, or the QR code for another
device), then the menu's **Install app**. It opens from the home screen
without the browser's bar. `web/public/manifest.webmanifest` is what makes
Chrome offer it.

What it can't do: a notification while it isn't open. A web page can only show
one if the browser delivers a Web Push to it, which needs the sealed push the
backend sends to an iPhone through Apple (docs/push-relay.md) made for a
second kind of device. That is the same work the app needs (below).

## 2. The app (`android/`)

The same website in an app of its own, for a phone that should have an icon, a
window and a way in that isn't a browser tab. It is built for no deployment in
particular. It is told which one to talk to by the link that pairs it:

- **The QR code for a phone**, which the Mac or Windows app draws under
  Settings, Phone and browser, Pair a phone: `threadbear://pair?url=…&token=…`.
  Point the phone's camera at it and open the link; Android offers it to
  Threadbear because the app is registered for that kind of link
  (`android/src-tauri/tauri.conf.json`, `plugins.deep-link`).
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
runs on Ubuntu, which has the Android SDK, an NDK and a JDK, and leaves an
`threadbear-android-debug-apk` artifact on its run. Download it, copy the
`.apk` to the phone, and open it (Android asks to allow installs from that
app, once). It is signed with the Android debug key, which is enough to
install it. An update installs over it as long as it is signed with the same
key, and a build from another machine uses another debug key, so keep to one.

To build it yourself you need Android Studio (for the SDK, an NDK and a JDK),
Rust with the Android targets (`rustup target add aarch64-linux-android
armv7-linux-androideabi`), and `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME`
set. Then, in `android/`:

    npm ci
    npx tauri android init
    npx tauri android build --apk --debug --target aarch64

`npx tauri android dev` runs it on a phone with USB debugging, or an emulator.

### What is not done

- **Notifications while the app is closed.** The iPhone gets a notification
  sealed with a key only that phone and the backend hold, sent through Apple by
  the push relay. Android needs the same through Firebase Cloud Messaging: a
  second sender beside `convex/push.ts` and `relay/`, a Kotlin service that
  opens the sealed message, a platform on the device row (`phone:registerDevice`
  takes an `apnsToken` and an environment), and a Firebase project whose key the
  relay holds, so whoever publishes the app owns it. That is a change to the
  backend and the protocol document, and a pull request of its own.
- **Scanning the code inside the app.** The phone's camera does it today.
- **A Play Store listing.** It needs a release signing key, a developer
  account, the data safety form and a privacy policy; none of that is in the
  repo. `tauri android build --aab` makes the bundle once there is a key.
- **A tighter content security policy.** `tauri.conf.json` sets it to null,
  as the Windows app does; the page only loads its own files and the
  deployment's address, so a policy that says so is the next thing to try on a
  real phone.

None of it has been run on a phone yet: it was written and built without one.
