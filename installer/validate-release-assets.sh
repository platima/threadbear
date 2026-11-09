#!/bin/sh
# Check that <dir> holds a complete, consistent set of release assets for
# <tag> (e.g. v0.1.0): every Windows package for x64 and arm64, and the Linux
# tarball and .deb for each, each with a .sha256 that verifies, each plausibly
# sized, and the programs inside each zip, tarball and .deb built for the
# architecture its name claims. Also proves the app's update
# check can find its download on this release, for every architecture it knows,
# and that nothing else is in the folder.
# If <dir>/CHECKSUMS.txt is there it is checked too: exactly one line for each
# of the ten packages, in the form `sha256sum -c` reads (hash, two spaces, name;
# no comments, no blank lines, no carriage returns), each hash the file's own.
# --checksums makes CHECKSUMS.txt required.
# Usage: installer/validate-release-assets.sh [--checksums] <dir> <tag>   (run from the repo root)
# release.yml runs it on the build artifacts before anything is published, and
# again with CHECKSUMS.txt added; it works the same on a directory you downloaded.
set -eu

need_checksums=0
if [ "${1:-}" = "--checksums" ]; then
	need_checksums=1
	shift
fi
[ $# -eq 2 ] || { echo "usage: validate-release-assets.sh [--checksums] <dir> <tag>" >&2; exit 2; }
dir=$1
tag=$2
failed=0

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
: >"$tmp/allowed"  # every name that may be in the folder
: >"$tmp/want"     # the CHECKSUMS.txt lines the folder's own bytes call for

fail() {
	echo "ERROR: $*"
	failed=1
}

check() {
	name=$1
	min_size=$2
	f=$dir/$name
	echo "$name" >>"$tmp/allowed"
	echo "$name.sha256" >>"$tmp/allowed"
	if [ ! -f "$f" ]; then
		fail "missing $name"
		return 0
	fi
	size=$(wc -c <"$f" | tr -d ' ')
	if [ "$size" -lt "$min_size" ]; then
		fail "$name is implausibly small ($size bytes, expected >= $min_size)"
	else
		echo "OK: $name ($size bytes)"
	fi
	got=$(sha256sum "$f" | cut -d' ' -f1)
	echo "$got  $name" >>"$tmp/want"
	# Hash the asset itself and compare with the companion's digest. Not
	# `sha256sum -c`: that checks whichever file the companion NAMES, so a
	# companion carrying another asset's line would vouch for a corrupt file.
	if [ ! -f "$f.sha256" ]; then
		fail "missing checksum $name.sha256"
		return 0
	fi
	if [ "$(wc -l <"$f.sha256" | tr -d ' ')" -ne 1 ]; then
		fail "$name.sha256 should be exactly one line"
	fi
	read -r want listed <"$f.sha256" || true
	listed=${listed#\*} # sha256sum's binary-mode marker
	if ! printf '%s' "$want" | grep -Eq '^[0-9a-fA-F]{64}$'; then
		fail "$name.sha256 does not start with a SHA-256 digest"
	fi
	if [ "$listed" != "$name" ]; then
		fail "$name.sha256 names '$listed', not $name"
	fi
	if [ "$(printf '%s' "$want" | tr 'A-F' 'a-f')" != "$got" ]; then
		fail "$name does not match $name.sha256 (expected $want, got $got)"
	fi
}

# The PE machine field of a file's first bytes: 8664 for x64, aa64 for arm64.
pe_machine() {
	off=$(od -An -t u4 -j 60 -N 4 "$1" | tr -d ' ')
	od -An -t x2 -j $((off + 4)) -N 2 "$1" | tr -d ' '
}

[ -d "$dir" ] || { echo "ERROR: $dir is not a folder"; exit 1; }

# Windows: threadbear-v<version>-<type>-win-<arch>.<ext>
for arch in x64 arm64; do
	check "threadbear-$tag-setup-win-$arch.exe" 10000000
	check "threadbear-$tag-msi-win-$arch.msi" 10000000
	check "threadbear-$tag-portable-win-$arch.zip" 10000000
	zip=$dir/threadbear-$tag-portable-win-$arch.zip
	if [ -f "$zip" ]; then
		want=8664
		[ "$arch" = arm64 ] && want=aa64
		# The program and the Node it carries must both be this architecture.
		# Only the start of each is read: the headers are in the first bytes.
		for inner in Threadbear/Threadbear.exe Threadbear/node/node.exe; do
			if unzip -p "$zip" "$inner" 2>/dev/null | head -c 4096 >"$tmp/pe-head" && [ -s "$tmp/pe-head" ]; then
				got=$(pe_machine "$tmp/pe-head")
				[ "$got" = "$want" ] || fail "$inner in $(basename "$zip") has PE machine $got, expected $want"
			else
				fail "$(basename "$zip") has no $inner"
			fi
		done
		for inner in Threadbear/runner/src/main.ts Threadbear/desktop/bridge/bridge.ts Threadbear/desktop/dist/index.html Threadbear/docs/guide.md; do
			unzip -l "$zip" "$inner" >/dev/null 2>&1 || fail "$(basename "$zip") has no $inner"
		done
	fi
done

# Linux: threadbear-v<version>-linux-<arch>.tar.gz and .deb (docs/linux.md)
# The ELF machine field, two bytes at offset 18 (little-endian): 62 0 for x86-64,
# 183 0 for aarch64.
elf_machine() {
	od -An -t u1 -j 18 -N 2 "$1" | tr -s ' ' | sed 's/^ //'
}
debver=${tag#v}
debver=$(printf '%s' "$debver" | sed 's/-/~/') # a pre-release sorts first: 0.1.0-rc.1 is 0.1.0~rc.1
for arch in x64 arm64; do
	check "threadbear-$tag-linux-$arch.tar.gz" 20000000
	check "threadbear-$tag-linux-$arch.deb" 20000000
	want_elf="62 0"
	debarch=amd64
	if [ "$arch" = arm64 ]; then
		want_elf="183 0"
		debarch=arm64
	fi
	tgz=$dir/threadbear-$tag-linux-$arch.tar.gz
	if [ -f "$tgz" ]; then
		top=threadbear-$tag-linux-$arch
		tar -tzf "$tgz" >"$tmp/tar-list" 2>/dev/null || fail "$(basename "$tgz") is not a readable tarball"
		# The shell and the Node it carries must both be this architecture
		for inner in threadbear-desktop node/bin/node; do
			if tar -xzOf "$tgz" "$top/$inner" 2>/dev/null | head -c 64 >"$tmp/elf-head" && [ -s "$tmp/elf-head" ]; then
				elf_got=$(elf_machine "$tmp/elf-head")
				[ "$elf_got" = "$want_elf" ] || fail "$inner in $(basename "$tgz") has ELF machine '$elf_got', expected '$want_elf'"
			else
				fail "$(basename "$tgz") has no $top/$inner"
			fi
		done
		for inner in runner/src/main.ts desktop/bridge/bridge.ts desktop/dist/index.html docs/guide.md install.sh; do
			grep -Fxq "$top/$inner" "$tmp/tar-list" || fail "$(basename "$tgz") has no $top/$inner"
		done
	fi
	deb=$dir/threadbear-$tag-linux-$arch.deb
	if [ -f "$deb" ]; then
		if command -v dpkg-deb >/dev/null 2>&1; then
			[ "$(dpkg-deb --field "$deb" Package)" = threadbear ] || fail "$(basename "$deb") is not the threadbear package"
			[ "$(dpkg-deb --field "$deb" Architecture)" = "$debarch" ] || fail "$(basename "$deb") is not built for $debarch"
			[ "$(dpkg-deb --field "$deb" Version)" = "$debver" ] || fail "$(basename "$deb") has version '$(dpkg-deb --field "$deb" Version)', expected $debver"
			dpkg-deb --contents "$deb" >"$tmp/deb-list" 2>/dev/null || fail "$(basename "$deb") has no readable contents"
			for inner in ./opt/threadbear/threadbear-desktop ./opt/threadbear/runner/src/main.ts ./usr/share/applications/threadbear.desktop ./usr/bin/threadbear-desktop; do
				# A line is "mode owner size date time name", and "name -> target" for a link
				awk -v p="$inner" '{ for (i = 1; i <= NF; i++) if ($i == p) found = 1 } END { exit !found }' "$tmp/deb-list" || fail "$(basename "$deb") has no $inner"
			done
		else
			echo "note: dpkg-deb is not on this machine, so $(basename "$deb")'s fields were not read"
		fi
	fi
done

# Android: threadbear-v<version>-android.apk, which is on a release only when the
# release key signed it (release.yml), so it is optional here. One that is there
# has to verify, and must not be signed with a key made for one run, which a
# phone could never update from.
apk=$dir/threadbear-$tag-android.apk
if [ -f "$apk" ]; then
	# A release build is shrunk: the real one is about 9.5 MB (a debug build, 60 MB)
	check "threadbear-$tag-android.apk" 4000000
	apksigner=$(ls -d "${ANDROID_HOME:-/nonexistent}"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -n 1 || true)
	if [ -n "$apksigner" ]; then
		if "$apksigner" verify --print-certs "$apk" >"$tmp/apk-certs" 2>&1; then
			if grep -q 'Threadbear build made for one run' "$tmp/apk-certs"; then
				fail "$(basename "$apk") is signed with a key made for one run, not the release key"
			else
				echo "OK: $(basename "$apk") has a valid signature, not a run's own key"
			fi
		else
			fail "$(basename "$apk")'s signature does not verify: $(head -n 3 "$tmp/apk-certs" | tr '\n' ' ')"
		fi
	else
		echo "note: apksigner is not on this machine, so $(basename "$apk")'s signature was not checked"
	fi
fi

# CHECKSUMS.txt: one line for each package, and nothing else
echo "CHECKSUMS.txt" >>"$tmp/allowed"
sums=$dir/CHECKSUMS.txt
if [ -f "$sums" ]; then
	if [ -s "$sums" ] && [ -n "$(tail -c 1 "$sums")" ]; then
		fail "CHECKSUMS.txt does not end with a newline"
	fi
	if [ "$(tr -d '\r' <"$sums" | wc -c | tr -d ' ')" -ne "$(wc -c <"$sums" | tr -d ' ')" ]; then
		fail "CHECKSUMS.txt has carriage returns (it must have LF line endings)"
	fi
	bad=$(grep -Evc '^[0-9a-f]{64}  [^ /\\]+$' "$sums" || true)
	if [ "$bad" -ne 0 ]; then
		fail "CHECKSUMS.txt has $bad line(s) that are not '<64 hex digits>  <file name>' (comments and blank lines are not allowed: sha256sum -c warns about them)"
	fi
	LC_ALL=C sort "$tmp/want" >"$tmp/want.sorted"
	LC_ALL=C sort "$sums" >"$tmp/have.sorted"
	if ! diff "$tmp/want.sorted" "$tmp/have.sorted" >"$tmp/diff.txt"; then
		fail "CHECKSUMS.txt does not match the files (< is what the files call for, > is what it says):"
		cat "$tmp/diff.txt"
	else
		echo "OK: CHECKSUMS.txt ($(wc -l <"$sums" | tr -d ' ') lines, each the file's own hash)"
	fi
elif [ "$need_checksums" -eq 1 ]; then
	fail "missing CHECKSUMS.txt"
fi

# Nothing else may be in the folder: it is uploaded as it stands
ls -A "$dir" | while IFS= read -r entry; do
	grep -Fxq -- "$entry" "$tmp/allowed" || echo "unexpected: $entry"
done >"$tmp/unexpected"
if [ -s "$tmp/unexpected" ]; then
	while IFS= read -r line; do fail "${line#unexpected: } is not part of a release (the folder is published as it stands)"; done <"$tmp/unexpected"
fi

# The app finds its download by matching the END of each release asset name
# (see desktop-tauri/src/core/updates.ts) against these suffixes. Read them straight
# from the source so this cannot drift: renaming assets without updating the
# check, or the reverse, fails here, loudly, instead of silently stranding
# every copy already installed. npad hit that once, in v0.17.x.
suffixes=$(grep -o '"-setup-win-[^"]*"' desktop-tauri/src/core/updates.ts | tr -d '"' | sort -u || true)
if [ -z "$suffixes" ]; then
	fail "could not read the update check's asset suffixes from desktop-tauri/src/core/updates.ts"
fi
names=$(ls "$dir")
for sfx in $suffixes; do
	# Case-insensitive, as the update check matches
	if echo "$names" | awk -v s="$sfx" 'BEGIN { s = tolower(s) }
		{ n = tolower($0); if (length(n) >= length(s) && substr(n, length(n) - length(s) + 1) == s) found = 1 }
		END { exit !found }'; then
		echo "OK: an asset ends with '$sfx' (update check)"
	else
		fail "no asset ends with '$sfx': the update check would not find its download"
	fi
done

if [ "$failed" -ne 0 ]; then
	echo "Release asset validation FAILED"
	exit 1
fi
echo "Release asset validation passed"
