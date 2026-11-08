// Git decorations, read-only: file status for the tree and changed lines for the document.
import { exec } from "herdr";
import { sh, slash, localWindows } from "./shell.js";

// Reads that write nothing under .git (no index refresh, lock or fsmonitor cookie): the folder
// watch would see the write and start the next refresh. quotepath=off keeps UTF-8 names raw.
//
// A repository's own config can name programs. `filter.<name>.clean` and `.process` run `sh -c` on
// every tracked file that `status` or `diff` re-hashes, and a copied folder's stale stat info makes
// that every file, on every poll. Before its first git call, `g` lists the repo's filters (`git
// config` runs nothing) and blanks each one through GIT_CONFIG_*, which git treats like -c, so the
// clean, smudge and process commands are empty and `required` can't make that an error. Names are
// newline-separated: git refuses a newline in a subsection name. A filter can't be named by
// wildcard, so this covers in-tree .gitattributes and .git/info/attributes alike.
// The listing follows [include] / [includeIf] (--includes: a file option like --local doesn't by
// default) and also reads the worktree's own config.worktree (--worktree; without that extension
// it reads .git/config again, which only repeats names). Either listing may fail on its own, so
// neither can cut the other short. Filters set in your global or system config are yours, not
// the folder's, and stay on (git-lfs keeps working).
//
// Submodules: `git status` runs another git inside each one, which inherits the -c options and
// GIT_CONFIG_* (so fsmonitor & co. stay off there), but a submodule's own config can name its own
// filters. So fpL walks the submodules too, breadth first (sh functions have no local variables,
// so no recursion): `ls-files --stage` lists them (mode 160000; it reads the index and hashes
// nothing), and `git config` inside each reads that submodule's config, absorbed
// (.git/modules/…) or not. Up to 3 levels and 200 submodules; past that, `!cap` makes g() ignore
// the inside of submodules (diff.ignoreSubmodules=dirty) instead of leaving any unchecked.
// (Its variables are fp-prefixed: the scripts that use `g` keep short names like $n and $s.)
const LIST_FILTERS = 'fpL() { fpQ=$r; fpD=0; fpC=0; '
  + 'while [ -n "$fpQ" ]; do fpX=""; for fpW in $fpQ; do '
  + 'git -C "$fpW" config --local --includes --name-only --get-regexp "^filter[.]"; '
  + 'git -C "$fpW" config --worktree --includes --name-only --get-regexp "^filter[.]"; '
  + '[ "$fpD" -lt 3 ] || continue; '
  + 'for fpS in $(git -c core.fsmonitor=false -c core.quotepath=off -C "$fpW" ls-files --stage | grep "^160000 " | cut -f2-); do '
  + 'case "$fpS" in \\"*) echo "!cap"; continue;; esac; '
  + 'fpC=$((fpC+1)); if [ "$fpC" -gt 200 ]; then echo "!cap"; break; fi; '
  + 'fpX="$fpX$fpW/$fpS\n"; done; done; fpQ=$fpX; fpD=$((fpD+1)); done; }';
const FILTERS = LIST_FILTERS + '; fpF() { fpF=1; fpI=${GIT_CONFIG_COUNT:-0}; '
  + 'fpN=$( IFS="\n"; set -f; fpL 2>/dev/null; true ); '
  + 'case "$fpN" in *"!cap"*) export "GIT_CONFIG_KEY_$fpI=diff.ignoreSubmodules" "GIT_CONFIG_VALUE_$fpI=dirty"; fpI=$((fpI+1));; esac; '
  + 'fpIFS=$IFS; IFS="\n"; set -f; for fpK in $fpN; do case "$fpK" in filter.*) ;; *) continue;; esac; fpK=${fpK#filter.}; fpK=${fpK%.*}; '
  + 'for fpV in clean smudge process; do export "GIT_CONFIG_KEY_$fpI=filter.$fpK.$fpV" "GIT_CONFIG_VALUE_$fpI="; fpI=$((fpI+1)); done; '
  + 'export "GIT_CONFIG_KEY_$fpI=filter.$fpK.required" "GIT_CONFIG_VALUE_$fpI=false"; fpI=$((fpI+1)); done; '
  + 'set +f; IFS=$fpIFS; export GIT_CONFIG_COUNT=$fpI; }';
export const GIT = FILTERS + '; g() { [ -n "$fpF" ] || fpF; git --no-optional-locks -c core.fsmonitor=false -c log.showSignature=false -c gpg.program=false -c core.quotepath=off -c diff.autoRefreshIndex=false -C "$r" "$@"; }';

// $1 root (git -C, so a remote root works the same). Prints "<prefix of the root in its repo>\0" then the porcelain status.
// Exit 4: no git; 5: not a work tree.
const STATUS = GIT + '; r=$1; command -v git >/dev/null 2>&1 || exit 4; p=$(g rev-parse --show-prefix 2>/dev/null) || exit 5; printf "%s\\0" "$p"; g status --porcelain=v1 -z --untracked-files=all';

// $1 root, $2 file relative to it. Prints the file's status, \1, H or N (HEAD or none), \1, the diff.
const DIFF = GIT + '; r=$1; f=$2; command -v git >/dev/null 2>&1 || exit 4; g rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 5; g status --porcelain=v1 -z --untracked-files=all -- "$f" || exit 5; printf "\\001"; if g rev-parse -q --verify HEAD >/dev/null; then printf "H\\001"; g diff --no-color --no-ext-diff --no-textconv -U0 HEAD -- "$f"; else printf "N\\001"; fi';

