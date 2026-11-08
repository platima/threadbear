#!/bin/sh
# Write the GitHub release notes for a tag to stdout: the version's
# "### ✨ Highlights" from desktop/CHANGELOG.md, the downloads and how to
# verify them, and a link to the full changelog entry. Used by release.yml (once,
# before anything is published, so a release without highlights fails instead of
# shipping a bare list of files) and, with --check, by release.sh and by the
# workflow's version check.
#
# Usage: installer/release-notes.sh [--unsigned] [--android] [--check] <tag> [repo] [commit] [run-url]
#   e.g. installer/release-notes.sh v0.1.0 platima/threadbear "$GITHUB_SHA" "$RUN_URL"
#   --unsigned  the build is not code-signed: say so, and what SmartScreen will
#               show, instead of describing a signature
#   --android   the release has an Android APK: list it with the downloads
#   --check     write nothing; only fail (exit 1, with the reason) if the tag
#               has no changelog entry, the entry has no Highlights, or a final
#               release's heading still says Unreleased. A pre-release
#               (v0.2.0-rc.1) uses the entry of its version (0.2.0) and may
#               still say Unreleased, because the final is not out yet.
# The options come before the tag. Run from the repo root.
set -eu

unsigned=0
check=0
android=0
while [ $# -gt 0 ]; do
    case $1 in
    --unsigned) unsigned=1; shift ;;
    --android) android=1; shift ;;
    --check) check=1; shift ;;
    --) shift; break ;;
    -*) echo "release-notes: unknown option $1" >&2; exit 2 ;;
    *) break ;;
    esac
done

