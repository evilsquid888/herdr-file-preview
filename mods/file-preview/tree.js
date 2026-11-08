// Lazy folder tree, listed with one POSIX script here or on a remote machine.
import { exec } from "herdr";
import { sh, slash, localWindows } from "./shell.js";

export const PER_FOLDER = 500, TOTAL = 5000;

// NUL-separated "d|f" and name pairs; skips .git; exit 3 when the folder can't be read.
const LIST = 'test -d "$1" || exit 2; { test -r "$1" && test -x "$1"; } || exit 3; n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then k=d; else k=f; fi; printf "%s\\0%s\\0" "$k" "$name"; n=$((n+1)); [ "$n" -gt ' + PER_FOLDER + ' ] && break; done; exit 0';

async function directory(abs, on) {
  let r;
  try { r = await sh(LIST, ["fp", abs], { on }); }
  catch (e) {
    // exec rejects only when it cannot run at all: on a remote space, the machine is unreachable.
    const err = new Error(on ? `Cannot reach ${on}: ${String(e.message ?? e)}` : String(e.message ?? e));
    err.unreachable = true;
    throw err;
  }
  if (r.code === 3) return { denied: true, entries: [] };
  if (r.code !== 0) throw new Error((r.stderr || "Cannot list this folder").trim());
  const f = r.stdout.split("\0"), entries = [];
  for (let i = 0; i + 1 < f.length; i += 2) entries.push({ name: f[i + 1], dir: f[i] === "d" });
  return { denied: false, entries };
}

const join = (a, b) => (a ? `${a}/${b}` : b);
export const parent = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

/** One tree per context { cwd, on }. Paths are relative to the root ("" is the root). */
export class Tree {
  constructor(root, on) {
    this.root = root; this.on = on;
    this.entries = new Map();   // rel folder -> sorted entries
    this.expanded = new Set();
    this.denied = new Set();
    this.pending = new Set();
    this.limited = false;
    this.error = null;
    this.offline = null;    // set while the machine can't be reached; what was loaded stays
    this.loaded = false;
  }

  abs(rel) { return rel ? (this.root === "/" ? "/" : this.root + "/") + rel : this.root; }

  /** The root-relative path of an absolute one, or null when it is outside the root. */
  rel(abs) {
    if (abs === this.root) return "";
    const pre = this.root.endsWith("/") ? this.root : this.root + "/";
    return abs.startsWith(pre) ? abs.slice(pre.length) : null;
  }

  count(except) {
    let n = 0;
    for (const [p, e] of this.entries) if (p !== except) n += e.length;
    return n;
  }

  /** Lists one folder; returns false when this tree was dropped meanwhile (alive() says so). */
  async load(rel, alive) {
    this.pending.add(rel);
    try {
      const { denied, entries } = await directory(this.abs(rel), this.on);
      this.offline = null;
      if (!alive()) return false;
      if (rel && !this.expanded.has(rel)) return true;
      if (denied) { this.denied.add(rel); if (rel) this.expanded.delete(rel); else { this.entries.set("", []); this.error = "No permission to read this folder"; } return true; }
      this.denied.delete(rel);
      const used = this.count(rel), room = Math.max(0, Math.min(PER_FOLDER, TOTAL - used));
      if (entries.length > room) this.limited = true;
      entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      this.entries.set(rel, entries.slice(0, room));
      if (!rel) { this.loaded = true; this.error = null; }
      return true;
    } finally {
      this.pending.delete(rel);
    }
  }

  /**
   * Reloads the root and every expanded folder (or only the listed ones), parents first.
   * An unreachable machine stops it and keeps everything loaded so far: Retry starts over.
   */
  async reload(alive, only = null) {
    if (!only) this.limited = false;
    const folders = only ? [...only] : ["", ...this.expanded];
    folders.sort((a, b) => (a ? a.split("/").length : 0) - (b ? b.split("/").length : 0));
    for (const rel of folders) {
      if (rel && !this.expanded.has(rel)) continue;
      try { if (!(await this.load(rel, alive))) return; }
      catch (e) {
        if (!alive()) return;
        if (e.unreachable) { this.offline = e.message; return; }
        if (!rel) { this.error = String(e.message ?? e); return; }
        this.expanded.delete(rel); this.entries.delete(rel);   // that folder is gone
      }
    }
  }

  collapse(rel) {
    for (const f of [...this.expanded]) if (f === rel || f.startsWith(rel + "/")) { this.expanded.delete(f); this.entries.delete(f); }
  }

  /** The visible rows, depth-first: [{ path, name, dir, depth, denied }]. */
  rows() {
    const out = [];
    const walk = (prefix, depth) => {
      for (const e of this.entries.get(prefix) ?? []) {
        if (out.length >= TOTAL) return;
        const path = join(prefix, e.name);
        out.push({ path, name: e.name, dir: e.dir, depth, denied: this.denied.has(path) });
        if (e.dir && this.expanded.has(path) && depth < 40) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }
}
