// Commit history, read-only: paged `git log` with graph lanes, one commit's files and diff, a file as of a commit,
// and the diff of one uncommitted change.
import { exec } from "herdr";
import { GIT } from "./git.js";
import { classify, LIMIT } from "./source.js";
import { sh, slash, localWindows } from "./shell.js";

export const PAGE = 300;
export const MAX_DIFF = 3000, MAX_FILE_DIFF = 1000;   // diff lines shown per commit and per file
const DIFF_BYTES = 2000000;
const US = "\x1f";
export const COLORS = 6;   // lane colors (graph.js palette)

// Refs that change the graph: HEAD and every branch, tag and remote ref, as one checksum.
const SIG = '{ g rev-parse -q --verify HEAD; g symbolic-ref -q HEAD; g for-each-ref --format="%(objectname)%(refname)" refs/heads refs/tags refs/remotes; } | cksum';

// $1 root, $2 skip, $3 count, $4 "all" | "local" (no remote branches) | "head" | "upstream" (HEAD and its
// remote branch, when it has one). Prints sig \1 HEAD \1 remotes \1 commits (NUL-separated,
// fields \x1f-separated). Exit 4: no git; 5: not a repo; 6: no commits yet.
const LOG = GIT + '; r=$1; s=$2; n=$3; w=$4; command -v git >/dev/null 2>&1 || exit 4; g rev-parse --git-dir >/dev/null 2>&1 || exit 5; '
  + 'h=$(g rev-parse -q --verify HEAD) || exit 6; ' + SIG + '; printf "\\001%s\\001" "$h"; g remote | tr "\\n" " "; printf "\\001"; '
  + 'case $w in all) set -- --branches --tags --remotes HEAD;; local) set -- --branches --tags HEAD;; '
  + 'upstream) if g rev-parse -q --verify "@{u}" >/dev/null 2>&1; then set -- HEAD "@{u}"; else set -- HEAD; fi;; *) set -- HEAD;; esac; '
  + 'g log "$@" --topo-order -z --no-color --format="%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s" --skip="$s" -n "$n"';

// $1 root. The refs checksum alone, for polling.
const SIG_ONLY = GIT + '; r=$1; command -v git >/dev/null 2>&1 || exit 4; ' + SIG;

// $1 root, $2 sha. Header \1 name-status \1 numstat \1 patch (against the first parent; capped in bytes).
const SHOW = GIT + '; r=$1; s=$2; command -v git >/dev/null 2>&1 || exit 4; '
  + 'g show -s --no-color --format="%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%B" "$s" || exit 5; printf "\\001"; '
  + 'set -- --format= --diff-merges=first-parent -M --no-color --no-ext-diff --no-textconv; '
  + 'g show "$@" --name-status -z "$s"; printf "\\001"; g show "$@" --numstat -z "$s"; printf "\\001"; '
  + 'g show "$@" --patch "$s" | head -c ' + DIFF_BYTES;

// $1 root, $2 "staged" | "unstaged" | "untracked", $3 path from the repo's top, $4 path from the root, $5 the old
// path of a staged rename (from the top) or "". numstat \1 patch (capped in bytes). `diff --no-index` exits 1
// when the files differ, so the exit code says nothing past "git is there".
const CHANGE = GIT + '; r=$1; command -v git >/dev/null 2>&1 || exit 4; '
  + 'case $2 in staged) set -- --cached -M -- ":(top)$3" ${5:+":(top)$5"};; unstaged) set -- -- ":(top)$3";; *) set -- --no-index -- /dev/null "$4";; esac; '
  + 'set -- --no-color --no-ext-diff --no-textconv "$@"; g diff --numstat -z "$@"; printf "\\001"; g diff "$@" | head -c ' + DIFF_BYTES + '; exit 0';

// $1 root, $2 "<rev>:<repo path>". The file's bytes, capped.
const CAT = GIT + '; r=$1; command -v git >/dev/null 2>&1 || exit 4; g cat-file -e "$2" 2>/dev/null || exit 5; g show "$2" | head -c ' + (LIMIT + 1);

