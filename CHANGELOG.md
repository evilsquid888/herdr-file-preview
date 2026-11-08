# Changelog

Each version is a git tag (`vX.Y.Z`) on this repo. Herdr doesn't update layouts or mods
you installed from herdr.dev: see [Updating](README.md#updating) to move to a newer one.

Versions follow [Semantic Versioning](https://semver.org/): a major version changes
something you set up yourself (a mod or layout name, a shortcut, a `keys.json` entry),
so read its notes before updating.

## 1.1.0 — 2026-11-07 (evilsquid888 fork)

### Comments

- Comment on a paragraph (drag across it, or right-click): edit, delete, kept per machine
  and file in `~/.config/herdr-app/data/file-preview/comments.json`, and found again
  after the file changes.
- **Send to agent** pastes the comments as numbered Markdown into the prompt of the
  agent in the shown tab, without Enter, for review there; **Copy** and **Clear**.
- Markdown prose is split into one block per paragraph (search frames and git marks are
  per paragraph too).

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
