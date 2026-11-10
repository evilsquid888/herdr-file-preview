#!/bin/sh
# Copies the repo's mods/ and layouts/ into Herdr (~/.config/herdr-app/, or $HERDR_APP_HOME/).
# Herdr hot-reloads every copy on save, so run this after each edit (or under `fswatch`).
set -eu
repo="$(cd "$(dirname "$0")/.." && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
dest="$home/mods"
# Mods import only from their own folder: the launcher carries a copy of the popup's dock.js.
if ! cmp -s "$repo/mods/squid-ink/dock.js" "$repo/mods/squid-ink-panel/dock.js"; then
  echo "dock.js differs: cp mods/squid-ink/dock.js mods/squid-ink-panel/" >&2
  exit 1
fi
for mod in "$repo"/mods/*/; do
  name="$(basename "$mod")"
  # A symlink left from an earlier install would make rsync write through it into the repo.
  [ -L "$dest/$name" ] && rm "$dest/$name"
  # .cache/ (Mermaid renders) and jsconfig.json belong to the installed copy, not the repo.
  rsync -a --delete --exclude .cache/ --exclude jsconfig.json --exclude gpui-kit.d.ts "$mod" "$dest/$name/"
  echo "synced $name -> $dest/$name"
done
# main-ink: Herdr's main layout with squid-ink in the side panel and the tabs-ink bar.
# A layout file is live: Herdr follows an edit within a second (switch to it with
# `herdr-app do layout.switch '{"name":"main-ink"}'`).
for layout in "$repo"/layouts/*.json; do
  cp "$layout" "$home/layouts/"
  echo "synced $(basename "$layout") -> $home/layouts/"
done