/** "HEAD -> main, tag: v1, origin/main" → [{ name, kind: "branch" | "remote" | "tag" | "head", current, remote? }]. */
export function parseRefs(d, remotes) {
  const out = [];
  for (let s of d.split(", ")) {
    s = s.trim();
    if (!s) continue;
    if (s === "HEAD") { out.push({ name: "HEAD", kind: "head", current: true }); continue; }
    if (s.startsWith("HEAD -> ")) { out.push({ name: s.slice(8), kind: "branch", current: true }); continue; }
    if (s.startsWith("tag: ")) { out.push({ name: s.slice(5), kind: "tag", current: false }); continue; }
    if (s.endsWith("/HEAD")) continue;   // origin/HEAD only repeats a remote branch
    const remote = remotes.filter((r) => s.startsWith(r + "/")).sort((a, b) => b.length - a.length)[0];
    out.push(remote ? { name: s, kind: "remote", current: false, remote } : { name: s, kind: "branch", current: false });
  }
  // The checked-out branch first, then local branches, tags, remotes.
  const rank = (r) => (r.current ? 0 : r.kind === "branch" ? 1 : r.kind === "tag" ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Natural order: digit runs compare as numbers ("v1.10" after "v1.9"), the rest case-insensitively. */
function natural(a, b) {
  const x = a.toLowerCase().match(/\d+|\D+/g) ?? [], y = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const n = /^\d/.test(x[i]) && /^\d/.test(y[i]) ? Number(x[i]) - Number(y[i]) : 0;
    return n || (x[i] < y[i] ? -1 : 1);
  }
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
}

const MAIN = ["main", "master", "develop"];

/**
 * Refs as graph flags, computed once per commit. A remote branch on the same commit as its local one
 * folds into it (`{ ..., also: ["origin"] }`, drawn "main ⇄ origin"). Order: detached HEAD / the
 * checked-out branch; main, master, develop (local, then remote-only); other local branches, other
 * remote branches (alphabetical); tags, newest version first (natural order, descending).
 */
export function flags(refs) {
  const locals = new Map(), out = [];
  for (const r of refs) if (r.kind === "branch") locals.set(r.name, { ...r, also: [] });
  for (const r of refs) {
    if (r.kind === "branch") { out.push(locals.get(r.name)); continue; }
    if (r.kind === "remote") {
      const local = locals.get(r.name.slice(r.remote.length + 1));
      if (local) { local.also.push(r.remote); continue; }
    }
    out.push({ ...r, also: [] });
  }
  const rank = (r) => {
    if (r.current || r.kind === "head") return 0;
    if (r.kind === "tag") return 10;
    const m = MAIN.indexOf(r.kind === "remote" ? r.name.slice(r.remote.length + 1) : r.name);
    if (m >= 0) return (r.kind === "remote" ? 4 : 1) + m;
    return r.kind === "remote" ? 8 : 7;
  };
  return out.map((r) => [rank(r), r]).sort((a, b) => a[0] - b[0]
    || (a[0] === 10 ? natural(b[1].name, a[1].name) : natural(a[1].name, b[1].name))).map((e) => e[1]);
}

function commitOf(f, remotes, head) {
  const hash = f[0], refs = parseRefs(f[5] ?? "", remotes);
  return { hash, parents: f[1] ? f[1].split(" ") : [], author: f[2], email: f[3], at: Number(f[4]) || 0,
    refs, flags: flags(refs), subject: f[6] ?? "", head: hash === head };
}

const failure = (r) => (r.code === 4 ? { error: "git is not installed" } : r.code === 5 ? { notRepo: true } : r.code === 6 ? { empty: true } : { error: (r.stderr || "git log failed").trim().slice(0, 300) });

/**
 * One page of history. -> undefined (unreachable) | { notRepo } | { empty } | { error }
 *  | { sig, head, commits, more }
 */
export async function log(root, on, { skip = 0, count = PAGE, scope = "all" } = {}) {
  const r = await sh(LOG, ["fp", root, String(skip), String(count + 1), scope], { on }).catch(() => undefined);
  if (!r) return undefined;
  if (r.code !== 0) return failure(r);
  const parts = r.stdout.split("\x01");
  if (parts.length < 4) return { error: "Unexpected git output" };
  const sig = parts[0].trim(), head = parts[1], remotes = parts[2].split(" ").filter(Boolean);
  const commits = [];
  for (const rec of parts.slice(3).join("\x01").split("\0")) {
    const e = rec.replace(/^\n/, "");
    if (!e) continue;
    const f = e.split(US);
    if (f.length >= 7 && /^[0-9a-f]{7,64}$/.test(f[0])) commits.push(commitOf(f, remotes, head));
  }
  // Without remote branches, a local commit's origin/... flag goes too.
  if (scope === "local" || scope === "head") for (const c of commits) { c.refs = c.refs.filter((x) => x.kind !== "remote"); c.flags = flags(c.refs); }
  const more = commits.length > count;
  if (more) commits.length = count;
  return { sig, head, remotes, commits, more };
}

/** The refs checksum: changes with any commit, checkout, branch, tag or fetch. undefined when unreachable. */
export async function signature(root, on) {
  const r = await sh(SIG_ONLY, ["fp", root], { on }).catch(() => undefined);
  return r && r.code === 0 ? r.stdout.trim() : undefined;
}

// ---- lanes ----------------------------------------------------------------

/**
 * Lane assignment, page after page: `lanes[i]` is the hash lane i waits for (null: free).
 * A commit takes the lane waiting for it (else a free one: a branch tip); other lanes waiting
 * for it merge into its node; its first parent continues its lane, other parents take the lane
 * already waiting for them or a free one. Each row keeps its segments: [fromLane, fromY,
 * toLane, toY, color], y 0 = top, 1 = node, 2 = bottom.
 */
export class Graph {
  constructor() { this.lanes = []; this.colors = []; this.next = 0; this.width = 1; }

  /** The next color, skipping those of the lanes in use when it can (COLORS of them). */
  color() {
    const used = new Set(this.colors.filter((c, i) => this.lanes[i]).map((c) => c % COLORS));
    for (let k = 0; k < COLORS; k++) { const c = this.next++; if (!used.has(c % COLORS)) return c; }
    return this.next++;
  }

  free() {
    const i = this.lanes.indexOf(null);
    return i < 0 ? this.lanes.length : i;
  }

  add(c) {
    const L = this.lanes, C = this.colors, segs = [];
    let node = L.indexOf(c.hash);
    const tip = node < 0;
    if (tip) { node = this.free(); L[node] = c.hash; C[node] = this.color(); }
    for (let j = 0; j < L.length; j++) {
      if (L[j] === null || L[j] === undefined) continue;
      if (L[j] === c.hash) {
        if (j !== node || !tip) segs.push([j, 0, node, 1, C[j]]);
        if (j !== node) L[j] = null;   // merged into this node
      } else segs.push([j, 0, j, 2, C[j]]);
    }
    const color = C[node];
    const [first, ...rest] = c.parents;
    if (first) { L[node] = first; segs.push([node, 1, node, 2, C[node]]); }
    else L[node] = null;
    for (const p of rest) {
      let k = L.indexOf(p);
      if (k < 0) { k = this.free(); L[k] = p; C[k] = this.color(); }
      segs.push([node, 1, k, 2, C[k]]);
    }
    while (L.length && (L[L.length - 1] === null || L[L.length - 1] === undefined)) { L.pop(); C.pop(); }
    let w = node + 1;
    for (const s of segs) w = Math.max(w, s[0] + 1, s[2] + 1);
    this.width = Math.max(this.width, w);
    return { c, node, color, segs };
  }
}

// ---- one commit -------------------------------------------------------------

/** Status letters of `--name-status -z`: [{ status, path, from }]. */
function nameStatus(s) {
  const f = s.split("\0"), out = [];
  for (let i = 0; i < f.length; i++) {
    const st = f[i].replace(/^\n+/, "");
    if (!st) continue;
    const k = st[0];
    if (k === "R" || k === "C") { out.push({ status: k, from: f[i + 1], path: f[i + 2] }); i += 2; }
    else { out.push({ status: k, path: f[i + 1], from: null }); i += 1; }
  }
  return out;
}

/** `--numstat -z`: [{ add, del, binary }] in the same order. */
function numstat(s) {
  const f = s.split("\0"), out = [];
  for (let i = 0; i < f.length; i++) {
    const e = f[i].replace(/^\n+/, "");
    if (!e) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(e);
    if (!m) continue;
    out.push({ add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-" });
    if (m[3] === "") i += 2;   // a rename: old and new path follow
  }
  return out;
}

/**
 * The patch split per file: [{ lines: string[], kinds: string, olds, news, binary, cut }], kinds a/d/h/space
 * per line; olds and news the line's number in the old and the new file (0: none, as for a hunk header).
 */
function patches(text, cutBytes) {
  const out = [];
  let cur = null, total = 0, old = 0, now = 0;
  const lines = text.split("\n");
  if (cutBytes) lines.pop();   // a partial last line
  for (const l of lines) {
    if (l.startsWith("diff --git ") || l.startsWith("diff --cc ") || l.startsWith("diff --combined ")) {
      cur = { lines: [], kinds: [], olds: [], news: [], binary: false, cut: false, hunks: false };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!cur.hunks) {
      if (l.startsWith("@@")) cur.hunks = true;
      else { if (/^Binary files .* differ$/.test(l) || l === "GIT binary patch") cur.binary = true; continue; }
    }
    if (l === "\\ No newline at end of file") continue;
    if (cur.lines.length >= MAX_FILE_DIFF || total >= MAX_DIFF) { cur.cut = true; continue; }
    const k = l[0] === "+" ? "a" : l[0] === "-" ? "d" : l.startsWith("@@") ? "h" : " ";
    if (k === "h") {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
      old = m ? Number(m[1]) : 0; now = m ? Number(m[2]) : 0;
    }
    cur.lines.push(l);
    cur.kinds.push(k);
    cur.olds.push(k === " " || k === "d" ? old++ : 0);
    cur.news.push(k === " " || k === "a" ? now++ : 0);
    total++;
  }
  if (cutBytes && cur) cur.cut = true;
  for (const p of out) p.kinds = p.kinds.join("");
  return { files: out, total };
}

/**
 * -> undefined (unreachable) | { error } | { hash, parents, author, email, at, refs, subject, body,
 *    files: [{ status, path, from, add, del, binary, diff: { lines, kinds, cut } | null }], truncated }
 */
export async function show(root, on, sha, remotes = []) {
  const r = await sh(SHOW, ["fp", root, sha], { on }).catch(() => undefined);
  if (!r) return undefined;
  if (r.code === 4) return { error: "git is not installed" };
  const parts = r.stdout.split("\x01");
  if (parts.length < 4 || !parts[0].includes(US)) return { error: (r.stderr || "Cannot read this commit").trim().slice(0, 300) };
  const f = parts[0].replace(/\n+$/, "").split(US);
  const msg = (f.slice(6).join(US) ?? "").replace(/\s+$/, "");
  const nl = msg.indexOf("\n");
  const c = commitOf([f[0], f[1], f[2], f[3], f[4], f[5], nl < 0 ? msg : msg.slice(0, nl)], remotes, null);
  c.body = nl < 0 ? "" : msg.slice(nl + 1).replace(/^\n+/, "");
  const names = nameStatus(parts[1]), nums = numstat(parts[2]);
  const patch = parts.slice(3).join("\x01").replace(/^\n+/, "");
  const cutBytes = patch.length >= DIFF_BYTES;
  const p = patches(patch, cutBytes);
  c.files = names.map((n, i) => ({ ...n, add: nums[i]?.add ?? 0, del: nums[i]?.del ?? 0, binary: Boolean(nums[i]?.binary || p.files[i]?.binary), diff: p.files[i] ?? null }));
  c.truncated = cutBytes || p.files.some((x) => x.cut);
  return c;
}

/**
 * One uncommitted change (a git.status() changes entry in `section`), shaped like a commit's file.
 * -> undefined (unreachable) | { error } | { status, path, from, add, del, binary, diff, truncated }
 */
export async function change(root, on, section, e) {
  const r = await sh(CHANGE, ["fp", root, section, e.top, e.path, e.from ?? ""], { on }).catch(() => undefined);
  if (!r) return undefined;
  if (r.code === 4) return { error: "git is not installed" };
  const parts = r.stdout.split("\x01"), nums = numstat(parts[0] ?? "");
  const patch = parts.slice(1).join("\x01").replace(/^\n+/, ""), cutBytes = patch.length >= DIFF_BYTES;
  const d = patches(patch, cutBytes).files[0] ?? null;
  return { status: e.status, path: e.path, from: e.from, add: nums[0]?.add ?? 0, del: nums[0]?.del ?? 0,
    binary: Boolean(nums[0]?.binary || d?.binary), diff: d, truncated: Boolean(d?.cut) };
}

/**
 * A file's content at a revision ("<sha>:<path>", path from the repo's top), shaped like readSource's result.
 */
export async function readAt(root, on, rev, path) {
  const r = await sh(CAT, ["fp", root, `${rev}:${path}`], { on }).catch(() => undefined);
  if (!r) return { kind: "error", message: "Cannot read this file (machine unreachable?)" };
  if (r.code === 5) return { kind: "missing", message: "This file is not in that commit" };
  if (r.code !== 0) return { kind: "error", message: (r.stderr || "Cannot read this file").trim().slice(0, 200) };
  return classify(path, r.stdout, r.stdout.length > LIMIT);
}

// ---- dates ---------------------------------------------------------------------

const UNITS = [["y", 31536000, "year"], ["mo", 2592000, "month"], ["w", 604800, "week"], ["d", 86400, "day"], ["h", 3600, "hour"], ["m", 60, "minute"]];

/** "3d" (short) or "3 days ago". */
export function relative(at, short = false) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - at));
  for (const [u, n, w] of UNITS) {
    if (s >= n) { const k = Math.floor(s / n); return short ? `${k}${u}` : `${k} ${w}${k === 1 ? "" : "s"} ago`; }
  }
  return short ? "now" : "just now";
}

/** "2026-11-03 14:05" in local time. */
export function absolute(at) {
  const d = new Date(at * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
