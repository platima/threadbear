#!/bin/bash

# Threadbear for Windows: tag a release.
# Usage: installer/release.sh v0.1.0
#
# Checks the version, the changelog entry and the checks, then creates the tag
# and pushes it. GitHub Actions (release.yml) does the rest: it builds, signs,
# validates and publishes. To rehearse first, with nothing published:
#   gh workflow run release.yml --ref main -f version=v0.1.0
#
# Tag one release at a time and wait for its run to finish before the next:
# several tags pushed together make several runs fight over the same runners.

set -e

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

# Semantic version, with an optional pre-release (v0.2.0-rc1). Build metadata
# (+build) is left out: it is not allowed in a Windows Installer version.
if ! [[ $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]]; then
    print_error "Invalid semantic version format: $VERSION"
    echo "Expected format: v1.2.3 or v1.2.3-rc1"
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

print_status "Checking the version numbers..."
node desktop/scripts/version.mjs --check || {
    print_error "The version files disagree. Run: node desktop/scripts/version.mjs --set ${VERSION#v}"
    exit 1
}
BUILT=$(node desktop/scripts/version.mjs --print)
if [ "v$BUILT" != "$VERSION" ]; then
    print_error "$VERSION was asked for, but the app is $BUILT. Run: node desktop/scripts/version.mjs --set ${VERSION#v}"
    exit 1
fi

print_status "Checking desktop/CHANGELOG.md has highlights for $VERSION..."
sh installer/release-notes.sh "$VERSION" >/dev/null || {
    print_error "Add a '## [${VERSION#v}]' entry with a '### ✨ Highlights' list to desktop/CHANGELOG.md"
    exit 1
}

if grep -q "^## \[${VERSION#v}\].*Unreleased" desktop/CHANGELOG.md; then
    print_error "desktop/CHANGELOG.md still says Unreleased for ${VERSION#v}. Put the release date in its heading."
    exit 1
fi

print_status "Running the checks..."
(cd runner && npm run typecheck) || { print_error "The runner's typecheck failed"; exit 1; }
(cd desktop && npm run typecheck && npm test) || { print_error "The desktop app's checks failed"; exit 1; }

print_status "Creating and pushing tag..."
git tag -a "$VERSION" -m "Threadbear for Windows $VERSION"
git push origin "$VERSION"

print_status "Tag $VERSION created and pushed."
print_status "GitHub Actions will now build and publish the release."
print_status "Check the progress at: https://github.com/$(git config --get remote.origin.url | sed -E 's#.*github.com[:/]##; s#\.git$##')/actions"
print_status "The release will have the setup exe, MSI and portable zip for x64 and arm64, with SHA-256 files."
