#!/bin/sh
# Check that <dir> holds a complete, consistent set of release assets for
# <tag> (e.g. v0.1.0): every Windows package for x64 and arm64, each with a
# .sha256 that verifies, each plausibly sized, and the programs inside each zip
# built for the architecture its name claims. Also proves the app's update
# check can find its download on this release, for every architecture it knows.
# Usage: installer/validate-release-assets.sh <dir> <tag>   (run from the repo root)
# release.yml runs it on the published release's assets, and on the build
# artifacts in a dry run; it works the same on a directory you downloaded.
set -eu
dir=$1
tag=$2
failed=0

fail() {
	echo "ERROR: $*"
	failed=1
}

check() {
	name=$1
	min_size=$2
	f=$dir/$name
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
	# Hash the asset itself and compare with the companion's digest. Not
	# `sha256sum -c`: that checks whichever file the companion NAMES, so a
	# companion carrying another asset's line would vouch for a corrupt file.
	if [ ! -f "$f.sha256" ]; then
		fail "missing checksum $name.sha256"
		return 0
	fi
	read -r want listed <"$f.sha256" || true
	listed=${listed#\*} # sha256sum's binary-mode marker
	got=$(sha256sum "$f" | cut -d' ' -f1)
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
			if unzip -p "$zip" "$inner" 2>/dev/null | head -c 4096 >"$dir/.pe-head" && [ -s "$dir/.pe-head" ]; then
				got=$(pe_machine "$dir/.pe-head")
				[ "$got" = "$want" ] || fail "$inner in $(basename "$zip") has PE machine $got, expected $want"
			else
				fail "$(basename "$zip") has no $inner"
			fi
		done
		rm -f "$dir/.pe-head"
		for inner in Threadbear/runner/src/main.ts Threadbear/desktop/bridge/bridge.ts Threadbear/desktop/dist/index.html Threadbear/docs/guide.md; do
			unzip -l "$zip" "$inner" >/dev/null 2>&1 || fail "$(basename "$zip") has no $inner"
		done
	fi
done

# The app finds its download by matching the END of each release asset name
# (see desktop/src/core/updates.ts) against these suffixes. Read them straight
# from the source so this cannot drift: renaming assets without updating the
# check - or the reverse - fails here, loudly, instead of silently stranding
# every copy already installed. npad hit that once, in v0.17.x.
suffixes=$(grep -o '"-setup-win-[^"]*"' desktop/src/core/updates.ts | tr -d '"' | sort -u)
if [ -z "$suffixes" ]; then
	fail "could not read the update check's asset suffixes from desktop/src/core/updates.ts"
fi
names=$(ls "$dir")
for sfx in $suffixes; do
	# Case-insensitive, as the update check matches
	if echo "$names" | awk -v s="$sfx" 'BEGIN { s = tolower(s) }
		{ n = tolower($0); if (length(n) >= length(s) && substr(n, length(n) - length(s) + 1) == s) found = 1 }
		END { exit !found }'; then
		echo "OK: an asset ends with '$sfx' (update check)"
	else
		fail "no asset ends with '$sfx' - the update check would not find its download"
	fi
done

if [ "$failed" -ne 0 ]; then
	echo "Release asset validation FAILED"
	exit 1
fi
echo "Release asset validation passed"