const MAX_ENTRIES = 20000;

/** Tree letter of a porcelain XY, or null (deleted: not in the tree). */
function letter(xy) {
  if (xy === "??") return "U";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "!";
  if (xy.includes("D")) return null;
  if (/[ARC]/.test(xy[0])) return "A";
  return "M";
}

// Folder tint: the most important change below it.
const RANK = { "!": 3, M: 2, A: 1, U: 1 };

/**
 * -> null (not a repo, no git) | undefined (machine unreachable: keep what is shown)
 *  | { files: Map<rel, letter>, folders: Map<rel, letter>, changes }, paths relative to `root`, only under it.
 * `changes` is { staged, unstaged, untracked, sig }: [{ path, top, from, status }] per section (`top` and
 * `from` from the repo's top; status a name-status letter) and a string that changes when any entry does.
 */
export async function status(root, on) {
  const r = await sh(STATUS, ["fp", root], { on }).catch(() => undefined);
  if (!r) return undefined;
  if (r.code !== 0) return null;
  const f = r.stdout.split("\0"), prefix = f[0], files = new Map(), folders = new Map();
  const changes = { staged: [], unstaged: [], untracked: [], sig: "" };
  for (let i = 1, n = 0; i < f.length && n < MAX_ENTRIES; i++, n++) {
    const e = f[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), path = e.slice(3);
    const from = /[RC]/.test(xy) ? f[++i] : null;   // the old path follows a rename or copy
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    if (!rel || rel.endsWith("/")) continue;
    changes.sig += e + "\0";
    if (xy === "??") changes.untracked.push({ path: rel, top: path, from: null, status: "U" });
    else if (xy.includes("U") || xy === "AA" || xy === "DD") changes.unstaged.push({ path: rel, top: path, from: null, status: "!" });
    else {
      if (xy[0] !== " ") changes.staged.push({ path: rel, top: path, from, status: xy[0] });
      if (xy[1] !== " ") changes.unstaged.push({ path: rel, top: path, from: null, status: xy[1] });
    }
    const l = letter(xy);
    if (!l) continue;
    files.set(rel, l);
    for (let k = rel.lastIndexOf("/"); k > 0; k = rel.lastIndexOf("/", k - 1)) {
      const dir = rel.slice(0, k), was = folders.get(dir);
      if (was && RANK[was] >= RANK[l]) break;   // its parents already rank as high
      folders.set(dir, l);
    }
  }
  return { files, folders, changes };
}

const lineCount = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

/**
 * Changed lines of one file against HEAD (staged and unstaged).
 * -> null (not in a repo, clean, ignored) | undefined (unreachable) | { lines: Map<line, "a" | "m">, dels: Set<n> }
 * Lines from 1; a deletion n sits after line n (0: above the first).
 */
export async function changes(root, rel, text, on) {
  const r = await sh(DIFF, ["fp", root, rel], { on }).catch(() => undefined);
  if (!r) return undefined;
  if (r.code !== 0) return null;
  const [st, head, diff = ""] = splitOnce(r.stdout);
  const xy = st.slice(0, 2);
  if (!xy || xy === "!!") return null;
  const lines = new Map(), dels = new Set();
  // Untracked, or nothing committed yet: every line is new.
  if (xy === "??" || head !== "H") return added(text);
  for (const h of diff.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const old = h[1] === undefined ? 1 : Number(h[1]), at = Number(h[2]), n = h[3] === undefined ? 1 : Number(h[3]);
    if (n === 0) { dels.add(at); continue; }
    for (let i = at; i < at + n; i++) lines.set(i, old === 0 ? "a" : "m");
  }
  return lines.size || dels.size ? { lines, dels } : null;
}

/** Every line of `text` added (an untracked file). */
export function added(text) {
  const lines = new Map();
  for (let i = 1, n = lineCount(text); i <= n; i++) lines.set(i, "a");
  return { lines, dels: new Set() };
}

/** Same files, folders and changes, so nothing to redraw. */
export function same(a, b) {
  if (!a || !b) return a === b;
  if (a.changes.sig !== b.changes.sig) return false;
  if (a.files.size !== b.files.size || a.folders.size !== b.folders.size) return false;
  for (const [k, v] of a.files) if (b.files.get(k) !== v) return false;
  for (const [k, v] of a.folders) if (b.folders.get(k) !== v) return false;
  return true;
}

/** Runs of equal changed lines: [{ from, n, kind }], in order. */
export function runs(marks) {
  const out = [];
  for (const i of [...marks.lines.keys()].sort((a, b) => a - b)) {
    const k = marks.lines.get(i), last = out[out.length - 1];
    if (last && last.kind === k && last.from + last.n === i) last.n++;
    else out.push({ from: i, n: 1, kind: k });
  }
  return out;
}

function splitOnce(s) {
  const a = s.indexOf("\x01"), b = a < 0 ? -1 : s.indexOf("\x01", a + 1);
  if (a < 0) return [s, "", ""];
  if (b < 0) return [s.slice(0, a), s.slice(a + 1), ""];
  return [s.slice(0, a), s.slice(a + 1, b), s.slice(b + 1)];
}
