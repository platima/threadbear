#!/bin/sh
# Write the GitHub release notes for a tag to stdout: the version's
# "### ✨ Highlights" from desktop/CHANGELOG.md, the downloads and how to
# verify them, and a link to the full changelog entry. Used by release.yml for
# both the first and the final release body, and run before anything is
# published, so a release without highlights fails instead of shipping a bare
# list of files.
#
# Usage: installer/release-notes.sh <tag> [repo] [commit] [run-url]
#   e.g. installer/release-notes.sh v0.1.0 platima/threadbear "$GITHUB_SHA" "$RUN_URL"
# Run from the repo root.
set -eu

tag=$1
repo=${2:-platima/threadbear}
commit=${3:-}
run_url=${4:-}
version=${tag#v}
base=${version%%-*} # A pre-release (v0.2.0-rc1) uses its version's entry
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

# GitHub's anchor for "## [0.1.0] - 2026-11-10" is "010---2026-11-10"
anchor=$(printf '%s' "${heading#\#\# }" | tr -d '[].' | tr ' ' '-' | tr '[:upper:]' '[:lower:]')

cat <<EOF
## Threadbear $tag

$(printf '%s\n' "$highlights" | sed -e '/./,$!d')

Every change in this release: [CHANGELOG.md](https://github.com/$repo/blob/$tag/desktop/CHANGELOG.md#$anchor)

### Downloads

**Windows** (\`x64\` for most PCs, \`arm64\` for Windows on Arm). It needs [Claude Code](https://claude.com/claude-code) signed in and [Git for Windows](https://gitforwindows.org); Node comes inside.
- \`threadbear-$tag-setup-win-x64.exe\` / \`threadbear-$tag-setup-win-arm64.exe\` - installer (per-user by default; system-wide available)
- \`threadbear-$tag-msi-win-x64.msi\` / \`threadbear-$tag-msi-win-arm64.msi\` - MSI for silent or managed deployment (\`msiexec /i <file> /qn\`)
- \`threadbear-$tag-portable-win-x64.zip\` / \`threadbear-$tag-portable-win-arm64.zip\` - portable: unzip anywhere and run \`Threadbear.exe\`

**Verification:** \`CHECKSUMS.txt\` lists the SHA-256 of every file (\`sha256sum -c CHECKSUMS.txt\` on Linux, \`Get-FileHash\` on Windows).

> **SmartScreen warning?** Check the file's Properties > Digital Signatures tab: a signed release names the publisher there, and SmartScreen can still warn while a publisher's reputation is new. If unsure, verify the SHA-256 against \`CHECKSUMS.txt\`, then choose "More info" > "Run anyway".
EOF

if [ -n "$commit$run_url" ]; then
    printf '\n---\n\n'
    [ -n "$commit" ] && printf 'Built from `%s`' "$commit"
    [ -n "$run_url" ] && printf ' by [this workflow run](%s)' "$run_url"
    printf ', after CI validation passed.\n'
fi
