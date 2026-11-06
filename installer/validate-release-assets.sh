#!/bin/sh
# Check that <dir> holds a complete, consistent set of release assets for
# <tag> (e.g. v0.1.0): every Windows package for x64 and arm64, each with a
# .sha256 that verifies, each plausibly sized, and the programs inside each zip
# built for the architecture its name claims. Also proves the app's update
# check can find its download on this release, for every architecture it knows,
# and that nothing else is in the folder.
# If <dir>/CHECKSUMS.txt is there it is checked too: exactly one line for each
# of the six packages, in the form `sha256sum -c` reads (hash, two spaces, name;
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
# (see desktop/src/core/updates.ts) against these suffixes. Read them straight
# from the source so this cannot drift: renaming assets without updating the
# check, or the reverse, fails here, loudly, instead of silently stranding
# every copy already installed. npad hit that once, in v0.17.x.
suffixes=$(grep -o '"-setup-win-[^"]*"' desktop/src/core/updates.ts | tr -d '"' | sort -u || true)
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
		fail "no asset ends with '$sfx': the update check would not find its download"
	fi
done

if [ "$failed" -ne 0 ]; then
	echo "Release asset validation FAILED"
	exit 1
fi
echo "Release asset validation passed"
