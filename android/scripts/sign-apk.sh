#!/bin/sh
# Aligns and signs an unsigned release APK, and proves the signature.
#
#   sh android/scripts/sign-apk.sh <unsigned.apk> <signed.apk>
#
# With the release key in the environment, the APK is signed with it, so a
# phone takes each release as an update of the last:
#
#   ANDROID_KEYSTORE_BASE64    the keystore (.jks or .p12), base64 on one line
#   ANDROID_KEYSTORE_PASSWORD  its password
#   ANDROID_KEY_ALIAS          the key's alias in it
#   ANDROID_KEY_PASSWORD       the key's password (the keystore's, if left out)
#
# With none of them set it makes a key of its own for this run and signs with
# that: enough to install the APK on a phone or an emulator, but the next build
# has another key, so a phone has to remove the app before it takes it. The last
# line it prints is `signed=true` for the release key and `signed=false` for a
# key made for the run, for a workflow to read.
#
# It needs the Android SDK's build-tools (ANDROID_HOME) and a JDK's keytool.
# The keystore is written under $RUNNER_TEMP (else the temp folder), read once
# and removed, and no password is ever printed.
set -eu

[ $# -eq 2 ] || { echo "usage: sign-apk.sh <unsigned.apk> <signed.apk>" >&2; exit 2; }
in=$1
out=$2
[ -f "$in" ] || { echo "sign-apk: $in is not a file" >&2; exit 1; }
[ -n "${ANDROID_HOME:-}" ] || { echo "sign-apk: ANDROID_HOME is not set" >&2; exit 1; }

# The newest build-tools the SDK has
tools=$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -n 1)
[ -n "$tools" ] && [ -x "$tools/apksigner" ] || { echo "sign-apk: no build-tools with apksigner under $ANDROID_HOME" >&2; exit 1; }

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sign-apk.XXXXXX")
trap 'rm -rf "$work"' EXIT

if [ -n "${ANDROID_KEYSTORE_BASE64:-}" ]; then
	[ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ] && [ -n "${ANDROID_KEY_ALIAS:-}" ] || { echo "sign-apk: ANDROID_KEYSTORE_BASE64 is set without ANDROID_KEYSTORE_PASSWORD and ANDROID_KEY_ALIAS" >&2; exit 1; }
	printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 -d >"$work/release.jks"
	ks=$work/release.jks
	alias=$ANDROID_KEY_ALIAS
	SIGN_STORE_PASS=$ANDROID_KEYSTORE_PASSWORD
	SIGN_KEY_PASS=${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}
	signed=true
	echo "Signing with the release key (alias $alias)"
else
	ks=$work/run.jks
	alias=run
	# Random, and only for this run
	SIGN_STORE_PASS=$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')
	SIGN_KEY_PASS=$SIGN_STORE_PASS
	export SIGN_STORE_PASS
	keytool -genkeypair -keystore "$ks" -alias "$alias" -keyalg RSA -keysize 2048 -validity 3650 \
		-storepass:env SIGN_STORE_PASS -keypass:env SIGN_STORE_PASS -dname "CN=Threadbear build made for one run" >/dev/null
	signed=false
	echo "No release key given: signing with a key made for this run, which the next build will not share"
fi
export SIGN_STORE_PASS SIGN_KEY_PASS

# Aligned for the page-size rules of newer Androids (-P 16 also aligns the native
# libraries to 16 KiB), then signed (v2 and v3 schemes, as Android 11 and up want)
"$tools/zipalign" -P 16 -f 4 "$in" "$work/aligned.apk" || "$tools/zipalign" -p -f 4 "$in" "$work/aligned.apk"
"$tools/apksigner" sign --ks "$ks" --ks-key-alias "$alias" --ks-pass env:SIGN_STORE_PASS --key-pass env:SIGN_KEY_PASS --out "$out" "$work/aligned.apk"
"$tools/apksigner" verify --verbose --print-certs "$out" | grep -E "Verifies|Verified using|Number of signers|certificate SHA-256 digest" || true
"$tools/apksigner" verify "$out"
ls -l "$out"
echo "signed=$signed"
