#!/bin/bash

# Threadbear for Windows: tag a release.
# Usage: installer/release.sh v0.1.0
#
# Checks the version, the changelog entry and the checks, then creates the tag
# and pushes it. GitHub Actions (release.yml) does the rest: it builds, signs,
# validates and publishes. The same checks run again there, so a tag pushed by
# hand does not get past them either. To rehearse first, with nothing
# published and no signing, from the branch you mean to tag:
#   gh workflow run release.yml --ref <branch> -f version=v0.1.0
# (add -f sign=true to sign the rehearsal too). GitHub only offers the
# rehearsal once release.yml is on the repository's default branch.
#
# Tag one release at a time and wait for its run to finish before the next:
# several tags pushed together make several runs fight over the same runners.

set -e

# Work in the checkout this script lives in, whatever the current folder is.
# Every path below, and every git command, is then about that checkout, not
# one the script was merely started from.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_status() { echo -e "${GREEN}[INFO]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if [ $# -eq 0 ]; then
    print_error "No version provided"
    echo "Usage: $0 <version>"
    echo "Example: $0 v0.1.0"
    exit 1
fi

VERSION=$1

# Strict semantic version, with an optional pre-release (v0.2.0-rc.1). Build
# metadata (+build) is left out: it is not allowed in a Windows Installer
# version. desktop-tauri/scripts/version.mjs holds the one pattern, so this, the
# release workflow and the packaging script cannot disagree about it.
if [[ $VERSION != v* ]] || ! node desktop-tauri/scripts/version.mjs --valid "${VERSION#v}"; then
    print_error "Invalid semantic version: $VERSION"
    echo "Expected format: v1.2.3 or v1.2.3-rc.1"
    exit 1
fi

print_status "Preparing release $VERSION"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    print_warning "Not on main branch (currently on: $CURRENT_BRANCH)"
    read -p "Continue anyway? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_error "Aborted"
        exit 1
    fi
fi

if ! git diff-index --quiet HEAD --; then
    print_error "Working directory is not clean. Please commit or stash changes."
    exit 1
fi

if git rev-parse "$VERSION" >/dev/null 2>&1; then
    print_error "Tag $VERSION already exists"
    exit 1
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/$VERSION")" ]; then
    print_error "Tag $VERSION already exists on origin. A published tag is never moved: pick the next version."
    exit 1
fi

print_status "Checking the version numbers..."
node desktop-tauri/scripts/version.mjs --check || {
    print_error "The version files disagree. Run: node desktop-tauri/scripts/version.mjs --set ${VERSION#v}"
    exit 1
}
BUILT=$(node desktop-tauri/scripts/version.mjs --print)
if [ "v$BUILT" != "$VERSION" ]; then
    print_error "$VERSION was asked for, but the app is $BUILT. Run: node desktop-tauri/scripts/version.mjs --set ${VERSION#v}"
    exit 1
fi

# release-notes.sh --check says what is wrong. A pre-release (v0.2.0-rc.1) is
# checked against its version's entry (## [0.2.0]), which may still say
# Unreleased; a final release's heading must carry its date. The release
# workflow runs the same check, for tags that skip this script.
print_status "Checking desktop-tauri/CHANGELOG.md has highlights for $VERSION..."
BASE=${VERSION#v}
BASE=${BASE%%-*}
sh installer/release-notes.sh --check "$VERSION" || {
    print_error "Fix desktop-tauri/CHANGELOG.md: a '## [$BASE]' entry with a '### ✨ Highlights' list, and a date in its heading for a final release"
    exit 1
}

# A fresh checkout has no dependencies yet, and the typecheck needs tsc. Install
# them from the lockfiles, as CI does, for any folder that has none.
for dir in runner desktop; do
    if [ ! -d "$dir/node_modules" ]; then
        print_status "Installing the $dir dependencies (npm ci)..."
        (cd "$dir" && npm ci) || { print_error "npm ci failed in $dir"; exit 1; }
    fi
done

print_status "Running the checks..."
(cd runner && npm run typecheck) || { print_error "The runner's typecheck failed"; exit 1; }
(cd desktop && npm run typecheck && npm test) || { print_error "The desktop app's checks failed"; exit 1; }

print_status "Creating and pushing tag..."
git tag -a "$VERSION" -m "Threadbear for Windows $VERSION"
# If the push fails, take the local tag back out: a stray tag makes the next
# attempt say "already exists" for a release that was never made.
if ! git push origin "$VERSION"; then
    git tag -d "$VERSION" >/dev/null
    print_error "Could not push $VERSION to origin, so the local tag is removed again. Nothing was released."
    exit 1
fi

print_status "Tag $VERSION created and pushed."
print_status "GitHub Actions will now build the release, check it, and publish it only once every file is there."
print_status "Check the progress at: https://github.com/$(git config --get remote.origin.url | sed -E 's#.*github.com[:/]##; s#\.git$##')/actions"
print_status "The release will have the setup exe, MSI and portable zip for x64 and arm64, a SHA-256 file for each, and CHECKSUMS.txt."
case $VERSION in
*-*) print_status "It is a pre-release: GitHub will mark it so, and the app's update check will not offer it." ;;
esac
