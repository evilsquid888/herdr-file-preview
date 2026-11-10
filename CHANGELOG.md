# Changelog

Each version is a git tag (`vX.Y.Z`) on this repo. Herdr doesn't update layouts or mods
you installed from herdr.dev: see [Updating](README.md#updating) to move to a newer one.

Versions follow [Semantic Versioning](https://semver.org/): a major version changes
something you set up yourself (a mod or layout name, a shortcut, a `keys.json` entry),
so read its notes before updating.

## 2.0.0 — 2026-11-09 (Squid Ink)

### Renamed: file-preview is now Squid Ink

- The repo is `evilsquid888/herdr-squid-ink`. The mods are `squid-ink` (was
  `file-preview`), `squid-ink-panel` (was `file-preview-panel`) and `tabs-ink` (was
  `tabs-fp`); the layout is `main-ink` (was `main-fp`). It installs next to the original
  `file-preview` instead of over it.
- **Yours to change:** `keys.json` entries (`mod.open:squid-ink-panel`,
  `mod.open:squid-ink`), any layout of your own that names the mod, and commands
  (`squid-ink.<name>`). Comments move by copying `data/file-preview/comments.json` to
  `data/squid-ink/comments.json`. Panel widths, zoom levels and remembered files start
  fresh. Steps: [Moving from file-preview](README.md#moving-from-file-preview).

### Editing

- **✎ Edit** / `e` edits the shown file (in the tree, `e` edits the selected one). **Save**
  (`ctrl-s` / `cmd-s`) writes it and keeps editing; **Cancel** (`Esc`) asks before
  discarding unsaved changes, as do opening another file, changing the root, opening a
  commit and **✕**.
- Markdown and HTML: a live preview of the buffer, **Split** / **Source** / **Preview**.
- A save never overwrites an agent's change silently: it goes through only while the file
  is what editing started from, else a banner offers **Use theirs** / **Keep mine**. An
  untouched editor follows the file.
- Remote files save through herdr-core (base64 in 24 KB pieces, a `cksum` check, an atomic
  rename that keeps the mode). CRLF files stay CRLF.
- Unsaved edits of a view that closed without asking come back on the next edit of the
  file, while the file is unchanged. The draft holds the edited text only (a sum of the
  file, not its text) and is dropped after a day.
- A remote save's temporary files are made with `mktemp` under `umask 077` (a random
  name, never readable by other accounts, whatever the file's mode) and are removed when
  a save fails part-way. The remote machine now needs `mktemp`.
- Remote saves send the text as a file with `hc put` to a terminal on that machine, over
  herdr-core, so it never appears on a command line (there or here), in one transfer.
  Only a machine with no live terminal falls back to base64 pieces as arguments, and the
  status says so ("sent as arguments").
- A remote save is never unchecked: when the file's `cksum` couldn't be taken at the start
  (or **Use theirs** is still fetching it), the save first compares the file with what
  editing started from.
- A remote file with other hard links, or owned by another account, is written through
  instead of renamed over, so the links survive and the owner doesn't change.
- Fixed: a remote save could overwrite a change made just as editing started (or just
  as **Use theirs** was pressed), with no banner. The file's `cksum` is now taken
  together with a read of the file, and counts only when the two agree.
- Fixed: a check of the file that was still running when a save finished could put the
  text from before the save back in the editor, or show a false "changed on disk".
- Fixed: a load of the file still on its way when editing started could replace the
  live preview, or (file gone) drop the edit. A view that has to drop an edit without
  being able to ask now keeps it as a draft.
- Fixed: `e` on another file in the tree while editing opened it without editing it.
- Fixed: `e` while a commit or a change was on screen started an edit nobody could see.
- Line endings are kept line by line: in a file with both LF and CRLF, only the lines
  you changed take the file's usual ending (before, one CRLF made every line CRLF and the
  file showed as changed at once).
- A remote save no longer falls back to command arguments on its own. With no live
  terminal there, or when `hc put` fails, it stops and a banner asks (**Send as
  arguments**); an upload that landed but couldn't be used is deleted there.
- A read-only remote file is refused instead of replaced, and a writable file in a folder
  you can't write to is saved (written through).
- A file over 256 KB checks for unsaved changes and redraws its live preview after a
  pause in typing, not on every key.

## 1.1.0 — 2026-11-07 (evilsquid888 fork)

### Comments

- Comment on a paragraph (drag across it, or right-click): edit, delete, kept per machine
  and file in `~/.config/herdr-app/data/file-preview/comments.json`, and found again
  after the file changes.
- **Send to agent** pastes the comments as numbered Markdown into the prompt of the
  agent in the shown tab, without Enter, for review there; **Copy** and **Clear**.
- Markdown prose is split into one block per paragraph (search frames and git marks are
  per paragraph too).

### Navigation

- Choose the root by hand: a clickable breadcrumb, **↑** / `Backspace` (up one folder), `.` (the
  selected folder), **↺** (follow the terminal again), and `root-up` / `root:<path>` /
  `root-follow` commands. Drive roots (`C:/`) work.

### New previews

- Images: image files in the tree and pictures in Markdown / HTML, local and remote,
  copied into the cache; **View over SSH** prints a remote image with Kitty graphics.
- HTML: a **Reading** view (elements as blocks you can comment on) and a **Source** view.
- Mermaid without mermaid-cli: Edge, Chrome or Chromium with the bundled mermaid.js.

### Windows

- Local folders through Git for Windows' `sh`; CRLF files read correctly.

### Security

- Pictures in documents load only when they are image files under the browsed folder.
- Git calls never verify signatures (`log.showSignature=false`, `gpg.program=false`), so a
  repository's own config can't name a program for git to run.
- Fixed: a repository's own `filter.<name>.clean` or `.process` command still ran, on
  every tracked file that the mod's periodic `git status` (or a diff) re-hashed, which in
  a copied folder is all of them. Every git call now blanks the filters the repo's config
  (including files it pulls in with `[include]` / `[includeIf]`, and `config.worktree`)
  and those of every submodule (nested ones too, up to 3 levels and 200 submodules; past
  that, the inside of submodules isn't checked rather than checked unsafely)
  defines before running.

## 1.0.0 — 2026-11-06

First tagged version.

### Viewer

- Lazy file tree of the focused terminal's folder, which follows the focused terminal,
  in local and remote spaces.
- Markdown preview: GFM prose, highlighted code fences with a copy button, and Mermaid
  diagrams with an expanded view (fit, zoom, two-axis scrolling).
- Highlighted source for JS/TS, Bash, Python, C, Go, JSON and YAML; plain text for the rest.
- Live reload while files change.
- Reading zoom (70–200 %) for prose, code and diagrams.
- Fuzzy file search in the tree, and find in the document with every match highlighted.
- Resizable sidebar; the tree can be hidden at any width.

### Git

- Change marks in the tree, and an overview ruler and line gutter in the code view.
- Commits: a GitLab-style graph with ref flags, an All branches | Current branch switch,
  a Remotes toggle, a commit view with old and new line numbers, and files as of a commit.
- Changes: staged, unstaged and untracked files with their diffs.

### Layout

- `main-fp` layout (a clone of Herdr's `main` 0.1.12) with file-preview as a side panel.
- `tabs-fp` tab bar (a clone of Herdr's `tabs` 0.1.12) with a Preview button; the side
  panel keeps its width and text zoom per tab.
- Shortcuts: `cmd-e` opens or closes the side panel, `cmd-shift-e` the popup.