[ $# -ge 1 ] || { echo "usage: release-notes.sh [--unsigned] [--check] <tag> [repo] [commit] [run-url]" >&2; exit 2; }
tag=$1
repo=${2:-platima/threadbear}
commit=${3:-}
run_url=${4:-}
case $tag in
v | v*[!0-9A-Za-z.-]*) echo "release-notes: '$tag' does not look like a tag (v0.1.0)" >&2; exit 2 ;;
v*) ;;
*) echo "release-notes: '$tag' does not look like a tag (v0.1.0)" >&2; exit 2 ;;
esac
version=${tag#v}
base=${version%%-*} # A pre-release (v0.2.0-rc.1) uses its version's entry
prerelease=0
[ "$base" = "$version" ] || prerelease=1
changelog=desktop/CHANGELOG.md

# This version's entry: from its "## [x.y.z]" heading to the next "## ["
entry=$(awk -v v="$base" '
    index($0, "## [" v "]") == 1 { on = 1; print; next }
    on && /^## \[/ { exit }
    on { print }
' "$changelog")
if [ -z "$entry" ]; then
    echo "release-notes: $changelog has no '## [$base]' entry" >&2
    exit 1
fi
heading=$(printf '%s\n' "$entry" | head -n 1)

# Its highlights: from "### ✨ Highlights" to the next "### "
highlights=$(printf '%s\n' "$entry" | awk '
    /^### / { if (on) exit; if (index($0, "Highlights")) { on = 1; next } }
    on { print }
')
if [ -z "$(printf '%s' "$highlights" | tr -d '[:space:]')" ]; then
    echo "release-notes: the [$base] entry in $changelog has no '### ✨ Highlights' section" >&2
    exit 1
fi

# A final release has a date in its heading, not "Unreleased"
if [ "$prerelease" -eq 0 ] && printf '%s' "$heading" | grep -qi 'unreleased'; then
    echo "release-notes: '$heading' in $changelog still says Unreleased. Put the release date in the heading before tagging $tag." >&2
    exit 1
fi

[ "$check" -eq 0 ] || exit 0

# GitHub's anchor for "## [0.1.0] - 2026-11-10" is "010---2026-11-10"
anchor=$(printf '%s' "${heading#\#\# }" | tr -d '[].' | tr ' ' '-' | tr '[:upper:]' '[:lower:]')

cat <<EOF
## Threadbear $tag

$(printf '%s\n' "$highlights" | sed -e '/./,$!d')
EOF

if [ "$prerelease" -eq 1 ]; then
    cat <<EOF

> **Pre-release.** The app's update check does not offer it. Its MSI carries the numbers only ($base), so it and the final $base release replace each other when installed.
EOF
fi

cat <<EOF

Every change in this release: [CHANGELOG.md](https://github.com/$repo/blob/$tag/desktop/CHANGELOG.md#$anchor)

### Downloads

**Windows** (\`x64\` for most PCs, \`arm64\` for Windows on Arm). It needs [Claude Code](https://claude.com/claude-code) signed in and [Git for Windows](https://gitforwindows.org); Node comes inside.
- \`threadbear-$tag-setup-win-x64.exe\` / \`threadbear-$tag-setup-win-arm64.exe\`: installer (per user by default, system-wide if you choose it)
- \`threadbear-$tag-msi-win-x64.msi\` / \`threadbear-$tag-msi-win-arm64.msi\`: MSI for silent or managed deployment (\`msiexec /i <file> /qn\`)
- \`threadbear-$tag-portable-win-x64.zip\` / \`threadbear-$tag-portable-win-arm64.zip\`: portable, unzip anywhere and run \`Threadbear.exe\`

**Linux** (\`x64\` or \`arm64\`; a desktop with WebKitGTK 4.1, and systemd for the runner's service). It needs [Claude Code](https://claude.com/claude-code) signed in, git and bash; Node comes inside. These are not signed: the SHA-256 in \`CHECKSUMS.txt\` is what to check. [docs/linux.md](https://github.com/$repo/blob/$tag/docs/linux.md) says what it adds and leaves out.
- \`threadbear-$tag-linux-x64.deb\` / \`threadbear-$tag-linux-arm64.deb\`: for Debian and Ubuntu (\`sudo apt install ./<file>\`)
- \`threadbear-$tag-linux-x64.tar.gz\` / \`threadbear-$tag-linux-arm64.tar.gz\`: unpack anywhere and run \`./threadbear-desktop\`, or \`./install.sh\` for a menu entry
EOF

if [ "$android" -eq 1 ]; then
    cat <<EOF

**Android** (Android 8 or newer). The website in an app of its own, told which deployment to use by the pairing link from the Mac or Windows app. It has no notifications while it is closed. [docs/android.md](https://github.com/$repo/blob/$tag/docs/android.md) says how to pair it and what is left.
- \`threadbear-$tag-android.apk\`: signed with the release key, so each release installs over the last (Android asks to allow installs from your browser or file manager, once)
EOF
fi

cat <<EOF

**Verification:** \`CHECKSUMS.txt\` lists the SHA-256 of every file. On Linux or in Git Bash, \`sha256sum -c --ignore-missing CHECKSUMS.txt\` (you will not have every file). On Windows, in the folder you downloaded to:

\`\`\`powershell
Get-Content CHECKSUMS.txt | ForEach-Object { \$h, \$n = \$_ -split '  ', 2; if (Test-Path \$n) { "\$((Get-FileHash \$n -Algorithm SHA256).Hash -eq \$h)  \$n" } }
\`\`\`

It prints True beside each file you have if its hash matches.

EOF

if [ "$unsigned" -eq 1 ]; then
    cat <<EOF
> **This build is not code-signed.** Windows SmartScreen will most likely stop it with "Windows protected your PC" and show "Unknown publisher" under "More info", and the file's Properties will have no Digital Signatures tab. That is expected for this build. Check the SHA-256 against \`CHECKSUMS.txt\` first, then choose "More info" > "Run anyway".
EOF
else
    cat <<EOF
> **SmartScreen warning?** Check the file's Properties > Digital Signatures tab: a signed release names the publisher there, and SmartScreen can still warn while a publisher's reputation is new. If unsure, verify the SHA-256 against \`CHECKSUMS.txt\`, then choose "More info" > "Run anyway".
EOF
fi

if [ -n "$commit$run_url" ]; then
    printf '\n---\n\n'
    [ -n "$commit" ] && printf 'Built from `%s`' "$commit"
    [ -n "$run_url" ] && printf ' by [this workflow run](%s)' "$run_url"
    printf ', after CI validation passed.\n'
fi
