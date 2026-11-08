#!/bin/sh
# Puts Threadbear in the applications menu for this user, from where this folder is.
# Nothing is copied: the launcher points at this folder, so move or delete the
# folder and run this again (or --uninstall) to match.
#
#   ./install.sh               add the launcher
#   ./install.sh --uninstall   take it away
#
# It writes ~/.local/share/applications/threadbear.desktop and nothing else. The
# runner's service and the tb command are set up by the app itself, when it
# first opens (or ./threadbear-desktop --runner).
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
entry="$apps/threadbear.desktop"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$entry"
  echo "Removed $entry."
  exit 0
fi

if [ ! -x "$here/threadbear-desktop" ]; then
  echo "threadbear-desktop is not in $here. Run this from the unpacked folder." >&2
  exit 1
fi

mkdir -p "$apps"
# Exec and Icon are quoted for the Desktop Entry spec: a space in the folder's
# name is fine in quotes, and \ " ` $ would need escaping, so they are refused.
case "$here" in
  *\\*|*\"*|*\`*|*\$*)
    echo "This folder's name has a backslash, quote, backtick or dollar sign in it, which a launcher can't carry. Move it somewhere plainer." >&2
    exit 1
    ;;
esac
cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Name=Threadbear
Comment=Your threads, in a window of their own
Exec="$here/threadbear-desktop"
Icon=$here/threadbear.png
Terminal=false
Categories=Development;Utility;
StartupWMClass=threadbear-desktop
EOF
echo "Added $entry."
echo "Threadbear is in your applications menu. The first time it opens it offers to set the runner up."
