#!/bin/sh
# Puts the app's own icons into the Gradle project Tauri makes, from android/.
#
#   sh scripts/apply-icons.sh        (after `npx tauri android init`, before the build)
#
# `tauri android init` writes its own launcher icons (the yellow and blue Tauri
# logo) into src-tauri/gen/android and does not look at src-tauri/icons/android,
# so the first APKs showed Tauri's logo, not the bear. The bear's icons are kept
# in src-tauri/icons/android: the plain ones for older phones, and an adaptive
# one (a foreground drawn inside the safe zone, on the background colour in
# values/ic_launcher_background.xml) for Android 8 and up, whose launcher cuts it
# to a circle or a rounded square.
set -eu

src=src-tauri/icons/android
dst=src-tauri/gen/android/app/src/main/res

[ -d "$src" ] || { echo "apply-icons: no $src here (run it from android/)" >&2; exit 1; }
[ -d "$dst" ] || { echo "apply-icons: no $dst (run tauri android init first)" >&2; exit 1; }

cp -R "$src/." "$dst/"

# Proof it took, where the template's own files would have been
for f in mipmap-xxxhdpi/ic_launcher.png mipmap-xxxhdpi/ic_launcher_round.png mipmap-xxxhdpi/ic_launcher_foreground.png mipmap-anydpi-v26/ic_launcher.xml values/ic_launcher_background.xml; do
	cmp -s "$src/$f" "$dst/$f" || { echo "apply-icons: $f was not copied" >&2; exit 1; }
done
echo "apply-icons: the app's own icons are in the Gradle project"
