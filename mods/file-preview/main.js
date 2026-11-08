// A tree of the focused terminal's folder and a rendered preview of the chosen file:
// Markdown (prose in TextView, fences highlighted in readonly Editors, Mermaid as PNG) and code.
// It follows the focused terminal (local or remote space) and reloads what it shows when it changes.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, h_resizable, resizable_panel, Editor, EditorState, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input, Textarea, TextareaState } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, props, closeOverlay, openOverlay, nextCommand, home, window, run, shared, setShared, agents } from "herdr";
import { Tree, parent, PER_FOLDER, TOTAL } from "./tree.js";
import { readSource, stamp, LIMIT } from "./source.js";
import { segment } from "./markdown.js";
import * as lang from "./lang.js";
import { Mermaid, fnv1a, cacheKey, themeOf } from "./mermaid.js";
import { sideAvailable, showSide, hideSide, panelOf, focusedTab } from "./dock.js";
import { Zoom, zoomKey, ZOOM_CONTEXT, ZOOM_ESCAPE } from "./zoom.js";
import * as git from "./git.js";
import { listFiles, rank, occurrences, positions, markMatches, syntaxMask, headings, section, FIND_CONTEXT, FIND_ESCAPE, FIND_OPEN, TREE_CONTEXT, DOC_CONTEXT } from "./find.js";
import { rootKey, recall, snapshot, remember, forget } from "./memory.js";
import * as hist from "./commits.js";
import { cell, reach, pointer, palette } from "./graph.js";
import { Notes, noteKey, quoteOf, DRAG_PX } from "./annotate.js";

const ICON = "mods/file-preview/icons/";
const ROW = 22;              // tree row height
const FONT = 12;             // code font size at 100 %
const PROSE = 13;            // Markdown prose size at 100 %
// Editor metrics, measured at 12, 13, 14, 16 and 18 px: line height is GPUI's phi rounded, a
// mono char is 0.6 em, and soft wrap leaves WRAP_PAD px of the fence width without text.
const lineHeight = (font) => Math.round(font * 1.618034);
const charWidth = (font) => font * 0.6;
const WRAP_PAD = 24;
const CODE_PAD = 6;          // space above and below a fence's text
const COPIED_MS = 1500;
const MAX_EDITORS = 300;     // fences past this stay in the prose, uncolored
const MAX_DIAGRAM_W = 600;   // diagram display width cap (logical px), besides the column and half the PNG
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEBOUNCE = 200, MAX_WAIT = 1000;   // live reload: agents write in bursts
const COL_W = 1200;                       // reading column cap at 100 % text zoom; scales with it
const POLL_FILE = 2500, POLL_TREE = 10000;
const TREE_W = 260, NARROW = 600;   // below NARROW px the tree folds into a strip
const STRIP_W = 28, NARROW_TREE_W = 220;
const TREE_KEY = "file-preview.tree.";   // + "popup" | "side" | "panel": the last explicit hide/show, persisted
// Reading zoom of the document (prose, fences, code view, diagrams); never the bars or the tree.
const LEVELS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const ZOOM_KEY = "file-preview.zoom.";   // + "popup" | "panel": the level, persisted (null at 100 %)
const TAB_ZOOM_KEY = "file-preview.zoom.side.tabs";   // the side panel's level per tab: { [tab id]: level }
// Git decorations: status poll, the code view's line gutter and the long file's overview ruler.
const POLL_GIT = 5000;
// A full-height Editor lays out every row each frame: ~16 ms at 1000 rows, 45 ms at 2000.
const FULL_MAX = 1000;       // code files up to this many rows get a line gutter; longer ones, the ruler
const GUTTER = 8, RULER = 14;   // RULER: the overview strip of a long file (git changes, search hits)
const BAR_X = 8;             // a Markdown block's search bar sits this far right of the column
const FILES_EVERY = 5000;    // an open file search re-lists the root at most this often
const MEMORY_DELAY = 500;    // the popup stores its per-root state this long after the last change
// Commit history in the sidebar.
const SIDE_KEY = "file-preview.sidebar.";   // + "popup" | "side" | "panel": "commits" | "changes", or null for files
const CROW = 24;             // commit row height
const LANE_W = 14, NARROW_LANE_W = 10, MAX_LANES = 10, NARROW_MAX_LANES = 6;
const COMMITS_W = 460;       // the sidebar's width on the Commits tab, when the view is wide
const META_W = 360;          // author and date show from this sidebar width
const SCOPE_KEY = "file-preview.commits.scope";       // "head", or null for all branches
const REMOTES_KEY = "file-preview.commits.remotes";   // false hides remote branches, else null
const SIDE_W_KEY = "file-preview.sidebar-width.";   // + mode + "." + "files" | "commits" | "changes" | "narrow": px, or null
const SECTIONS = [["staged", "Staged"], ["unstaged", "Unstaged"], ["untracked", "Untracked"]];   // the Changes tab
const MIN_SIDE_W = 160, MIN_PREVIEW_W = 240;          // a dragged sidebar keeps the preview at least this wide
const statusColor = (s, t) => (s === "A" ? t.ansi2 : s === "D" ? t.ansi1 : s === "R" || s === "C" ? t.ansi4 : t.ansi3);

/** Reading zoom action of an unmodified key: "in" | "out" | "reset" | null. */
function textKey(e) {
  const m = e.modifiers;
  if (m.platform || m.control || m.alt) return null;
  const k = e.key, c = e.key_char;
  if (c === "+" || k === "+" || k === "=") return "in";
  if (c === "-" || k === "-") return "out";
  if (k === "0") return "reset";
  return null;
}

// Same shape as mods/files: where the focused terminal is, and on which machine.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on };
}

const ctxKey = (l) => JSON.stringify([l.cwd ?? null, l.on ?? null]);

/** The shown tab's id (the active space's active tab), or null without a window. */
function activeTab() {
  return spaces().find((s) => s.active)?.tabs?.find((t) => t.active)?.id ?? null;
}

/** The side panel's reading zoom for a tab: its own level, else 100 %. */
function tabZoom(tab) {
  const z = (shared(TAB_ZOOM_KEY) ?? {})[tab];
  return LEVELS.includes(z) ? z : 1;
}

/** Keeps a tab's level (100 % is the default, so it goes); closed tabs go with the write. */
function keepTabZoom(tab, z) {
  if (!tab) return;
  const open = new Set(spaces().flatMap((s) => s.tabs?.map((t) => t.id) ?? []));
  const all = Object.fromEntries(Object.entries(shared(TAB_ZOOM_KEY) ?? {}).filter(([k]) => open.has(k) && k !== tab));
  if (z !== 1) all[tab] = z;
  setShared(TAB_ZOOM_KEY, Object.keys(all).length ? all : null);
}
/** Folders above a root-relative path, outermost first ([] for null or a top-level entry). */
const ancestors = (rel) => (rel ? rel.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/")) : []);

// The first context: a launcher's props, else the focused terminal, else (focus on a mod
// pane, e.g. this panel right after its split) a terminal in the same tab.
function initial(p) {
  if (p?.cwd) return { cwd: p.cwd, on: p.on ?? null };
  const f = focused();
  if (f && !f.terminal) {
    const space = spaces().find((s) => s.active);
    const term = panes().find((x) => x.tab === f.tab && x.terminal && x.cwd);
    if (term) return { cwd: term.cwd, on: space?.machine ?? null };
  }
  return location();
}

function normalize(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return "/" + out.join("/");
}

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 5 ? "updated just now" : s < 60 ? `updated ${s}s ago` : s < 3600 ? `updated ${Math.floor(s / 60)} min ago` : `updated ${Math.floor(s / 3600)} h ago`;
}

const tilde = (p) => { const h = home(); return p && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p ?? ""; };
const plural = (n, w) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

/** Rows of an Editor holding `text` (a trailing newline leaves an empty last row). */
function rowCount(text) {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** Color of a git letter: conflict red, modified yellow, added or untracked green. */
const gitColor = (g, t) => (g === "!" ? t.ansi1 : g === "M" ? t.ansi3 : t.ansi2);
const barColor = (kind, t) => (kind === "a" ? t.ansi2 : t.ansi4);
/** A theme color with an alpha byte ("#rrggbb" only), else null. */
const tint = (c, a) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c + a : null);
/** `a` laid over `b` at weight w, opaque (#rrggbb), or null when either isn't #rrggbb. */
function blend(a, b, w) {
  const hex = /^#[0-9a-f]{6}$/i;
  if (typeof a !== "string" || typeof b !== "string" || !hex.test(a) || !hex.test(b)) return null;
  let out = "#";
  for (let i = 1; i < 7; i += 2) out += Math.round(w * parseInt(a.slice(i, i + 2), 16) + (1 - w) * parseInt(b.slice(i, i + 2), 16)).toString(16).padStart(2, "0");
  return out;
}
const matches = (n) => `${n.toLocaleString("en-US")} match${n === 1 ? "" : "es"}`;

function syntax() {
  const t = theme();
  return { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
}

export default class FilePreview extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.overlay = p.overlay ?? null;
    this.mode = p.mode ?? "popup";
    this.pinned = Boolean(p.pin && p.cwd);   // opened on a given folder (a launcher): don't follow the focused terminal
    this.fromSide = p.from === "side" && Boolean(this.overlay);   // a popup opened from the side panel goes back to it
    this.zoom = null;       // the expanded diagram (Zoom), if any
    this.blocks = [];       // [{ kind: "md", text } | { kind: "code", info, lines, state }]
    // Annotations: a press in a paragraph (pressed), the "+ Comment" bar a drag offers (aiming),
    // the open comment field (commenting). Notes live on this computer (annotate.js).
    this.notes = new Notes();
    this.pressed = null; this.aiming = null; this.commenting = null;
    cx.spawn(async (cx) => { await this.notes.load(); cx.notify(); });
    this.zoomFocus = cx.focus_handle();
    // Esc is the app's (it closes the popup's dialog before on_key_down sees it):
    // a binding of our own, scoped to the expanded diagram's key context, comes first.
    try { cx.bind_keys([{ keystroke: "escape", action: ZOOM_ESCAPE, context: ZOOM_CONTEXT }]); } catch {}
    // The same for a search field; cmd-f opens the search of the pane that has the keyboard.
    try {
      cx.bind_keys([{ keystroke: "escape", action: FIND_ESCAPE, context: FIND_CONTEXT },
        { keystroke: "cmd-f", action: FIND_OPEN, context: TREE_CONTEXT }, { keystroke: "cmd-f", action: FIND_OPEN, context: DOC_CONTEXT }]);
    } catch {}
    // A panel's expanded diagram: this copy is only that dialog (no tree, context or watchers).
    if (this.mode === "diagram") return this.initDiagram(p, cx);
    this.treeFocus = cx.focus_handle();
    this.previewFocus = cx.focus_handle();
    this.commitsFocus = cx.focus_handle();
    this.changesFocus = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.commitScroll = VirtualListScrollHandle.new();
    const side = shared(SIDE_KEY + this.mode);
    this.side = side === "commits" || side === "changes" ? side : "files";   // the sidebar tab chosen
    this.scope = shared(SCOPE_KEY) === "head" ? "head" : "all";   // history of every branch ("all") or of HEAD ("head")
    this.remotes = shared(REMOTES_KEY) !== false;   // with "all": remote branches too
    this.commit = null;     // the commit shown: { hash, data, loading, error }; or an uncommitted change: { change, ... }
    this.changeScroll = VirtualListScrollHandle.new();
    this.changeCursor = null;   // keyboard row of the Changes tab ("<section>:<rel path>")
    this.atCommit = null;   // a file shown as of a commit: { hash, short, subject, path, kept }
    this.findScroll = VirtualListScrollHandle.new();
    this.ts = null;         // file search of the tree: { input, query, results, total, at, ... }
    this.ds = null;         // search in the shown document: { input, query, hits, total, blocks, at, heads }
    this.inInput = false;   // the key on its way up came from a search field
    this.cursor = null;     // keyboard row (rel path)
    this.file = null;       // shown file (rel path)
    this.doc = null;        // what readSource returned, plus segments for Markdown
    this.code = null;       // EditorState of a code/text file
    this.seq = 0;           // bumps on every file load; late results are dropped
    this.stamp = null;      // "<mtime> <size>" of the shown file, when polled
    this.loadedAt = null;   // when the shown content last changed
    this.dark = settings().dark;
    this.colW = null;       // measured width of the Markdown column (for diagram sizes)
    // The side panel (one for the window) keeps a level per tab; the popup and a docked pane, one each.
    this.zoomTab = this.mode === "side" ? activeTab() : null;
    const z = this.mode === "side" ? tabZoom(this.zoomTab) : shared(ZOOM_KEY + this.mode);
    this.textZoom = LEVELS.includes(z) ? z : 1;
    this.codeFont = Math.round(FONT * this.textZoom);   // font size of every Editor
    this.width = null;      // measured width of the whole view
    this.sideW = null;      // measured width of the sidebar (it can be dragged)
    // Narrow view without a stored choice: the tree is unfolded. A 45 % panel is ~550 px on a
    // 1512 px window, so it starts open unless a file comes with the props (the popup's Anchor).
    this.treeOpen = typeof p.file !== "string";
    const pref = shared(TREE_KEY + this.mode);
    this.treePref = typeof pref === "boolean" ? pref : null;   // an explicit toggle wins over the defaults
    this.mermaid = new Mermaid();
    cx.spawn(async () => { await this.mermaid.prune(); });
    // The popup and the side panel (it follows the focused terminal from root to root) remember
    // their file and folders per root; a docked pane stays put anyway.
    this.remembers = this.mode === "side" || (this.mode === "popup" && Boolean(this.overlay));
    this.page = "list";     // stacked (side panel): the sidebar's list, or "view" (what it opened, full width)
    const first = initial(p);
    this.start(first, ctxKey(first), cx, typeof p.file !== "string");
    // Dev/test aid, harmless: props { file } preselects a file (relative to the root, or absolute).
    if (typeof p.file === "string") this.reveal(p.file, cx);
    this.treeFocus.focus();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
    // "updated N s ago" in the status bar; nothing to redraw without a file.
    cx.timer.every(5000, (cx) => { if (this.file && this.loadedAt) cx.notify(); });
  }

  initDiagram(p, cx) {
    this.mermaid = new Mermaid();
    const d = p.diagram;
    if (d?.path && d.w > 0 && d.h > 0) this.zoom = new Zoom(d, this.mermaid, p.label ?? "Diagram");
    this.zoomFocus.focus();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (this.zoom && c.startsWith("zoom-")) this.zoomAct(c.slice(5), cx);
        cx.notify();
      }
    });
  }

  async close() {
    this.memFlush();
    // However it closes (Esc, ✕, cmd-e, the anchor), the side panel it came from shows again.
    if (this.fromSide && !this.closed) { try { showSide(); } catch {} }
    this.closed = true;
    if (this.zoom) this.zoom.closed = true;
    this.zoomFocus?.release();
    this.mermaid?.close();
    this.release();
    this.seq++;
    if (this.ctx) this.stop(this.ctx);
    this.ctx = null;
    this.scroll?.release();
    this.findScroll?.release();
    this.ts?.input.release();
    this.ds?.input.release();
    this.ts = this.ds = null;
    this.closeCommitView();
    this.commitScroll?.release();
    this.treeFocus?.release();
    this.previewFocus?.release();
    this.commitsFocus?.release();
    this.changesFocus?.release();
    this.changeScroll?.release();
  }

  // ---- context and tree ----------------------------------------------------

  /** Drops the tree and every watcher of the old context. `key` is the raw location key. */
  start(ctx, key, cx, restore = true) {
    if (this.ctx) this.stop(this.ctx);
    this.ctxKey = key;
    const cwd = ctx.cwd || (ctx.on ? "" : home());
    this.ctx = { cwd, on: ctx.on ?? null, key, tasks: [], dirty: new Set(), all: false };
    this.tree = new Tree(cwd, this.ctx.on);
    // memory: { key, saved, sig, ready, timer }; nothing is stored before the saved state is back.
    this.ctx.memory = this.remembers ? { key: null, saved: null, sig: null, ready: false, timer: null, restore } : null;
    if (cwd) this.recallRoot(this.ctx);
    this.git = null;        // { files, folders } of the root's repo; null outside one
    this.gitPending = true; // no status yet: keep the remembered tab instead of falling back to Files
    this.cursor = null;
    if (this.ts) this.closeTreeFind(null, false);
    this.show(null);
    const c = this.ctx;
    c.tasks.push(cx.timer.every(POLL_GIT, (cx) => this.gitRefresh(c, cx)));
    if (cwd) { this.refreshTree(this.ctx, null, cx, true); return; }
    // A remote space without a folder: its home, asked once.
    const tree = this.tree;
    this.loadingTree = true;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: c.on }).catch((e) => ({ code: -1, stderr: String(e.message ?? e) }));
      if (this.ctx !== c) return;
      if (r.code === 0 && r.stdout) { tree.root = c.cwd = r.stdout; this.recallRoot(c); this.refreshTree(c, null, cx, true); }
      else { this.loadingTree = false; tree.offline = `Cannot reach ${c.on}: ${(r.stderr || "no home folder").trim()}`; }
      cx.notify();
    });
  }

  stop(ctx) {
    ctx.memory?.timer?.cancel();
    for (const t of ctx.tasks) t.cancel();
    ctx.tasks = [];
    ctx.flush?.cancel();
    ctx.stopped = true;
  }

  alive(ctx) { return () => this.ctx === ctx; }

  /** Follows the focused terminal: called from render, starts at most once per new key. */
  follow(cx) {
    const f = focused();
    if (!f?.terminal) return;        // a mod pane (this one too) or no window: keep the last root
    if (this.pinned) return;
    const l = location();
    if (!l.cwd && !l.on) return;
    const key = ctxKey(l);
    if (key === this.ctxKey || this.closed) return;
    this.ctxKey = key;               // synchronously, so the next render doesn't spawn again
    cx.spawn(async (cx) => {
      if (this.ctxKey !== key || this.closed) return;
      this.retarget(l, key, cx);
      cx.notify();
    });
  }

  /** New context; the shown file stays when it is still under the new root on the same machine. */
  retarget(l, key, cx) {
    this.memFlush();
    const old = this.ctx, file = this.memFile(), abs = file && old ? this.tree.abs(file) : null;
    this.start(l, key, cx);
    if (this.ctx.memory?.saved) return;   // the new root's own memory wins
    if (!abs || (old.on ?? null) !== this.ctx.on || !this.ctx.cwd) return;
    const rel = this.tree.rel(abs);
    if (rel) this.reveal(rel, cx, { keep: true });
  }

  /** Lists the root and expanded folders (only = null), or just `only`. One run at a time per context. */
  refreshTree(ctx, only, cx, user = false) {
    if (this.ctx !== ctx || !this.tree.root) return;
    if (user) this.loadingTree = true;
    if (ctx.busy) {
      ctx.queued = ctx.queued === undefined ? only : ctx.queued === null || only === null ? null : new Set([...ctx.queued, ...only]);
      return;
    }
    ctx.busy = true;
    const tree = this.tree;
    cx.spawn(async (cx) => {
      try { await tree.reload(this.alive(ctx), only); }
      finally { ctx.busy = false; }
      if (this.ctx !== ctx) return;
      this.loadingTree = false;
      const rows = tree.rows();
      if (this.cursor === null || !rows.some((r) => r.path === this.cursor)) this.cursor = rows[0]?.path ?? null;
      if (ctx.memory && !ctx.memory.ready && tree.loaded) this.restoreFile(ctx, cx);
      // Remote: poll even when the first listing failed, so an offline machine recovers by itself.
      if ((tree.loaded || ctx.on) && !ctx.watching) this.watch(ctx, cx);
      this.gitRefresh(ctx, cx);
      this.filesChanged(ctx, cx);
      cx.notify();
      const q = ctx.queued;
      ctx.queued = undefined;
      if (q !== undefined) this.refreshTree(ctx, q, cx);
    });
  }

  reload(cx) {
    this.refreshTree(this.ctx, null, cx, true);
    if (this.ctx?.log) this.loadLog(this.ctx, cx);
    if (this.commit?.change) return this.refreshChange(cx);
    if (this.commit || this.atCommit) return;   // a commit never changes
    if (this.file) this.show(this.file, cx);
  }

  // ---- per-root memory (popup) ------------------------------------------------

  /** Puts the root's saved folders (and the saved file's) in the tree before its first listing. */
  recallRoot(ctx) {
    const m = ctx.memory;
    if (!m) return;
    m.key = rootKey(this.tree.root, ctx.on);
    m.saved = m.restore ? recall(m.key) : null;
    if (!m.saved) { m.ready = true; m.sig = this.memSig(); return; }
    for (const f of m.saved.expanded) this.tree.expanded.add(f);
    for (const f of ancestors(m.saved.file)) this.tree.expanded.add(f);
  }

  /** After the listing that loaded the saved folders (gone ones are dropped): the saved file, if it is still there. */
  restoreFile(ctx, cx) {
    const m = ctx.memory, file = m.saved?.file, tree = this.tree;
    m.ready = true;
    if (file) {
      const up = parent(file), name = up ? file.slice(up.length + 1) : file;
      if ((tree.entries.get(up) ?? []).some((e) => e.name === name && !e.dir)) {
        this.cursor = file;
        const i = tree.rows().findIndex((r) => r.path === file);
        if (i >= 0) this.scroll.scroll_to_item(i, "center");
        this.show(file, cx, { keep: true });
      } else for (const f of ancestors(file)) if (!m.saved.expanded.includes(f) && tree.expanded.has(f)) tree.collapse(f);
    }
    m.sig = this.memSig();
  }

  memSig() { return JSON.stringify(snapshot(this.memFile(), this.tree.expanded)); }

  /** The shown file of the tree (a file shown as of a commit doesn't count). */
  memFile() { return this.atCommit ? this.atCommit.kept : this.file; }

  /** A change worth remembering: stored MEMORY_DELAY ms after the last one. */
  memTouch(cx) {
    const m = this.ctx?.memory;
    if (!m?.ready || !cx || this.closed) return;
    m.timer?.cancel();
    m.timer = cx.timer.after(MEMORY_DELAY, () => { m.timer = null; if (this.ctx?.memory === m) this.memFlush(); });
  }

  /** Stores the current root's file and folders now, when they differ from what is stored. */
  memFlush() {
    const m = this.ctx?.memory;
    if (!m) return;
    if (m.timer) { m.timer.cancel(); m.timer = null; }
    if (!m.ready || !m.key || !this.tree) return;
    const snap = snapshot(this.memFile(), this.tree.expanded), sig = JSON.stringify(snap);
    if (sig === m.sig) return;
    m.sig = sig;
    remember(m.key, snap);
  }

  memForget(key) {
    const m = this.ctx?.memory, k = key ?? m?.key;
    if (!k) return;
    if (m?.timer) { m.timer.cancel(); m.timer = null; }
    // The current root is not written back on close unless something changes afterwards.
    if (m && k === m.key) m.sig = this.memSig();
    this.note = forget(k) ? `Forgot ${k}` : `Nothing stored for ${k}`;
  }

  // ---- live reload -------------------------------------------------

  watch(ctx, cx) {
    ctx.watching = true;
    if (ctx.on) return this.poll(ctx, cx);   // watchFolder is local only
    const root = this.tree.root;
    cx.spawn(async (cx) => {
      try {
        while (this.ctx === ctx) {
          const paths = await watchFolder(root);
          if (this.ctx !== ctx) return;
          this.changed(ctx, paths, cx);
        }
      } catch {
        // Linux rejects trees above 4096 directories: poll like a remote space.
        if (this.ctx === ctx) { ctx.polling = true; this.poll(ctx, cx); cx.notify(); }
      }
    });
  }

  poll(ctx, cx) {
    ctx.tasks.push(cx.timer.every(POLL_FILE, (cx) => this.statFile(ctx, cx)));
    ctx.tasks.push(cx.timer.every(POLL_TREE, (cx) => this.refreshTree(ctx, null, cx)));
  }

  /** Collects a watchFolder batch; flushes 200 ms after the last one (at most 1 s late). */
  changed(ctx, paths, cx) {
    for (const p of paths) {
      const rel = this.tree.rel(p);
      if (!rel) ctx.all = true;      // the root itself (or a path we can't place): refresh everything
      else ctx.dirty.add(rel);
    }
    const now = Date.now();
    ctx.since ??= now;
    if (ctx.flush && !ctx.flush.is_done()) {
      if (now - ctx.since >= MAX_WAIT) return;
      ctx.flush.cancel();
    }
    ctx.flush = cx.timer.after(DEBOUNCE, (cx) => this.flush(ctx, cx));
  }

  flush(ctx, cx) {
    if (this.ctx !== ctx) return;
    const { all, dirty } = ctx, tree = this.tree, file = this.file;
    ctx.all = false; ctx.dirty = new Set(); ctx.since = null;
    let reread = all;
    const folders = new Set();
    if (!all) for (const rel of dirty) {
      const up = parent(rel);
      if (tree.entries.has(up)) folders.add(up);
      if (tree.entries.has(rel)) folders.add(rel);
      if (file && (rel === file || rel === parent(file))) reread = true;   // some watchers report the folder
    }
    if (all || folders.size) this.refreshTree(ctx, all ? null : folders, cx);
    else this.gitRefresh(ctx, cx);   // e.g. only .git moved: a commit or a stage
    if (reread && file) this.show(file, cx, { quiet: true });
  }

  // ---- git decorations ----------------------------------------------------

  /** Status of the root's repo; one run at a time per context, a request meanwhile runs once after. */
  gitRefresh(ctx, cx) {
    if (this.ctx !== ctx || !this.tree.root || this.closed) return;
    if (ctx.gitBusy) { ctx.gitAgain = true; return; }
    ctx.gitBusy = true;
    const root = this.tree.root;
    cx.spawn(async (cx) => {
      let s;
      try { s = await git.status(root, ctx.on); }
      finally { ctx.gitBusy = false; }
      if (this.ctx !== ctx) return;
      const changed = s !== undefined && !git.same(this.git, s);
      if (changed || this.gitPending) {
        const file = this.file, before = file ? this.git?.files.get(file) : undefined;
        const side = this.sideNow(), had = this.sideFocused();
        if (s !== undefined) this.git = s;
        this.gitPending = false;   // the first answer settles the tabs, even "unreachable"
        // In or out of a repo: the Commits tab comes or goes, and the keyboard follows the sidebar.
        if (side !== this.sideNow() && had) this.sideFocus().focus();
        if (changed && file && s?.files.get(file) !== before) this.refreshMarks(cx);
        cx.notify();
      }
      if (s !== undefined && this.commit?.change) this.refreshChange(cx);
      if (this.sideNow() === "commits" && ctx.log) this.logCheck(ctx, cx);
      if (ctx.gitAgain) { ctx.gitAgain = false; this.gitRefresh(ctx, cx); }
    });
  }

  /**
   * Changed lines of the shown code file: none when clean or outside a repo, all for an untracked
   * one. Markdown gets none: its blocks are too coarse to place them well.
   */
  refreshMarks(cx) {
    const file = this.file, doc = this.doc, ctx = this.ctx;
    const letter = file && this.git ? this.git.files.get(file) : undefined;
    if (!doc || doc.kind !== "text" || !letter) return this.setMarks(null);
    if (letter === "U") return this.setMarks(git.added(doc.text));
    if (this.marking) { this.markAgain = true; return; }
    this.marking = true;
    const root = this.tree.root;
    cx.spawn(async (cx) => {
      let m;
      try { m = await git.changes(root, file, doc.text, ctx.on); }
      finally { this.marking = false; }
      if (this.ctx === ctx && this.file === file && this.doc === doc && m !== undefined) { this.setMarks(m); cx.notify(); }
      if (this.markAgain) { this.markAgain = false; this.refreshMarks(cx); }
    });
  }

  setMarks(m) {
    this.marks = m;
    this.decorate();
  }

  /** Puts the marks on the code view: runs of changed lines and deletions. */
  decorate() {
    const m = this.marks;
    this.codeMarks = m && this.doc?.kind === "text" ? { runs: git.runs(m), dels: [...m.dels].sort((a, b) => a - b) } : null;
  }

  /** Remote (or polled) file: re-read only when its mtime or size moves. */
  async statFile(ctx, cx) {
    const rel = this.file;
    if (this.ctx !== ctx || !rel || ctx.statting || this.atCommit) return;
    ctx.statting = true;
    let s;
    try { s = await stamp(this.tree.abs(rel), ctx.on); }
    catch { s = null; }              // unreachable: try again on the next tick
    finally { ctx.statting = false; }
    if (this.ctx !== ctx || this.file !== rel || s === null) return;
    const before = this.stamp;
    this.stamp = s;
    if (before === null ? s === "missing" && this.doc && this.doc.kind !== "missing" : s !== before) this.show(rel, cx, { quiet: true });
  }

  expand(rel, cx) {
    const tree = this.tree, ctx = this.ctx;
    tree.expanded.add(rel);
    if (!tree.entries.has(rel) && !tree.pending.has(rel))
      cx.spawn(async (cx) => {
        try { await tree.load(rel, this.alive(ctx)); }
        catch (e) { if (this.ctx === ctx) { tree.expanded.delete(rel); if (e.unreachable) tree.offline = e.message; else this.note = String(e.message ?? e); } }
        cx.notify();
      });
    this.memTouch(cx);
    cx.notify();
  }

  toggle(rel, cx) {
    if (this.tree.expanded.has(rel)) { this.tree.collapse(rel); this.memTouch(cx); cx.notify(); }
    else this.expand(rel, cx);
  }

  /** Opens a file by path (relative to the root, or absolute inside it), expanding its folders. */
  reveal(path, cx, opts = {}) {
    const root = this.tree.root;
    // Normalized, so "a/../b" never expands (or remembers) a folder named "a/..".
    const rel = path.startsWith("/") ? this.tree.rel(normalize(path)) : normalize(path).slice(1);
    if (!rel) { this.note = `Outside ${tilde(root)}: ${path}`; cx.notify(); return; }
    const ctx = this.ctx, tree = this.tree;
    cx.spawn(async (cx) => {
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        tree.expanded.add(folder);
        if (!tree.entries.has(folder)) await tree.load(folder, this.alive(ctx)).catch(() => {});
        if (this.ctx !== ctx) return;
      }
      this.cursor = rel;
      const i = tree.rows().findIndex((r) => r.path === rel);
      if (i >= 0) this.scroll.scroll_to_item(i, "center");
      if (!opts.treeOnly) this.show(rel, cx, opts);
      if (!opts.treeOnly && !opts.keep) this.toView();
      this.memTouch(cx);
      cx.notify();
    });
  }

  // ---- file loading ----------------------------------------------------------

  release() {
    for (const b of this.blocks) b.state?.release();
    this.blocks = [];
    this.code?.release();
    this.code = null;
  }

  /**
   * Shows a file. quiet: a live reload (no spinner; nothing is rebuilt when the content is the
   * same). keep: after a context change, clear the preview if the file isn't there.
   */
  show(rel, cx, { quiet = false, keep = false, read = null } = {}) {
    // A file picked by the user leaves the commit view; read() loads a file as of a commit.
    if (!quiet && !read) { this.closeCommitView(); this.atCommit = null; }
    const seq = ++this.seq;
    const moved = rel !== this.file;
    if (moved) { this.release(); this.doc = null; this.stamp = null; this.loadedAt = null; this.marks = null; this.codeMarks = null; if (this.ds) this.closeDocFind(false); }
    this.file = rel;
    if (moved) this.memTouch(cx);
    if (!quiet) { this.note = null; this.loadingFile = Boolean(rel); }
    if (!rel || !cx) { this.loadingFile = false; return; }
    const ctx = this.ctx, abs = this.tree.abs(rel);
    cx.spawn(async (cx) => {
      let doc;
      try { doc = read ? await read() : await readSource(abs, ctx.on); }
      catch (e) { doc = { kind: "error", message: String(e.message ?? e) }; }
      if (this.seq !== seq || this.ctx !== ctx) return;
      this.loadingFile = false;
      if (keep && doc.kind === "missing") { this.show(null); cx.notify(); return; }
      if (doc.kind === "text") doc.lines = rowCount(doc.text);
      const prev = this.doc;
      if (prev && prev.kind === doc.kind && prev.text === doc.text && prev.message === doc.message && prev.truncated === doc.truncated) { cx.notify(); return; }
      if (doc.kind === "markdown") {
        doc.segments = segment(doc.text);
        // Cached PNGs become known before the first paint: no placeholder, no layout jump.
        const theme = themeOf(this.dark);
        await this.mermaid.prepare(doc.segments.filter((s) => s.kind !== "md" && s.info.toLowerCase() === "mermaid").map((s) => cacheKey(s.text, theme)));
        if (this.seq !== seq || this.ctx !== ctx) return;
      }
      this.doc = doc;
      this.loadedAt = Date.now();
      if (!this.patch(prev, cx)) this.build(cx);
      this.decorate();
      this.runDoc();
      this.refreshMarks(cx);
      cx.notify();
    });
  }

  /** What build() makes of this.doc's segments, without EditorStates. */
  plan(segments) {
    const out = [], seen = new Map();
    let editors = 0;
    for (const s of segments) {
      if (s.kind === "md") { out.push(s); continue; }
      const mermaid = s.info.toLowerCase() === "mermaid", start = s.start, end = s.end;
      if (editors >= MAX_EDITORS) { out.push({ kind: "md", text: "```" + s.info + "\n" + s.text + "\n```", start, end }); continue; }
      editors++;
      const lines = Math.max(1, s.text.split("\n").length);
      // A wrapped fence's height follows the column width (rows()).
      if (!mermaid) { out.push({ kind: "code", info: s.info, text: s.text, lines, start, end, wrap: lang.wraps(lang.forFence(s.info)) }); continue; }
      // Diagrams are compared by source: unchanged ones keep their render across a reload.
      const hash = fnv1a(s.text), n = (seen.get(hash) ?? 0) + 1;
      seen.set(hash, n);
      out.push({ kind: "mmd", info: s.info, text: s.text, lines, start, end, hash, id: n === 1 ? `mmd-${hash}` : `mmd-${hash}-${n}` });
    }
    return out;
  }

  /**
   * Live reload in place: same block layout → swap texts and set_value the EditorStates, so the
   * element ids (doc:<rel>, md-<i>, code-<i>) and the Editors survive. False → build() instead.
   */
  patch(prev, cx) {
    const doc = this.doc;
    if (!prev || prev.kind !== doc.kind) return false;
    if (doc.kind === "text") { if (!this.code) return false; this.code.set_value(doc.text); return true; }
    if (doc.kind !== "markdown") return false;
    const next = this.plan(doc.segments);
    if (next.length !== this.blocks.length || next.some((b, i) => b.kind !== this.blocks[i].kind || (b.kind === "code" && b.info !== this.blocks[i].info))) return false;
    next.forEach((b, i) => {
      const old = this.blocks[i];
      if (b.kind === "md") { this.blocks[i] = b; return; }
      if (b.kind === "mmd") {
        if (old.hash === b.hash) { old.id = b.id; old.start = b.start; old.end = b.end; return; }   // same diagram: keep its render
        old.state?.release();
        this.blocks[i] = b;
        return;
      }
      if (old.text !== b.text) old.state.set_value(b.text);
      old.text = b.text; old.lines = b.lines; old.vis = null; old.start = b.start; old.end = b.end;
    });
    this.diagrams(cx);
    return true;
  }

  /** (Re)creates the EditorStates for this.doc. Never called from render itself. */
  build(cx) {
    this.release();
    const doc = this.doc;
    if (!doc) return;
    const base = { readonly: true, font_family: settings().font_family, font_size: this.codeFont, syntax: syntax() };
    if (doc.kind === "text") {
      const language = lang.forPath(this.file);
      this.code = EditorState.new({ ...base, ...(language ? { language } : {}), soft_wrap: lang.wraps(language), value: doc.text });
      return;
    }
    if (doc.kind !== "markdown") return;
    for (const b of this.plan(doc.segments)) {
      if (b.kind === "md" || b.kind === "mmd") { this.blocks.push(b); continue; }
      this.blocks.push({ ...b, state: this.fenceState(b.text, lang.forFence(b.info)) });
    }
    this.diagrams(cx);
  }

  fenceState(value, language) {
    return EditorState.new({ readonly: true, font_family: settings().font_family, font_size: this.codeFont, syntax: syntax(),
      ...(language ? { language } : {}), value, line_numbers: false, folding: false, soft_wrap: lang.wraps(language) });
  }

  /** Steps the reading zoom ("in" | "out" | "reset") and keeps it for this mode's next copies. */
  textAct(a, cx) {
    const i = LEVELS.indexOf(this.textZoom);
    const z = a === "reset" ? 1 : LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i + (a === "in" ? 1 : -1)))];
    if (z === this.textZoom) return;
    if (this.mode === "side") keepTabZoom(this.zoomTab, z);
    else setShared(ZOOM_KEY + this.mode, z === 1 ? null : z);
    this.setZoom(z);
    cx.notify();
  }

  /** The reading zoom at level z (not from render: the Editors are made again at the new font). */
  setZoom(z) {
    this.textZoom = z;
    const font = Math.round(FONT * z);
    if (font !== this.codeFont) { this.codeFont = font; this.refont(); }
  }

  /** Side panel, from render: another tab shows (here or in another space), so its own level. */
  followZoom(cx) {
    if (this.mode !== "side") return;
    const tab = activeTab();
    if (!tab || tab === this.zoomTab) return;
    this.zoomTab = tab;
    const z = tabZoom(tab);
    if (z !== this.textZoom) cx.spawn(async (cx) => { if (this.zoomTab === tab && !this.closed) { this.setZoom(z); cx.notify(); } });
  }

  /** EditorStates take their font size only at creation: new ones in place, blocks and diagrams kept. */
  refont() {
    for (const f of this.commit?.data?.files ?? []) if (f.state) { f.state.release(); f.state = this.diffState(f); }
    if (this.code) {
      const language = lang.forPath(this.file);
      this.code.release();
      this.code = EditorState.new({ readonly: true, font_family: settings().font_family, font_size: this.codeFont, syntax: syntax(),
        ...(language ? { language } : {}), soft_wrap: lang.wraps(language), value: this.doc?.text ?? "" });
    }
    for (const b of this.blocks) {
      if (!b.state) continue;
      b.state.release();
      b.state = this.fenceState(b.text, b.kind === "mmd" ? null : lang.forFence(b.info));
      b.vis = null;
    }
  }

  /** Prose size of the reading zoom. */
  proseSize() { return Math.round(PROSE * this.textZoom); }

  /** Visual rows of a fence; a soft-wrapped one depends on the measured column width. */
  rows(b) {
    if (!b.wrap || !this.colW) return b.lines;
    const cols = Math.max(1, Math.floor((this.colW - WRAP_PAD) / charWidth(this.codeFont)));
    if (b.vis?.cols !== cols) b.vis = { cols, n: lang.wrappedRows(b.text, cols) };   // per width, not per frame
    return b.vis.n;
  }

  // ---- Mermaid ---------------------------------------------------------

  /** Asks for every diagram block without a result: cached PNGs answer at once, the rest queue. */
  diagrams(cx) {
    if (!cx || this.closed) return;
    const theme = themeOf(this.dark);
    for (const b of this.blocks) {
      if (b.kind !== "mmd" || b.d) continue;
      const key = cacheKey(b.text, theme), ctx = this.ctx, file = this.file;
      b.key = key;
      b.d = { pending: true };
      const alive = () => !this.closed && this.ctx === ctx && this.file === file && b.key === key && this.blocks.includes(b);
      this.mermaid.request({ key, source: b.text, theme }, {
        alive,
        done: (res, cx) => {
          if (!alive()) return;
          b.d = res;
          // Fallback: the source as a plain code block (EditorState made here, never in render).
          if (res.error && !b.state) b.state = this.fenceState(b.text, null);
          cx.notify();
        },
      }, cx);
    }
  }

  /** A notice's Retry: a setup error retries the lookup and every setup notice; a render error, this diagram. */
  retryDiagram(b, cx) {
    if (b.d?.setup) {
      this.mermaid.retrySetup();
      for (const o of this.blocks) if (o.kind === "mmd" && o.d?.setup) o.d = null;
    } else if (b.d?.error) {
      for (const o of this.blocks) if (o.kind === "mmd" && o.key === b.key) o.d = null;   // twins share the render
      this.mermaid.forget(b.key);
    }
    this.diagrams(cx);
    cx.notify();
  }

  /** Displayed size of a w × h PNG (rendered at -s 2): the same formula for the image and its placeholder. */
  diagramSize(w, h) {
    const z = this.textZoom, dw = Math.max(1, Math.min(this.colW ?? 812, (w / 2) * z, MAX_DIAGRAM_W * z));
    return { w: dw, h: (dw * h) / w };
  }

  /** Diagram n (document order, from 0) expanded: a layer in the popup, a dialog over the window from the panel. */
  expandDiagram(n, cx) {
    const list = this.blocks.filter((b) => b.kind === "mmd"), b = list[n];
    if (!b?.d?.ok) { this.note = b ? `Diagram ${n + 1} is not rendered` : `No diagram ${n + 1}`; cx.notify(); return; }
    const d = { key: b.key, source: b.text, theme: themeOf(this.dark), path: b.d.path, w: b.d.w, h: b.d.h };
    const label = `${this.file} · diagram ${n + 1} of ${list.length}`;
    // A window overlay would draw under this popup's dialog, so the popup draws its own layer.
    if (!this.overlay) openOverlay({ kind: "dialog", width: 0.95, height: 0.95, mod: "file-preview", props: { mode: "diagram", diagram: d, label } });
    else { this.zoom = new Zoom(d, this.mermaid, label); this.zoomFocus.focus(); }
    cx.notify();
  }

  /** "in" | "out" | "fit" | "close" on the expanded diagram. */
  zoomAct(a, cx) {
    if (!this.zoom) return;
    if (a !== "close") return this.zoom.act(a, cx);
    if (this.mode === "diagram") { if (this.overlay) closeOverlay(this.overlay); return; }
    this.zoom.closed = true;
    this.zoom = null;
    this.previewFocus.focus();
  }

  zoomKeyDown(e, cx) {
    const a = zoomKey(e);
    if (!a) return;
    cx.stop_propagation();
    this.zoomAct(a, cx);
    cx.notify();
  }

  // ---- search ----------------------------------------------------------------

  /** The tree's file search: a field over the tree; a non-empty query lists matching paths. */
  openTreeFind(cx) {
    if (!this.tree.root) return;
    this.focusTree(true);
    if (!this.ts) {
      const input = InputState.new({ placeholder: "Find a file…" });
      const ts = this.ts = { input, query: "", results: [], total: 0, at: 0, pool: null, poolQ: null, poolData: null, opened: null };
      input.on("change", (_e, cx) => { if (this.ts === ts && input.value() !== ts.query) this.treeQuery(input.value(), cx); });
      input.on("submit", (_e, cx) => { if (this.ts === ts) { this.treePick(cx); cx.notify(); } });
    }
    this.ts.input.focus();
    this.loadFiles(this.ctx, cx);
    cx?.notify();
  }

  /** Esc or ✕: back to the tree, on the file opened from the results. */
  closeTreeFind(cx, reveal = true) {
    const ts = this.ts;
    if (!ts) return;
    this.ts = null;
    ts.input.release();
    if (!cx) return;
    this.treeFocus.focus();
    if (reveal && ts.opened && ts.opened === this.file) this.reveal(ts.opened, cx, { treeOnly: true });
    cx.notify();
  }

  /** Lists the root's files once per context (again when stale); one run at a time. */
  loadFiles(ctx, cx) {
    if (!ctx || this.ctx !== ctx || !this.tree.root || !cx) return;
    const f = ctx.files ??= { data: null, loading: false, stale: true, error: null, at: 0 };
    if (f.loading || !f.stale) return;
    f.loading = true; f.stale = false; f.at = Date.now();
    const root = this.tree.root;
    cx.spawn(async (cx) => {
      try { f.data = await listFiles(root, ctx.on); f.error = null; }
      catch (e) { f.error = String(e.message ?? e); }
      finally { f.loading = false; }
      if (this.ctx !== ctx) return;
      if (this.ts) {
        if (f.stale) this.loadFiles(ctx, cx);   // changed meanwhile
        this.treeQuery(this.ts.query, cx, true);
      }
      cx.notify();
    });
  }

  /** The tree changed: the next search re-lists; an open one now, at most every FILES_EVERY ms. */
  filesChanged(ctx, cx) {
    const f = ctx.files;
    if (!f) return;
    f.stale = true;
    if (this.ts && !f.loading && Date.now() - f.at >= FILES_EVERY) this.loadFiles(ctx, cx);
  }

  treeQuery(q, cx, fresh = false) {
    const ts = this.ts;
    if (!ts) return;
    const keep = ts.results[ts.at]?.path;
    ts.query = q;
    const f = this.ctx?.files, data = f?.data, norm = q.toLowerCase().replace(/\s+/g, "");
    if (f?.stale && Date.now() - f.at >= FILES_EVERY) this.loadFiles(this.ctx, cx);
    if (!data || !norm) { ts.results = []; ts.total = 0; ts.pool = null; ts.poolQ = null; ts.at = 0; cx.notify(); return; }
    // A longer query only narrows the last one's matches.
    const pool = !fresh && ts.pool && ts.poolData === data && ts.poolQ && norm.startsWith(ts.poolQ) ? ts.pool : null;
    const r = rank(data, q, pool);
    ts.results = r.results; ts.total = r.total; ts.pool = r.pool; ts.poolQ = norm; ts.poolData = data;
    // A re-list keeps the selected row; typing starts at the top.
    const i = fresh && keep ? ts.results.findIndex((x) => x.path === keep) : -1;
    ts.at = Math.max(0, i);
    this.findScroll.scroll_to_item(ts.at);
    cx.notify();
  }

  treeMove(d) {
    const ts = this.ts;
    if (!ts?.results.length) return;
    ts.at = Math.max(0, Math.min(ts.results.length - 1, ts.at + d));
    this.findScroll.scroll_to_item(ts.at);
  }

  /** Enter on a result: opens it; the field keeps the keyboard. */
  treePick(cx) {
    const r = this.ts?.results[this.ts.at];
    if (!r) return;
    this.ts.opened = r.path;
    this.cursor = r.path;
    this.show(r.path, cx);
    this.toView();
  }

  findClick(path, cx) {
    const ts = this.ts;
    if (!ts) return;
    const i = ts.results.findIndex((r) => r.path === path);
    if (i < 0) return;
    ts.at = i;
    this.treePick(cx);
    ts.input.focus();
    cx.notify();
  }

  /**
   * Search in the shown document. Markdown: each match in prose gets a <mark> (the current one
   * stronger), blocks with matches a bar, the current block a frame; ↑ ↓ go match by match.
   * Code files: lines are tinted, ↑ ↓ go line by line. It can't scroll to them.
   */
  openDocFind(cx) {
    const doc = this.doc;
    if (!this.file || !doc || (doc.kind !== "markdown" && doc.kind !== "text") || this.commitShown()) { this.note = "Nothing to search"; cx?.notify(); return; }
    if (!this.ds) {
      const input = InputState.new({ placeholder: "Find in document…" });
      const ds = this.ds = { input, query: "", hits: [], total: 0, blocks: 0, at: 0, heads: [] };
      input.on("change", (_e, cx) => { if (this.ds === ds && input.value() !== ds.query) this.docQuery(input.value(), cx); });
      input.on("submit", (e, cx) => { if (this.ds === ds) { this.docStep(e?.shift ? -1 : 1); cx.notify(); } });
    }
    this.ds.input.focus();
    cx?.notify();
  }

  closeDocFind(focus = true) {
    const ds = this.ds;
    if (!ds) return;
    this.ds = null;
    for (const b of this.blocks) b.find = null;   // also drops the marked text
    ds.input.release();
    if (focus) this.previewFocus.focus();
  }

  docQuery(q, cx) {
    const ds = this.ds;
    if (!ds) return;
    ds.query = q;
    ds.at = 0;
    this.runDoc();
    cx.notify();
  }

  /**
   * Matches of the query in the document's source (case-insensitive): per line in a code file,
   * one hit per match in Markdown (b.find.at: their offsets in b.text). Run again after every
   * load, so a live reload keeps the search; a new b.find also drops the cached marked text.
   */
  runDoc() {
    for (const b of this.blocks) b.find = null;
    const ds = this.ds, doc = this.doc;
    if (!ds) return;
    ds.hits = []; ds.total = 0; ds.blocks = 0;
    const q = ds.query.toLowerCase();
    if (!q || !doc) return;
    if (doc.kind === "text") {
      const o = occurrences(doc.text, q);
      ds.hits = o.lines.map((l) => ({ line: l.line + 1, n: l.n }));
      ds.total = o.total;
    } else if (doc.kind === "markdown") {
      ds.heads = headings(this.blocks);
      for (const b of this.blocks) {
        const at = positions(b.text, q);
        if (!at.length) continue;
        // A fence's text starts under its opening line; a prose chunk at its first line.
        const first = b.kind === "md" ? b.start : b.start + 1;
        b.find = { n: at.length, rows: [...new Set(at.map((p) => p.line))], at, k: -1, current: false, md: null, mdKey: null };
        at.forEach((p, k) => ds.hits.push({ block: b, line: first + p.line, k }));
        ds.total += at.length;
        ds.blocks++;
      }
    }
    ds.at = Math.max(0, Math.min(ds.hits.length - 1, ds.at));
    this.docCurrent(true);
  }

  /** Flags (on) or clears the current hit on its block: b.find.k is its index there. */
  docCurrent(on) {
    const h = this.ds?.hits[this.ds.at], f = h?.block?.find;
    if (!f) return;
    f.current = on;
    f.k = on ? h.k : -1;
  }

  /** Next (1) or previous (-1) match (a line in a code file), wrapping around. */
  docStep(d) {
    const ds = this.ds, n = ds?.hits.length;
    if (!n) return;
    this.docCurrent(false);
    ds.at = (ds.at + d + n) % n;
    this.docCurrent(true);
  }

  /**
   * A prose block's Markdown with its matches in <mark> (b.text itself stays as loaded, for
   * search, copy and reload). Cached on b.find, rebuilt when the current match or theme changes.
   */
  markedText(b, t) {
    const f = b.find;
    if (!f || !this.ds) return b.text;
    const soft = blend(t.accent, t.surface, 0.28) ?? "#fef08a", strong = blend(t.accent, t.surface, 0.6) ?? "#fbbf24";
    const key = `${f.k}|${soft}|${strong}`;
    if (f.mdKey !== key) {
      f.md = markMatches(b.text, f.at, this.ds.query.toLowerCase().length, (k) => (k === f.k ? strong : soft), f.mask ??= syntaxMask(b.text)).text;
      f.mdKey = key;
    }
    return f.md;
  }

  /** "match 3 of 12 · line 120 · Heading" (code: "line 2 of 5 · line 120"): where the current match is, since the view can't go there. */
  docWhere() {
    const ds = this.ds, h = ds?.hits[ds.at];
    if (!h) return null;
    const what = this.doc?.kind === "text" ? "line" : "match";
    const sec = what === "match" ? section(ds.heads, h.line) : null;
    return `${what} ${ds.at + 1} of ${ds.hits.length} · line ${h.line}` + (sec ? ` · ${sec.text}` : "");
  }

  /** "tree" | "doc" for a command without a side: the open search, else the pane with the keyboard. */
  findSide() {
    if (this.previewFocus.is_focused()) return "doc";
    if (this.treeFocus.is_focused()) return "tree";
    return this.ds && !this.ts ? "doc" : "tree";
  }

  /** Dev hook: opens a search with a query, as if typed. */
  findCmd(side, q, cx) {
    if (side === "tree") {
      this.openTreeFind(cx);
      if (!this.ts) return;
      this.ts.input.set_value(q);
      this.treeQuery(q, cx);
    } else {
      this.openDocFind(cx);
      if (!this.ds) return;
      this.ds.input.set_value(q);
      this.docQuery(q, cx);
    }
  }

  /** Keys typed into a search field: arrows act here, the rest stays in the field. */
  findKey(e, cx, side) {
    const m = e.modifiers;
    if (!m.platform && !m.control && !m.alt) {
      if (side === "tree") {
        const d = { down: 1, up: -1, pagedown: 10, pageup: -10 }[e.key];
        if (d) { cx.stop_propagation(); this.treeMove(d); cx.notify(); return; }
      } else if (e.key === "down" || e.key === "up") {
        cx.stop_propagation(); this.docStep(e.key === "down" ? 1 : -1); cx.notify(); return;
      }
    }
    this.inInput = true;   // the pane's on_key_down, next on the way up, leaves it alone
  }

  // ---- keyboard --------------------------------------------------------------

  command(c, cx) {
    if (c === "focus") return this.focusTree();
    if (c === "anchor") return this.anchor();
    if (c === "popout") { if (this.mode === "side") this.popOut(); return; }
    // Sent when the side panel opens: it takes the keyboard from the terminal.
    if (c === "focus-side") { if (this.mode === "side") (this.viewShown() ? this.previewFocus : this.sideFocus()).focus(); return; }
    if (c === "back") { if (this.viewShown()) this.toList(); return; }
    // Key names as commands (`file-preview.down`), so the tree can be driven without a keyboard.
    if (c === "reload") return this.reload(cx);
    if (c.startsWith("open:")) return this.reveal(c.slice(5), cx);
    // Same as each diagram notice's Retry.
    if (c === "retry-diagrams") { const b = this.blocks.find((b) => b.d?.setup) ?? this.blocks.find((b) => b.d?.error); if (b) this.retryDiagram(b, cx); return; }
    // Expanded diagram: expand:<n>, then zoom-in, zoom-out, zoom-fit, zoom-close (the + − 0 Esc keys).
    if (c.startsWith("expand:")) { const n = Number(c.slice(7)); if (Number.isInteger(n) && n >= 0) this.expandDiagram(n, cx); return; }
    if (c.startsWith("zoom-")) return this.zoomAct(c.slice(5), cx);
    // Reading zoom: text-in, text-out, text-reset (the + − 0 keys outside an expanded diagram).
    if (c === "text-in" || c === "text-out" || c === "text-reset") return this.textAct(c.slice(5), cx);
    // copy:<n>: code box n (document order, from 0), like its Copy button.
    if (c.startsWith("copy:")) {
      const n = Number(c.slice(5)), b = Number.isInteger(n) ? this.codeBoxes()[n] : null;
      if (b) this.copyBlock(b, cx); else { this.note = `No code block ${c.slice(5)}`; cx.notify(); }
      return;
    }
    // Forgets the stored tree choice of this mode (back to the defaults).
    if (c === "tree-reset") { this.treePref = null; setShared(TREE_KEY + this.mode, null); return; }
    // memory-forget[:<key>]: drops the popup's memory of this root (or of the root key given).
    if (c === "memory-forget" || c.startsWith("memory-forget:")) { this.memForget(c.slice(14) || null); return; }
    // Search: tree-find:<q>, doc-find:<q>, find:<q> (the pane with the keyboard), find-next,
    // find-prev, find-enter (open the selected result), find-close, find-esc (the Esc action).
    if (c.startsWith("tree-find:")) return this.findCmd("tree", c.slice(10), cx);
    if (c.startsWith("doc-find:")) return this.findCmd("doc", c.slice(9), cx);
    if (c.startsWith("find:")) return this.findCmd(this.findSide(), c.slice(5), cx);
    if (c === "find-next" || c === "find-prev") { const d = c === "find-next" ? 1 : -1; if (this.ds) this.docStep(d); else this.treeMove(d); return; }
    if (c === "find-enter") { if (this.ts) this.treePick(cx); else this.docStep(1); return; }
    if (c === "find-close") { if (this.ds && this.findSide() === "doc") this.closeDocFind(); else if (this.ts) this.closeTreeFind(cx); else this.closeDocFind(); return; }
    // Commits: tab:files, tab:commits, commits-scope (all refs / current branch), commits-remotes, commits-more,
    // commit:<row index | hash prefix>, commit-file:<n>, commit-back, commit-close, copy-hash.
    if (c === "tab:files" || c === "tab:commits" || c === "tab:changes") return this.setSide(c.slice(4), cx);
    // Changes: change:<row index | path>, opens that change's diff.
    if (c.startsWith("change:")) return this.changeCmd(c.slice(7), cx);
    if (c === "commits-scope") return this.toggleScope(cx);
    if (c === "commits-remotes") return this.toggleRemotes(cx);
    if (c === "commits-more") return this.loadLog(this.ctx, cx, { more: true });
    if (c.startsWith("commit:")) return this.commitCmd(c.slice(7), cx);
    if (c.startsWith("commit-file:")) return this.openAt(Number(c.slice(12)), cx);
    if (c === "commit-back") return this.commitBack(cx);
    if (c === "commit-close") { this.closeCommitView(); return; }
    if (c === "copy-hash") { const d = this.commit?.data; if (d) this.copyBlock(d, cx, d.hash); return; }
    if (c === "find-esc") {
      // Down the focus path, like the bound Esc: only a focused search field answers it.
      try { globalThis.window.dispatch_action(FIND_ESCAPE); } catch (e) { this.note = `find-esc: ${String(e.message ?? e)}`; }
      return;
    }
    if (this.sideNow() === "commits" && this.commitKey(c, cx)) return;
    if (this.sideNow() === "changes" && this.changeKey(c, cx)) return;
    this.treeKey(c, cx);
  }

  rowsNow() { return this.tree.rows(); }

  moveTo(rows, i) {
    if (!rows.length) return;
    i = Math.max(0, Math.min(rows.length - 1, i));
    this.cursor = rows[i].path;
    this.scroll.scroll_to_item(i);
  }

  /** Returns true when the key was used. */
  treeKey(k, cx) {
    const rows = this.rowsNow(), i = rows.findIndex((r) => r.path === this.cursor), row = rows[i];
    if (k === "down") this.moveTo(rows, i + 1);
    else if (k === "up") this.moveTo(rows, i < 0 ? 0 : i - 1);
    else if (k === "pagedown") this.moveTo(rows, i + 20);
    else if (k === "pageup") this.moveTo(rows, i - 20);
    else if (k === "home") this.moveTo(rows, 0);
    else if (k === "end") this.moveTo(rows, rows.length - 1);
    else if (k === "right") {
      if (!row?.dir || row.denied) return false;
      if (!this.tree.expanded.has(row.path)) this.expand(row.path, cx);
      else if (rows[i + 1]?.depth > row.depth) this.moveTo(rows, i + 1);
    } else if (k === "left") {
      if (!row) return false;
      if (row.dir && this.tree.expanded.has(row.path)) { this.tree.collapse(row.path); this.memTouch(cx); }
      else if (row.depth > 0) this.moveTo(rows, rows.findIndex((r) => r.path === parent(row.path)));
    } else if (k === "enter" || k === "space") {
      if (!row || row.denied) return false;
      if (row.dir) this.toggle(row.path, cx); else { this.show(row.path, cx); this.toView(); }
    } else if (k === "tab") { if (this.stacked()) this.toView(); else this.previewFocus.focus(); }
    else if (k === "r") this.reload(cx);
    else if (k === "b") this.toggleTree();
    else if (k === "g" && this.gitTabs()) this.setSide("commits", cx);
    else return false;
    cx.notify();
    return true;
  }

  onKey(e, cx, where) {
    if (this.inInput) { this.inInput = false; return; }   // typed into a search field
    const m = e.modifiers;
    if (m.platform && !m.control && !m.alt && e.key === "f") { cx.stop_propagation(); this.openFind(where, cx); return; }
    if (m.platform || m.control || m.alt) return;
    if (e.key === "escape") {
      if (this.overlay) closeOverlay(this.overlay);
      else if (where === "preview" && this.viewShown()) { cx.stop_propagation(); this.toList(); cx.notify(); }
      return;
    }
    if (e.key === "/" || e.key_char === "/") { cx.stop_propagation(); this.openFind(where, cx); return; }
    // n / shift-n: next and previous match (line, in a code file) while the document has the keyboard.
    if (where === "preview" && this.ds && (e.key === "n" || e.key === "N")) {
      cx.stop_propagation(); this.docStep(m.shift || e.key === "N" ? -1 : 1); cx.notify(); return;
    }
    const a = textKey(e);
    if (a) { cx.stop_propagation(); this.textAct(a, cx); return; }
    let used;
    if (where === "tree") used = this.treeKey(e.key, cx);
    else if (where === "commits") used = this.commitKey(e.key, cx);
    else if (where === "changes") used = this.changeKey(e.key, cx);
    else if (e.key === "tab") { if (this.stacked()) this.toList(); else this.focusTree(true); used = true; }
    else if (e.key === "backspace" && this.atCommit) { this.commitBack(cx); used = true; }
    else if (e.key === "r") { this.reload(cx); used = true; }
    else if (e.key === "b") { this.toggleTree(); used = true; }
    if (used) { cx.stop_propagation(); cx.notify(); }
  }

  openFind(where, cx) {
    if (where === "commits" || where === "changes") return;
    if (where === "tree") this.openTreeFind(cx); else this.openDocFind(cx);
  }

  // ---- panel ----------------------------------------------------------

  narrow() { return this.width !== null && this.width < NARROW; }

  /**
   * Stacked: the side panel (and an old docked pane) shows one page at a time, the sidebar's
   * list or what it opened, each at full width; the popup keeps both side by side.
   */
  stacked() { return this.mode !== "popup"; }
  /** Stacked and on what the list opened (while there is something to show). */
  viewShown() { return this.stacked() && this.page === "view" && Boolean(this.file || this.commit); }

  toView() {
    if (!this.stacked()) return;
    this.page = "view";
    this.previewFocus.focus();
  }

  toList() {
    this.page = "list";
    this.sideFocus().focus();
  }
  /** The stored choice of this mode, else: shown when wide; when narrow, as the panel started. */
  treeShown() { return this.treePref ?? (!this.narrow() || this.treeOpen); }

  /** Tree focus; with the tree hidden, the preview (open: show it first). */
  focusTree(open = false) {
    if (!this.treeShown() && open) this.setTree(true);
    (this.treeShown() ? this.sideFocus() : this.previewFocus).focus();
  }

  toggleTree() {
    this.setTree(!this.treeShown());
    (this.treeShown() ? this.sideFocus() : this.previewFocus).focus();
  }

  /** An explicit hide/show: kept for the next popup or panel (per mode), at any width. */
  setTree(open) {
    this.treePref = this.treeOpen = open;
    setShared(TREE_KEY + this.mode, open);
  }

  sized(box, cx) {
    const w = Math.round(box.width);
    if (w === this.width) return;
    const was = this.treeShown();
    this.width = w;
    if (!this.stacked() && was && !this.treeShown() && this.sideFocused()) this.previewFocus.focus();   // its element goes
    cx.notify();
  }

  /** Popup ⇥: the side panel (as the launcher opens it), showing this file; then the popup goes. */
  anchor() {
    if (!this.overlay || !sideAvailable()) return;
    const file = this.memFile();
    closeOverlay(this.overlay);
    showSide();
    if (file) run(`file-preview.open:${this.tree.abs(file)}`);
  }

  /** Side panel ⤢: the popup in its place, on this file; closing it brings the side panel back. */
  popOut() {
    const file = this.memFile();
    hideSide();
    openOverlay({ kind: "dialog", width: 0.95, height: 0.95, mod: "file-preview",
      props: { mode: "popup", from: "side", ...(file ? { file: this.tree.abs(file) } : {}) } });
  }

  /** ✕: the popup closes its overlay; the side panel hides; an old docked pane closes. */
  closeView() {
    if (this.overlay) return closeOverlay(this.overlay);
    if (this.mode === "side") return hideSide();
    const mine = panelOf(focusedTab());
    if (mine) run("pane.close", { pane: mine.pane });
  }

  click(key, cx) {
    const row = this.rowsNow().find((r) => r.path === key);
    this.treeFocus.focus();
    if (!row) return;
    this.cursor = row.path;
    if (row.denied) { cx.notify(); return; }
    if (row.dir) this.toggle(row.path, cx); else { this.show(row.path, cx); this.toView(); }
    cx.notify();
  }

  link(url, cx) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url)) {
      if (/^(https?|mailto):/i.test(url) && !this.ctx.on) exec(window()?.platform === "linux" ? "xdg-open" : "open", [url]).catch(() => {});
      return;
    }
    let path = url.replace(/^file:\/\//i, "").split("#")[0];
    try { path = decodeURI(path); } catch {}
    if (!path) return;
    // A document as of a commit: a relative link opens its target in that same commit.
    if (this.atCommit) {
      if (path.startsWith("/")) { this.note = "Links to absolute paths don't open in a past version"; cx.notify(); return; }
      return this.openAtPath(normalize(parent(this.atCommit.path) + "/" + path).slice(1), this.atCommit.hash, cx);
    }
    const abs = path.startsWith("/") ? normalize(path) : normalize(this.tree.abs(parent(this.file ?? "")) + "/" + path);
    this.reveal(abs, cx);
  }

  // ---- commits ---------------------------------------------------------------

  /** "commits" or "changes" when chosen and the root is in a repo (or not known yet); else "files". */
  sideNow() { return this.side !== "files" && this.gitTabs() ? this.side : "files"; }
  /**
   * The Files | Commits | Changes tabs show: in a repo, or before the first status when a git tab
   * was remembered, so a reload or a new context doesn't flash Files for the status's ~100 ms.
   */
  gitTabs() { return Boolean(this.git) || (this.gitPending && this.side !== "files"); }
  sideFocus() { const s = this.sideNow(); return s === "commits" ? this.commitsFocus : s === "changes" ? this.changesFocus : this.treeFocus; }
  sideFocused() { return this.treeFocus.is_focused() || this.commitsFocus.is_focused() || this.changesFocus.is_focused(); }

  /** A tab of the sidebar, remembered per mode. */
  setSide(side, cx) {
    if (side !== "files" && !this.gitTabs()) { this.note = "Not in a git repository"; return; }
    const had = this.sideFocused();
    this.side = side;
    setShared(SIDE_KEY + this.mode, side === "files" ? null : side);
    if (side === "commits" && this.ctx?.log) this.logCheck(this.ctx, cx);
    if (had || !this.previewFocus.is_focused()) this.sideFocus().focus();
    cx?.notify();
  }

  /** The sidebar's layout key: its tab, or "narrow" (one width for both tabs). */
  sideKey(narrow) { return narrow ? "narrow" : this.sideNow(); }

  /** The width the sidebar opens at: the one last dragged to, else the default. */
  sideWidth(narrow) {
    const kept = shared(SIDE_W_KEY + this.mode + "." + this.sideKey(narrow));
    if (typeof kept === "number") return kept;
    if (narrow) return Math.min(NARROW_TREE_W, Math.round(this.width * 0.55));
    if (this.sideNow() !== "commits") return TREE_W;
    return Math.max(TREE_W, Math.min(COMMITS_W, Math.round((this.width ?? 1000) * 0.4)));
  }

  /**
   * The history: the first page, or (a refresh) as many commits as are loaded, or the next page.
   * One run at a time per context; a request meanwhile runs once after it.
   */
  loadLog(ctx, cx, { more = false } = {}) {
    if (!ctx || this.ctx !== ctx || !this.tree.root || this.closed || !cx) return;
    const log = ctx.log ??= { scope: this.logScope(), rows: [], index: new Map(), graph: null, remotes: [], more: false, loading: false,
      again: null, loaded: false, error: null, empty: false, sig: null, cursor: null };
    if (more && (!log.more || !log.loaded)) return;
    if (log.loading) { log.again = log.again === "full" || !more ? "full" : "more"; return; }
    const scope = this.logScope(), full = !more || log.scope !== scope;
    const skip = full ? 0 : log.rows.length;
    const count = full ? Math.max(hist.PAGE, log.scope === scope ? log.rows.length : 0) : hist.PAGE;
    log.loading = true;
    const root = this.tree.root;
    cx.spawn(async (cx) => {
      let r;
      try { r = await hist.log(root, ctx.on, { skip, count, scope }); }
      finally { log.loading = false; log.auto = false; }
      if (this.ctx !== ctx || ctx.log !== log) return;
      let again = log.again;
      log.again = null;
      if (r && !full && (r.sig !== log.sig || this.logScope() !== scope)) again = "full";   // history moved between pages
      else if (r && (r.error || r.notRepo || r.empty)) {
        Object.assign(log, { rows: [], index: new Map(), graph: null, more: false, loaded: true, sig: null,
          error: r.error ?? (r.notRepo ? "Not in a git repository" : null), empty: Boolean(r.empty), scope });
      } else if (r) {
        if (full) { log.graph = new hist.Graph(); log.rows = []; log.index = new Map(); }
        for (const c of r.commits) { log.index.set(c.hash, log.rows.length); log.rows.push(log.graph.add(c)); }
        Object.assign(log, { more: r.more, sig: r.sig, remotes: r.remotes, loaded: true, error: null, empty: false, scope });
        // The selection survives by hash; else the first row.
        if (!log.cursor || !log.index.has(log.cursor)) log.cursor = log.rows[0]?.c.hash ?? null;
      } else if (!log.loaded) log.error = ctx.on ? `Cannot reach ${ctx.on}` : "Cannot run git";
      cx.notify();
      if (again) this.loadLog(ctx, cx, { more: again === "more" });
    });
  }

  /** Reloads the history when a ref moved (commit, checkout, branch, tag, fetch). Cheap: one checksum. */
  logCheck(ctx, cx) {
    const log = ctx?.log;
    if (!log || this.ctx !== ctx || !cx || log.loading || log.checking) return;
    log.checking = true;
    const root = this.tree.root;
    cx.spawn(async (cx) => {
      let s;
      try { s = await hist.signature(root, ctx.on); }
      finally { log.checking = false; }
      if (this.ctx === ctx && ctx.log === log && s !== undefined && s !== log.sig) this.loadLog(ctx, cx);
    });
  }

  /** What hist.log() lists: every branch, or the current one, each with or without remote branches. */
  logScope() { return this.scope === "head" ? (this.remotes ? "upstream" : "head") : this.remotes ? "all" : "local"; }

  /** The All branches switch (off: the current branch only); remembered. */
  toggleScope(cx) {
    this.scope = this.scope === "all" ? "head" : "all";
    setShared(SCOPE_KEY, this.scope === "head" ? "head" : null);
    this.loadLog(this.ctx, cx);
    cx.notify();
  }

  /** The Remotes button: remote branches in the history (on Current branch, its upstream); remembered. */
  toggleRemotes(cx) {
    this.remotes = !this.remotes;
    setShared(REMOTES_KEY, this.remotes ? null : false);
    this.loadLog(this.ctx, cx);
    cx.notify();
  }

  /** Keys on the commit list; true when used. */
  commitKey(k, cx) {
    const log = this.ctx?.log, rows = log?.rows ?? [];
    const i = log?.index.get(log.cursor) ?? -1;
    const move = (j) => {
      if (!rows.length) return;
      j = Math.max(0, Math.min(rows.length - 1, j));
      log.cursor = rows[j].c.hash;
      this.commitScroll.scroll_to_item(j);
      if (j >= rows.length - 10) this.loadLog(this.ctx, cx, { more: true });
    };
    if (k === "down") move(i + 1);
    else if (k === "up") move(i < 0 ? 0 : i - 1);
    else if (k === "pagedown") move(i + 20);
    else if (k === "pageup") move(i - 20);
    else if (k === "home") move(0);
    else if (k === "end") move(rows.length - 1);
    else if (k === "enter" || k === "space") { if (rows[i]) this.openCommit(rows[i].c.hash, cx); }
    else if (k === "tab") this.previewFocus.focus();
    else if (k === "r") this.reload(cx);
    else if (k === "b") this.toggleTree();
    else if (k === "g") this.setSide("files", cx);
    else return false;
    cx.notify();
    return true;
  }

  commitClick(key, cx) {
    this.commitsFocus.focus();
    const log = this.ctx?.log;
    if (!log) return;
    if (key === "more") { this.loadLog(this.ctx, cx, { more: true }); cx.notify(); return; }
    log.cursor = key;
    this.openCommit(key, cx);
  }

  /** Dev hook: a row index or a hash prefix. */
  commitCmd(a, cx) {
    const log = this.ctx?.log, rows = log?.rows ?? [];
    const i = /^\d{1,5}$/.test(a) ? Number(a) : rows.findIndex((r) => r.c.hash.startsWith(a));
    if (!rows[i]) { this.note = `No commit ${a}`; return; }
    log.cursor = rows[i].c.hash;
    this.commitScroll.scroll_to_item(i, "center");
    this.openCommit(rows[i].c.hash, cx);
  }

  commitShown() { return Boolean(this.commit && !this.atCommit); }

  /** Shows a commit in the preview: header, changed files, diff. The tree's file stays behind it. */
  openCommit(hash, cx) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.atCommit) this.commitBack(cx);
    this.toView();
    if (this.commit?.hash === hash && !this.commit.error) { cx.notify(); return; }
    this.closeCommitView();
    if (this.ds) this.closeDocFind(false);
    this.note = null;
    const view = this.commit = { hash, data: null, loading: true, error: null };
    const root = this.tree.root, remotes = ctx.log?.remotes ?? [];
    cx.spawn(async (cx) => {
      const d = await hist.show(root, ctx.on, hash, remotes);
      if (this.commit !== view || this.ctx !== ctx) return;
      view.loading = false;
      if (!d || d.error) view.error = d?.error ?? `Cannot reach ${ctx.on ?? "git"}`;
      else {
        view.data = d;
        for (const f of d.files) if (f.diff?.lines.length) { this.prepDiff(f); }
      }
      cx.notify();
    });
    cx.notify();
  }

  /** What a file's diff block draws: tints, line numbers and the Editor (made here, never in render). */
  prepDiff(f) {
    const d = f.diff, num = (n) => (n ? String(n) : ""), hunk = (k, n) => (k === "h" ? "…" : num(n));
    f.runs = this.diffRuns(d.kinds);
    f.nums = {
      old: d.olds.map((n, i) => hunk(d.kinds[i], n)),
      now: d.news.map((n, i) => hunk(d.kinds[i], n)),
      digits: String(Math.max(1, ...d.olds, ...d.news)).length,
    };
    f.state = this.diffState(f);
  }

  /** Readonly Editor of one file's diff lines (made here, never in render). */
  diffState(f) {
    return EditorState.new({ readonly: true, font_family: settings().font_family, font_size: this.codeFont,
      value: f.diff.lines.join("\n"), line_numbers: false, folding: false, soft_wrap: false });
  }

  /** Runs of equal line kinds (a, d, h): one tint each. */
  diffRuns(kinds) {
    const out = [];
    for (let i = 0; i < kinds.length; i++) {
      const k = kinds[i];
      if (k === " ") continue;
      const last = out[out.length - 1];
      if (last && last.kind === k && last.from + last.n === i) last.n++;
      else out.push({ from: i, n: 1, kind: k });
    }
    return out;
  }

  closeCommitView() {
    for (const f of this.commit?.data?.files ?? []) f.state?.release();
    this.commit = null;
  }

  /** A commit's or change's ✕: stacked, back to the list it came from (not the file behind it). */
  closeCommitButton(cx) {
    this.closeCommitView();
    if (this.stacked()) this.toList();
    cx.notify();
  }

  /** File n of the shown commit, as of that commit (a deleted one: as of its parent). */
  openAt(n, cx) {
    const d = this.commit?.data, f = d?.files[n];
    if (!f) { this.note = `No file ${n} in this commit`; cx.notify(); return; }
    if (this.commit.change) { if (f.status !== "D") this.show(f.path, cx); cx.notify(); return; }
    this.openAtPath(f.path, f.status === "D" ? `${d.hash}^` : d.hash, cx, f.status === "D");
  }

  openAtPath(path, rev, cx, deleted = false) {
    const d = this.commit?.data, ctx = this.ctx, root = this.tree.root;
    if (!d || !ctx) return;
    const kept = this.atCommit ? this.atCommit.kept : this.file;
    const short = d.hash.slice(0, 7);
    this.atCommit = { hash: d.hash, short, subject: d.subject, path, kept, deleted };
    this.show(`${short}:${path}`, cx, { read: () => hist.readAt(root, ctx.on, rev, path) });
    cx.notify();
  }

  /** From a file at a commit back to the commit; the tree's file is read again behind it. */
  commitBack(cx) {
    const a = this.atCommit;
    if (!a) return;
    this.atCommit = null;
    this.show(a.kept ?? null, cx, { quiet: true });
    cx?.notify();
  }

  // ---- uncommitted changes ----------------------------------------------------

  /** The Changes tab's rows: a header per section that has entries, then its files. */
  changeRows() {
    const c = this.git?.changes, out = [];
    if (!c) return out;
    for (const [section, label] of SECTIONS) {
      const list = c[section];
      if (!list.length) continue;
      out.push({ key: `head:${section}`, head: true, label, n: list.length });
      for (const e of list) out.push({ key: `${section}:${e.path}`, section, label, e });
    }
    return out;
  }

  /** Returns true when the key was used. */
  changeKey(k, cx) {
    const rows = this.changeRows(), i = rows.findIndex((r) => r.key === this.changeCursor);
    // Headers are skipped: the cursor lands on the next file in the direction of travel.
    const move = (j, d) => {
      if (!rows.length) return;
      j = Math.max(0, Math.min(rows.length - 1, j));
      while (rows[j]?.head) j += d;
      if (!rows[j]) { j -= d; while (rows[j]?.head) j -= d; }
      if (!rows[j]) return;
      this.changeCursor = rows[j].key;
      this.changeScroll.scroll_to_item(j);
    };
    if (k === "down") move(i + 1, 1);
    else if (k === "up") move(i < 0 ? 0 : i - 1, -1);
    else if (k === "pagedown") move(i + 20, 1);
    else if (k === "pageup") move(i - 20, -1);
    else if (k === "home") move(0, 1);
    else if (k === "end") move(rows.length - 1, -1);
    else if (k === "enter" || k === "space") { if (rows[i] && !rows[i].head) this.openChange(rows[i], cx); }
    else if (k === "tab") this.previewFocus.focus();
    else if (k === "r") this.reload(cx);
    else if (k === "b") this.toggleTree();
    else if (k === "g") this.setSide("files", cx);
    else return false;
    cx.notify();
    return true;
  }

  changeClick(key, cx) {
    this.changesFocus.focus();
    const row = this.changeRows().find((r) => r.key === key);
    if (!row || row.head) return;
    this.changeCursor = key;
    this.openChange(row, cx);
  }

  /** Dev hook: a file's index (headers not counted) or a path (the first section that has it). */
  changeCmd(a, cx) {
    const rows = this.changeRows();
    const i = /^\d{1,5}$/.test(a) ? rows.indexOf(rows.filter((r) => !r.head)[Number(a)]) : rows.findIndex((r) => !r.head && r.e.path === a);
    if (!rows[i] || rows[i].head) { this.note = `No change ${a}`; return; }
    this.changeCursor = rows[i].key;
    this.changeScroll.scroll_to_item(i, "center");
    this.openChange(rows[i], cx);
  }

  /** Shows one uncommitted change's diff in the preview, in the commit view's place. */
  openChange(row, cx) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.atCommit) this.commitBack(cx);
    this.toView();
    if (this.commit?.change?.key === row.key && !this.commit.error) { cx.notify(); return; }
    this.closeCommitView();
    if (this.ds) this.closeDocFind(false);
    this.note = null;
    this.commit = { hash: null, change: { key: row.key, section: row.section, label: row.label, path: row.e.path, e: row.e }, data: null, loading: true, error: null };
    this.loadChange(cx);
    cx.notify();
  }

  /** The shown change again, when git status runs: gone from its section, or a new diff. */
  refreshChange(cx) {
    const ch = this.commit?.change;
    if (!ch || this.commit.loading) return;
    const e = this.git?.changes[ch.section]?.find((x) => x.path === ch.path);
    if (!e) {
      for (const f of this.commit.data?.files ?? []) f.state?.release();
      Object.assign(this.commit, { data: null, error: `No ${ch.label.toLowerCase()} changes in ${ch.path} anymore` });
      cx.notify();
      return;
    }
    ch.e = e;
    this.loadChange(cx, true);
  }

  loadChange(cx, quiet = false) {
    const view = this.commit, ctx = this.ctx, ch = view.change, root = this.tree.root;
    if (view.busy) { view.again = true; return; }
    view.busy = true;
    cx.spawn(async (cx) => {
      let f;
      try { f = await hist.change(root, ctx.on, ch.section, ch.e); }
      finally { view.busy = false; }
      if (this.commit !== view || this.ctx !== ctx) return;
      view.loading = false;
      if (f === undefined && quiet) return;   // unreachable for a moment: keep what is shown
      const old = view.data?.files[0];
      if (!f || f.error) { view.error = f?.error ?? `Cannot reach ${ctx.on ?? "git"}`; old?.state?.release(); view.data = null; }
      else if (old && old.binary === f.binary && (old.diff?.lines.join("\n") ?? "") === (f.diff?.lines.join("\n") ?? "")) Object.assign(old, { add: f.add, del: f.del, status: f.status });
      else {
        old?.state?.release();
        if (f.diff?.lines.length) { this.prepDiff(f); }
        view.error = null;
        view.data = { files: [f], truncated: f.truncated };
      }
      cx.notify();
      if (view.again) { view.again = false; this.loadChange(cx, true); }
    });
  }

  /** Over a change's diff: its section, the way to the file, and close. */
  changeHeader(ch, t) {
    const z = this.textZoom, f = this.commit?.data?.files[0];
    return h_flex().w_full().flex_none().gap(8).px(Math.round(14 * z)).py(Math.round(10 * z)).items_center().rounded(8).border_1().border_color(t.border).bg(t.raised)
      .child(div().flex_none().px(6).py(1).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(ch.label))
      .child(div().flex_1().min_w(0).truncate().text_size(Math.round(14 * z)).font_bold().child(f?.from ? `${f.from} → ${ch.path}` : ch.path))
      .when(Boolean(f) && !f.binary, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(`+${f.add}`))
        .child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(`−${f.del}`)))
      .when(f?.status !== "D", (el) => el.child(h_flex().id("fp-change-open").h(22).px(6).flex_none().rounded(5).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover)).text_size(12).text_color(t.accent).on_click((_e, cx) => this.openAt(0, cx)).child("Open file")))
      .child(this.button("fp-change-close", "close.svg", t, (_e, cx) => this.closeCommitButton(cx)));
  }

  /** The Changes tab: Staged, Unstaged and Untracked, a header each, as one virtual list. */
  changesPane(t) {
    const rows = this.changeRows(), focus = this.changesFocus.is_focused(), open = this.commit?.change?.key;
    return v_flex().id("fp-changes-pane").w_full().flex_1().min_h(0)
      .track_focus(this.changesFocus).on_key_down((e, cx) => this.onKey(e, cx, "changes"))
      .when(rows.length > 0, (el) => el.child(div().flex_1().min_h(0).relative().py(4)
        .child(v_virtual_list("fp-changes", rows.length, ROW, (i) => rows[i].key,
          (range) => rows.slice(range.start, range.end).map((r) => this.changeRow(r, t, focus, open)))
          .track_scroll(this.changeScroll).on_item_click((key, cx) => this.changeClick(key, cx)).size_full())
        .child(Scrollbar.vertical("fp-changes").viewport_from_layout().absolute().inset_0())))
      .when(!rows.length, (el) => el.child(v_flex().p(10).text_color(t.dim).child(this.git?.changes ? "No changes" : "Loading changes…")));
  }

  /** A section header (name, count) or a file: status letter, name, its folder. Pure (list renderer). */
  changeRow(r, t, focus, open) {
    if (r.head) return h_flex().h(ROW).w_full().px(10).gap(6).items_end().pb(3).text_size(11).font_medium().text_color(t.muted)
      .child(div().flex_none().child(r.label.toUpperCase())).child(div().flex_none().text_color(t.dim).child(String(r.n)));
    const e = r.e, cut = e.path.lastIndexOf("/"), name = e.path.slice(cut + 1), dir = cut > 0 ? e.path.slice(0, cut) : "";
    const color = e.status === "U" ? gitColor("U", t) : e.status === "!" ? gitColor("!", t) : statusColor(e.status, t);
    return h_flex().h(ROW).w_full().pl(10).pr(8).gap(6).items_center()
      .when(r.key === this.changeCursor, (el) => el.bg(focus ? t.selected : t.hover))
      .child(div().w(12).flex_none().text_center().text_size(11).font_medium().text_color(color).child(e.status))
      .child(div().flex_none().max_w("70%").truncate().text_color(r.key === open ? t.accent : t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(dir));
  }

  statusName() {
    if (this.commitShown() && this.commit.change) return `${this.commit.change.path} · ${this.commit.change.label.toLowerCase()}`;
    if (this.commitShown()) return `commit ${this.commit.hash.slice(0, 7)}`;
    if (this.atCommit) return `${this.atCommit.path} @ ${this.atCommit.short}`;
    return this.file ?? "No file";
  }

  commitParts() {
    const d = this.commit?.data;
    if (!d) return [];
    const add = d.files.reduce((s, f) => s + f.add, 0), del = d.files.reduce((s, f) => s + f.del, 0);
    if (this.commit.change) return [`+${add.toLocaleString("en-US")} −${del.toLocaleString("en-US")}`, ...(d.truncated ? ["diff truncated"] : [])];
    return [plural(d.files.length, "file"), `+${add.toLocaleString("en-US")} −${del.toLocaleString("en-US")}`, ...(d.truncated ? ["diff truncated"] : [])];
  }

  // ---- UI ----------------------------------------------------------------------

  render(cx) {
    const t = theme();
    if (this.mode === "diagram") {
      if (!this.zoom) return v_flex().size_full().bg(t.surface).child(this.message(t, "Nothing to show", "Esc close"));
      return this.zoomLayer(t);
    }
    this.follow(cx);
    this.followZoom(cx);
    if (settings().dark !== this.dark) {
      // Theme flipped: syntax colors are baked into the EditorStates, so rebuild them (outside render).
      this.dark = settings().dark;
      cx.spawn(async (cx) => { this.build(cx); this.decorate(); this.runDoc(); cx.notify(); });
    }
    const rows = this.tree.rows(), narrow = this.narrow(), shown = this.treeShown();
    // The Commits tab asks for the history the first time it shows (once per context).
    const ctx = this.ctx;
    const view = this.viewShown(), listed = this.stacked() ? !view : shown;
    if (listed && this.sideNow() === "commits" && ctx && !ctx.log && !ctx.logWanted && this.tree.root) {
      ctx.logWanted = true;
      cx.spawn(async (cx) => this.loadLog(ctx, cx));
    }
    // The expanded diagram replaces the popup's content: nothing under it can take the pointer
    // (no occlusion API), and the EditorStates stay retained for the way back.
    if (this.zoom) return v_flex().id("fp-root").size_full().min_h(0).on_size_change((box, cx) => this.sized(box, cx)).child(this.zoomLayer(t));
    return v_flex().id("fp-root").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(13)
      .on_mouse_down("left", (_e, cx) => this.aimAway(cx))
      .on_mouse_up("left", (e, cx) => this.aimUp(null, e, cx))
      // The side panel is a card like Herdr's Files and Changes panels next to it.
      .when(this.mode === "side", (el) => el.rounded(10).overflow_hidden().border_1().border_color(t.border))
      .on_size_change((box, cx) => this.sized(box, cx))
      .child(this.topBar(t))
      .when(this.stacked(), (el) => el.child(view
        ? v_flex().flex_1().min_h(0).child(this.backBar(t)).child(this.previewPane(t, narrow))
        : div().flex_1().min_h(0).child(this.sidePane(rows, t, cx))))
      .when(!this.stacked(), (el) => el.child(h_flex().flex_1().min_h(0)
        .when(narrow || !shown, (el) => el.child(this.strip(t)))
        .child(this.split(rows, t, narrow, shown, cx))))
      .child(this.statusBar(t));
  }

  zoomLayer(t) {
    return this.zoom.render(t, this.zoomFocus, {
      button: (id, icon, t, onClick) => this.button(id, icon, t, onClick),
      onKey: (e, cx) => this.zoomKeyDown(e, cx),
      onEscape: (cx) => { this.zoomAct("close", cx); cx?.notify(); },
      onClose: (cx) => { this.zoomAct("close", cx); cx.notify(); },
    });
  }

  button(id, icon, t, onClick) {
    return h_flex().id(id).size(22).flex_none().rounded(5).items_center().justify_center().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(svg(ICON + icon).size(14).text_color(t.muted));
  }

  textButton(id, label, t, onClick) {
    return h_flex().id(id).h(22).px(5).flex_none().rounded(5).items_center().justify_center().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(onClick).text_size(12).text_color(t.muted).child(label);
  }

  topBar(t) {
    const on = this.ctx?.on;
    return h_flex().h(28).flex_none().pl(4).pr(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .when(!this.stacked(), (el) => el.child(this.button("fp-tree-bar", "sidebar.svg", t, (_e, cx) => { this.toggleTree(); cx.notify(); })))
      .child(this.button("fp-find-tree", "search.svg", t, (_e, cx) => this.openTreeFind(cx)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(tilde(this.tree.root) || "No folder"))
      .when(Boolean(on), (el) => el.child(div().flex_none().px(6).rounded(4).bg(t.raised).text_size(11)
        .text_color(this.tree.offline ? t.ansi3 : t.muted).child(this.tree.offline ? `${on} · offline` : on)))
      .when(Boolean(this.doc && (this.doc.kind === "markdown" || this.doc.kind === "text") && !this.commitShown()), (el) =>
        el.child(this.button("fp-find-doc", "search-doc.svg", t, (_e, cx) => this.openDocFind(cx))))
      .child(this.textButton("fp-text-out", "A−", t, (_e, cx) => this.textAct("out", cx)))
      .child(div().id("fp-text-pct").w(40).flex_none().rounded(4).text_center().text_size(11.5).cursor_pointer().hover((s) => s.bg(t.hover))
        .text_color(this.textZoom === 1 ? t.dim : t.foreground).on_click((_e, cx) => this.textAct("reset", cx))
        .child(`${Math.round(this.textZoom * 100)}%`))
      .child(this.textButton("fp-text-in", "A+", t, (_e, cx) => this.textAct("in", cx)))
      .child(this.button("fp-reload", "reload.svg", t, (_e, cx) => this.reload(cx)))
      .when(Boolean(this.overlay) && sideAvailable(), (el) => el.child(this.button("fp-anchor", "anchor.svg", t, () => this.anchor())))
      .when(this.mode === "side", (el) => el.child(this.button("fp-popout", "expand.svg", t, () => this.popOut())))
      .child(this.button("fp-close", "close.svg", t, () => this.closeView()));
  }

  row(r, t, focus) {
    const md = !r.dir && lang.isMarkdown(r.name), code = !r.dir && lang.forPath(r.name);
    const open = r.dir && this.tree.expanded.has(r.path);
    const icon = r.dir ? (open ? "folder-open.svg" : "folder.svg") : md ? "file-md.svg" : code ? "file-code.svg" : "file.svg";
    // Git: a file gets its letter, a folder with changes below it a dot; both tint the name.
    const g = this.git ? (r.dir ? this.git.folders : this.git.files).get(r.path) : undefined;
    const tint = g ? gitColor(g, t) : null;
    return h_flex().h(ROW).w_full().pl(6 + r.depth * 14).pr(8).gap(5).items_center()
      .when(r.path === this.cursor, (el) => el.bg(focus ? t.selected : t.hover))
      .child(r.dir ? svg(ICON + (open ? "chevron-down.svg" : "chevron-right.svg")).size(11).flex_none().text_color(t.dim) : div().w(11).flex_none())
      .child(svg(ICON + icon).size(14).flex_none().text_color(md ? t.accent : r.dir ? t.muted : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(r.path === this.file ? t.accent : r.denied ? t.dim : tint ?? t.foreground).child(r.name))
      .when(r.denied, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("no access")))
      .when(Boolean(tint) && !r.dir, (el) => el.child(div().w(12).flex_none().text_center().text_size(11).font_medium().text_color(tint).child(g)))
      .when(Boolean(tint) && r.dir, (el) => el.child(h_flex().w(12).flex_none().justify_center().child(div().size(5).rounded_full().bg(tint))));
  }

  /** Stacked: over what the list opened, the way back to it. */
  backBar(t) {
    const label = { files: "Files", commits: "Commits", changes: "Changes" }[this.sideNow()];
    const what = this.commitShown() ? null : this.atCommit ? this.atCommit.path : this.file;
    return h_flex().h(28).flex_none().pl(4).pr(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().id("fp-back").h(22).px(6).flex_none().gap(4).rounded(5).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.toList(); cx.notify(); })
        .text_size(12).text_color(t.accent).child(`← ${label}`))
      .when(Boolean(what), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(what)));
  }

  /** The hidden tree's strip (and a narrow view's), with its toggle. */
  strip(t) {
    return v_flex().id("fp-strip").w(STRIP_W).flex_none().h_full().items_center().pt(4).border_r(1).border_color(t.border).bg(t.chrome)
      .child(this.button("fp-tree-toggle", this.treeShown() ? "folder-open.svg" : "folder.svg", t, (_e, cx) => { this.toggleTree(); cx.notify(); }));
  }

  treePane(rows, t) {
    const focus = this.treeFocus.is_focused();
    const tree = this.tree, ts = this.ts, searching = Boolean(ts?.query.trim());
    const empty = searching ? null : tree.error || (!tree.loaded ? (tree.offline ? null : this.ctx?.cwd || this.loadingTree ? "Loading files…" : "No folder") : rows.length ? null : "Empty folder");
    return v_flex().id("fp-tree-pane").w_full().flex_1().min_h(0)
      .track_focus(this.treeFocus).on_key_down((e, cx) => this.onKey(e, cx, "tree"))
      .key_context(TREE_CONTEXT).on_action(FIND_OPEN, (_e, cx) => this.openTreeFind(cx))
      .when(Boolean(ts), (el) => el.child(this.findBar("tree", t)))
      .when(Boolean(tree.offline), (el) => el.child(v_flex().flex_none().px(10).py(6).gap(4).border_b(1).border_color(t.border).text_size(11.5)
        .child(div().text_color(t.ansi3).child(tree.offline))
        .child(h_flex().gap(8).text_color(t.dim)
          .child(div().id("fp-retry-offline").cursor_pointer().text_color(t.accent).on_click((_e, cx) => this.reload(cx)).child("Retry"))
          .when(tree.loaded, (el) => el.child("showing the last loaded tree")))))
      .when(searching, (el) => el.child(this.findResults(t)))
      .when(!searching && rows.length > 0, (el) => el.child(div().flex_1().min_h(0).relative().py(4)
        .child(v_virtual_list("fp-tree", rows.length, ROW, (i) => rows[i].path,
          (range) => rows.slice(range.start, range.end).map((r) => this.row(r, t, focus)))
          .track_scroll(this.scroll).on_item_click((key, cx) => this.click(key, cx)).size_full())
        .child(Scrollbar.vertical("fp-tree").viewport_from_layout().absolute().inset_0())))
      .when(Boolean(empty), (el) => el.child(v_flex().p(10).gap(8).text_color(t.dim).child(empty)
        .when(Boolean(tree.error), (el) => el.child(div().id("fp-retry").cursor_pointer().text_color(t.accent).on_click((_e, cx) => this.reload(cx)).child("Retry")))))
      .when(tree.limited && !searching, (el) => el.child(div().flex_none().px(10).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(`Limited to ${PER_FOLDER} entries per folder and ${TOTAL.toLocaleString("en-US")} in total`)));
  }

  /**
   * A search field with its own key context: the bound Esc closes only the search, and the
   * keys typed into it never reach the pane's shortcuts.
   */
  findBar(side, t) {
    const st = side === "tree" ? this.ts : this.ds;
    const close = (cx) => { if (side === "tree") this.closeTreeFind(cx); else { this.closeDocFind(); cx.notify(); } };
    let info = null;
    if (side === "doc" && st.query) {
      const text = this.doc?.kind === "text";
      info = st.total ? `${matches(st.total)} in ${plural(text ? st.hits.length : st.blocks, text ? "line" : "block")}` : "No matches";
    }
    return h_flex().id(`fp-find-${side}`).h(32).flex_none().w_full().pl(8).pr(4).gap(4).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .key_context(FIND_CONTEXT).on_action(FIND_ESCAPE, (_e, cx) => close(cx))
      .on_key_down((e, cx) => this.findKey(e, cx, side))
      .child(h_flex().flex_1().min_w(0).h(24).px(6).gap(6).items_center().rounded(5).border_1().border_color(t.accent).bg(t.background)
        .child(svg(ICON + "search.svg").size(12).flex_none().text_color(t.dim))
        .child(Input.new(st.input).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)))
      .when(Boolean(info), (el) => el.child(div().flex_none().px(4).text_size(11).text_color(st.total ? t.muted : t.ansi3).child(info)))
      .when(side === "doc" && st.hits.length > 0, (el) => el
        .child(this.textButton("fp-find-prev", "↑", t, (_e, cx) => { this.docStep(-1); cx.notify(); }))
        .child(this.textButton("fp-find-next", "↓", t, (_e, cx) => { this.docStep(1); cx.notify(); })))
      .child(this.button(`fp-find-${side}-close`, "close.svg", t, (_e, cx) => close(cx)));
  }

  /** The tree search's results: a flat list of paths, best first, in place of the tree. */
  findResults(t) {
    const ts = this.ts, f = this.ctx?.files, list = ts.results;
    let foot;
    if (!f?.data) foot = f?.error ? `Cannot list the files: ${f.error}` : "Listing files…";
    else if (!list.length) foot = "No matching files";
    else foot = (ts.total > list.length ? `Best ${list.length} of ${ts.total.toLocaleString("en-US")} matches` : matches(ts.total))
      + ` · ${f.data.paths.length.toLocaleString("en-US")}${f.data.truncated ? "+" : ""} files`;
    return v_flex().flex_1().min_h(0)
      .when(list.length > 0, (el) => el.child(div().flex_1().min_h(0).relative().py(4)
        .child(v_virtual_list("fp-find-list", list.length, ROW, (i) => "find:" + list[i].path,
          (range) => list.slice(range.start, range.end).map((r, k) => this.resultRow(r, range.start + k === ts.at, t)))
          .track_scroll(this.findScroll).on_item_click((key, cx) => this.findClick(key.slice(5), cx)).size_full())
        .child(Scrollbar.vertical("fp-find-list").viewport_from_layout().absolute().inset_0())))
      .when(!list.length, (el) => el.child(div().flex_1()))
      .child(div().flex_none().px(10).py(4).border_t(1).border_color(t.border).text_size(11)
        .text_color(f?.error ? t.ansi3 : t.dim).child(foot));
  }

  /** A result: the name with its matched letters in the accent, then its folder, dimmed. */
  resultRow(r, sel, t) {
    const cut = r.path.lastIndexOf("/") + 1, name = r.path.slice(cut), dir = r.path.slice(0, Math.max(0, cut - 1));
    const hit = new Set(r.hits), spans = [];
    for (let i = 0; i < name.length;) {
      const on = hit.has(cut + i);
      let j = i + 1;
      while (j < name.length && hit.has(cut + j) === on) j++;
      const piece = div().flex_none().whitespace_nowrap().child(name.slice(i, j));
      spans.push(on ? piece.text_color(t.accent).font_bold() : piece);
      i = j;
    }
    const md = lang.isMarkdown(name), code = lang.forPath(name);
    const g = this.git?.files.get(r.path), tint = g ? gitColor(g, t) : null;
    return h_flex().h(ROW).w_full().pl(8).pr(8).gap(5).items_center().when(sel, (el) => el.bg(t.selected))
      .child(svg(ICON + (md ? "file-md.svg" : code ? "file-code.svg" : "file.svg")).size(14).flex_none().text_color(md ? t.accent : t.dim))
      .child(h_flex().flex_none().max_w("70%").overflow_hidden().text_color(r.path === this.file ? t.accent : tint ?? t.foreground).children(spans))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
      .when(Boolean(tint), (el) => el.child(div().w(12).flex_none().text_center().text_size(11).font_medium().text_color(tint).child(g)));
  }

  /** The sidebar: Files | Commits tabs (in a repo) over the tree or the history. */
  /**
   * The sidebar and the preview, with a draggable divider. One group per layout key, so the
   * Files tab, the Commits tab and the narrow view each keep their own width; a drag is stored
   * per mode and is where the sidebar opens next time.
   */
  split(rows, t, narrow, shown, cx) {
    const key = this.sideKey(narrow), max = Math.max(MIN_SIDE_W, (this.width ?? 1000) - MIN_PREVIEW_W);
    return h_resizable(`fp-split-${key}`).flex_1().min_w(0).h_full()
      .on_resize((sizes, cx) => { setShared(SIDE_W_KEY + this.mode + "." + key, Math.round(sizes[0])); cx.notify(); })
      .child(resizable_panel().size(this.sideWidth(narrow)).size_range(MIN_SIDE_W, max).visible(shown)
        .child(shown ? this.sidePane(rows, t, cx) : div()))
      .child(resizable_panel().child(this.previewPane(t, narrow)));
  }

  sidePane(rows, t, cx) {
    const side = this.sideNow(), w = this.sideW ?? this.sideWidth(this.narrow());
    return v_flex().id("fp-side").size_full().min_h(0).border_r(1).border_color(t.border).bg(t.chrome).text_size(12.5)
      .on_size_change((size, cx) => { if (Math.round(size.width) !== this.sideW) { this.sideW = Math.round(size.width); cx.notify(); } })
      .when(this.gitTabs(), (el) => el.child(h_flex().h(28).flex_none().px(6).gap(2).items_end().border_b(1).border_color(t.border)
        .child(this.sideTab("files", "Files", side, t)).child(this.sideTab("commits", "Commits", side, t))
        .child(this.sideTab("changes", "Changes", side, t))))
      .child(side === "commits" ? this.commitsPane(t, w, cx) : side === "changes" ? this.changesPane(t) : this.treePane(rows, t));
  }

  sideTab(key, label, side, t) {
    const on = key === side;
    return h_flex().id(`fp-tab-${key}`).h(27).px(8).items_center().cursor_pointer().text_size(12)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
      .when(on, (el) => el.border_b(2).border_color(t.accent))
      .on_click((_e, cx) => this.setSide(key, cx)).child(label);
  }

  /** The branch scope as a two-sided switch: "All branches" and "Current branch" inside it, the chosen one lit. */
  scopeSwitch(t) {
    const side = (scope, label, tip) => {
      const on = this.scope === scope;
      return h_flex().id(`fp-scope-${scope}`).h(18).px(8).flex_none().rounded_full().items_center().text_size(11.5)
        .bg(on ? t.accent : t.raised).text_color(on ? t.background : t.muted).when(on, (el) => el.font_medium())
        .when(!on, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.toggleScope(cx)))
        .tooltip(tip).child(label);
    };
    return h_flex().id("fp-scope").h(22).p(2).flex_none().rounded_full().items_center().bg(t.raised).border_1().border_color(t.border)
      .child(side("all", "All branches", "Every branch, tag and HEAD"))
      .child(side("head", "Current branch", "Only the checked-out branch (git log HEAD)"));
  }

  /** Remote branches on or off: every remote branch, or on Current branch its upstream (what to pull or push). */
  remotesButton(t) {
    const on = this.remotes, head = this.scope === "head";
    const tip = on ? (head ? "Hide the upstream branch" : "Hide remote branches")
      : head ? "Show the upstream branch too (what is not pulled or pushed yet)" : "Show remote branches";
    return h_flex().id("fp-remotes").h(20).px(7).flex_none().rounded(5).items_center().border_1().text_size(11.5)
      .border_color(on ? t.accent : t.border).bg(on ? tint(t.accent, "1f") ?? t.selected : t.background).text_color(on ? t.foreground : t.dim)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleRemotes(cx)).tooltip(tip)
      .child("Remotes");
  }

  /** The commit list: a toolbar (scope, count) over a virtual list of graph rows. */
  commitsPane(t, w, cx) {
    const ctx = this.ctx, log = ctx?.log, rows = log?.rows ?? [], more = Boolean(log?.more);
    const focus = this.commitsFocus.is_focused(), meta = w >= META_W, open = this.commitShown() || this.atCommit ? this.commit?.hash : null;
    const lw = meta ? LANE_W : NARROW_LANE_W, max = meta ? MAX_LANES : NARROW_MAX_LANES;
    const g = { lw, max, h: CROW, width: Math.min(log?.graph?.width ?? 1, max) * lw };
    let empty = null;
    if (!log || !log.loaded) empty = log?.error ?? "Loading history…";
    else if (log.error) empty = log.error;
    else if (log.empty) empty = "No commits yet";
    else if (!rows.length) empty = "No commits";
    const count = rows.length ? `${rows.length.toLocaleString("en-US")}${more ? "+" : ""} commits` : "";
    return v_flex().id("fp-commits-pane").w_full().flex_1().min_h(0)
      .track_focus(this.commitsFocus).on_key_down((e, cx) => this.onKey(e, cx, "commits"))
      .child(h_flex().h(28).flex_none().pl(4).pr(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(this.scopeSwitch(t))
        .child(this.remotesButton(t))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11).text_color(t.dim).child(count)))
      .when(rows.length > 0, (el) => el.child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("fp-commits", rows.length + (more ? 1 : 0), CROW, (i) => (i < rows.length ? rows[i].c.hash : "more"), (range, rcx) => {
          // Near the end: the next page, from a task (a renderer can't notify).
          if (more && range.end >= rows.length - 10 && !log.loading && !log.auto) {
            log.auto = true;
            try { (rcx ?? cx).spawn(async (cx) => this.loadLog(ctx, cx, { more: true })); } catch { log.auto = false; }
          }
          const out = [];
          for (let i = range.start; i < range.end; i++) out.push(i < rows.length ? this.commitRow(rows[i], t, { focus, meta, open, g, cursor: log.cursor }) : this.moreRow(log, t));
          return out;
        }).track_scroll(this.commitScroll).on_item_click((key, cx) => this.commitClick(key, cx)).size_full())
        .child(Scrollbar.vertical("fp-commits").viewport_from_layout().absolute().inset_0())))
      .when(Boolean(empty), (el) => el.child(v_flex().p(10).gap(8).text_color(log?.error ? t.ansi3 : t.dim).child(empty)
        .when(Boolean(log?.error), (el) => el.child(div().id("fp-retry-log").cursor_pointer().text_color(t.accent).on_click((_e, cx) => this.loadLog(ctx, cx)).child("Retry")))));
  }

  /**
   * A commit: graph cell with all its ref flags at the node, subject; author and date when there is room. Pure (list renderer).
   * The flags push the subject right; when they overflow, the graph box shrinks and clips them and the subject gets no width.
   */
  commitRow(row, t, { focus, meta, open, g, cursor }) {
    const c = row.c, sel = c.hash === cursor, bg = sel ? (focus ? t.selected : t.hover) : t.chrome;
    const fl = c.flags ?? [];
    // Flags start right after the row's rightmost lane; past the graph's width they push the subject.
    const at = reach(row, g.max) * g.lw + 1, color = row.node >= g.max ? t.dim : palette(t)[row.color % hist.COLORS];
    const graph = !fl.length ? cell(row, t, { ...g, bg })
      : h_flex().flex_shrink_1().min_w(g.width).h(CROW).relative().items_center().overflow_hidden()
        .child(cell(row, t, { ...g, bg, flag: at }).absolute().top(0).left(0))
        .child(div().w(at).h(CROW).flex_none())
        .children(fl.map((r, i) => this.refFlag(r, t, color, meta ? 140 : 80, i === 0)));
    return h_flex().h(CROW).w_full().pl(6).pr(8).gap(6).items_center().bg(bg)
      .child(graph)
      .child(div().flex_1().min_w(0).truncate().text_color(c.hash === open ? t.accent : t.foreground).when(c.head, (el) => el.font_medium()).child(c.subject))
      .when(meta, (el) => el
        .child(div().w(84).flex_none().truncate().text_size(11).text_color(t.muted).child(c.author))
        .child(div().w(28).flex_none().text_right().text_size(11).text_color(t.dim).child(hist.relative(c.at, true))));
  }

  /**
   * One ref flag in the graph, in the node's lane color: branch filled, tag outlined, remote dimmed,
   * detached HEAD in the foreground color; the checked-out branch bold with a foreground border.
   * The first flag of a row has a pointer toward the node. "main ⇄ origin": a local branch and its remote
   * on the same commit (just "main ⇄" when narrow).
   */
  refFlag(r, t, lane, maxW, tip) {
    const H = 16, tag = r.kind === "tag", remote = r.kind === "remote", head = r.kind === "head";
    const c = head ? t.foreground : lane;
    const fill = tag ? (tint(c, "26") ?? t.raised) : remote ? (tint(c, "4d") ?? t.raised) : c;
    const text = tag ? c : remote ? t.foreground : t.chrome;
    const edge = r.current && !head ? t.foreground : tag ? c : null;
    const body = h_flex().flex_none().min_w(0).max_w(maxW).h(H).px(5).gap(3).items_center().bg(fill)
      .when(tip, (el) => el.rounded_r(4)).when(!tip, (el) => el.rounded(4).ml(3))
      .when(Boolean(edge), (el) => el.border_1().border_color(edge))
      .child(div().min_w(0).truncate().text_size(10.5).text_color(text).when(r.current || head, (el) => el.font_bold())
        .child(tag ? `◆ ${r.name}` : r.name))
      .when(r.also?.length > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(tint(text, "b3") ?? text)
        .child(maxW < 100 ? "⇄" : `⇄ ${r.also.join(", ")}`)));
    if (!tip) return body;
    return h_flex().flex_none().min_w(0).items_center().child(pointer(remote ? fill : c, 5, H)).child(body);
  }

  refPill(r, t, maxW) {
    const color = r.current ? t.accent : r.kind === "tag" ? t.ansi3 : r.kind === "remote" ? t.muted : r.kind === "head" ? t.ansi1 : t.ansi2;
    return h_flex().flex_none().max_w(maxW).h(17).px(5).items_center().rounded(8).border_1().border_color(tint(color, "66") ?? color)
      .bg(tint(color, "1f") ?? t.raised).child(div().min_w(0).truncate().text_size(10.5).text_color(color).child(r.kind === "tag" ? `◆ ${r.name}` : r.name));
  }

  moreRow(log, t) {
    return h_flex().h(CROW).w_full().justify_center().items_center().text_size(11.5).text_color(t.accent).child(log.loading ? "Loading…" : "Load more");
  }

  /** The shown commit: header, changed files, diff per file. */
  commitView(view, t, narrow) {
    if (view.loading) return this.message(t, view.change ? "Loading diff…" : "Loading commit…");
    if (view.error || !view.data) return this.message(t, view.error ?? (view.change ? "Cannot read this change" : "Cannot read this commit"));
    const d = view.data, ch = view.change;
    let shown = 0;
    return v_flex().id(ch ? `change:${ch.key}` : `commit:${d.hash}`).flex_1().min_h(0).overflow_y_scrollbar()
      .child(h_flex().w_full().justify_center().px(narrow ? 12 : 24).py(narrow ? 12 : 20)
        .child(v_flex().w_full().max_w(Math.round(COL_W * this.textZoom)).gap(Math.round(14 * this.textZoom)).text_size(this.proseSize())
          .child(ch ? this.changeHeader(ch, t) : this.commitHeader(d, t, narrow))
          .when(!ch, (el) => el.child(this.commitFiles(d, t)))
          .children(d.files.map((f, i) => { const el = this.diffBlock(f, i, t, shown); shown += f.diff?.lines.length ?? 0; return el; }))
          .when(d.truncated && !ch, (el) => el.child(div().text_size(11.5).text_color(t.ansi3)
            .child(`Diff truncated: at most ${hist.MAX_FILE_DIFF.toLocaleString("en-US")} lines per file and ${hist.MAX_DIFF.toLocaleString("en-US")} per commit`)))));
  }

  commitHeader(d, t, narrow) {
    const mono = typeof settings().font_family === "string" ? String(settings().font_family) : null;
    const copied = Boolean(d.copied), z = this.textZoom;
    const label = (s) => div().w(narrow ? 56 : 72).flex_none().text_color(t.dim).child(s);
    return v_flex().w_full().flex_none().gap(Math.round(8 * z)).p(Math.round(14 * z)).rounded(8).border_1().border_color(t.border).bg(t.raised)
      .child(h_flex().w_full().gap(8).items_start()
        .child(div().flex_1().min_w(0).text_size(Math.round(16 * z)).font_bold().child(d.subject || "(no subject)"))
        .child(this.button("fp-commit-close", "close.svg", t, (_e, cx) => this.closeCommitButton(cx))))
      .when(d.refs.length > 0, (el) => el.child(h_flex().w_full().flex_wrap().gap(5).children(d.refs.map((r) => this.refPill(r, t, 240)))))
      .child(v_flex().w_full().gap(4).text_size(Math.round(12.5 * z))
        .child(h_flex().w_full().gap(8).items_center().child(label("Commit"))
          .child(div().min_w(0).truncate().text_color(t.foreground).when(Boolean(mono), (e) => e.font_family(mono)).child(d.hash))
          .child(h_flex().id("fp-copy-hash").h(20).flex_none().px(5).gap(4).rounded(4).items_center().cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.copyBlock(d, cx, d.hash))
            .child(svg(ICON + (copied ? "check.svg" : "copy.svg")).size(13).text_color(copied ? t.done : t.muted))
            .when(copied, (el) => el.child(div().text_size(11).text_color(t.done).child("Copied")))))
        .child(h_flex().w_full().gap(8).child(label("Author"))
          .child(div().flex_1().min_w(0).truncate().child(`${d.author} <${d.email}>`)))
        .child(h_flex().w_full().gap(8).child(label("Date"))
          .child(div().flex_1().min_w(0).truncate().child(`${hist.absolute(d.at)} · ${hist.relative(d.at)}`)))
        .when(d.parents.length > 0, (el) => el.child(h_flex().w_full().gap(8).child(label(d.parents.length > 1 ? "Parents" : "Parent"))
          .children(d.parents.map((p, i) => div().id(`fp-parent-${i}`).flex_none().cursor_pointer().text_color(t.accent)
            .when(Boolean(mono), (e) => e.font_family(mono)).on_click((_e, cx) => this.openCommit(p, cx)).child(p.slice(0, 7)))))))
      .when(Boolean(d.body), (el) => el.child(div().w_full().pt(Math.round(6 * z)).border_t(1).border_color(t.border)
        .child(TextView.markdown(`msg-${d.hash}`, d.body).selectable(true))));
  }

  /** The changed files: status letter, path (click: the file as of this commit), +/- counts. */
  commitFiles(d, t) {
    const add = d.files.reduce((s, f) => s + f.add, 0), del = d.files.reduce((s, f) => s + f.del, 0);
    return v_flex().w_full().flex_none().rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden().text_size(12.5)
      .child(h_flex().h(26).px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5).text_color(t.muted)
        .child(div().flex_1().child(d.files.length ? plural(d.files.length, "file") + " changed" : "No file changes"))
        .child(div().text_color(t.ansi2).child(`+${add.toLocaleString("en-US")}`))
        .child(div().text_color(t.ansi1).child(`−${del.toLocaleString("en-US")}`)))
      .children(d.files.map((f, i) => h_flex().id(`fp-cfile-${i}`).h(24).px(10).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openAt(i, cx))
        .child(div().w(12).flex_none().text_center().text_size(11).font_medium().text_color(statusColor(f.status, t)).child(f.status))
        .child(div().flex_1().min_w(0).truncate().child(f.from ? `${f.from} → ${f.path}` : f.path))
        .child(div().flex_none().text_size(11).text_color(t.ansi2).child(f.binary ? "bin" : `+${f.add}`))
        .when(!f.binary, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))));
  }

  /**
   * One file's diff: a readonly Editor at the text's full height (the codeBlock trick), with a
   * tint over each run of added, deleted and hunk-header lines.
   */
  diffBlock(f, i, t, before) {
    const lh = lineHeight(this.codeFont), pad = Math.round(CODE_PAD * this.textZoom);
    const head = h_flex().id(`fp-dfile-${i}`).h(26).pl(10).pr(8).gap(8).items_center().border_b(1).border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openAt(i, cx))
      .child(div().w(12).flex_none().text_center().text_size(11).font_medium().text_color(statusColor(f.status, t)).child(f.status))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(f.from ? `${f.from} → ${f.path}` : f.path))
      .when(!f.binary, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)).child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
    const box = v_flex().w_full().flex_none().rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden().child(head);
    const note = (s, c = t.dim) => box.child(div().px(10).py(6).text_size(11.5).text_color(c).child(s));
    if (f.binary) return note("Binary file");
    if (!f.state) return f.diff?.cut || before >= hist.MAX_DIFF ? note("Diff not shown: the commit's line limit was reached", t.ansi3) : note("No content changes");
    const n = f.diff.lines.length, text = n * lh, slack = Math.max(text, 3 * lh);
    const color = (k) => (k === "a" ? t.ansi2 : k === "d" ? t.ansi1 : t.ansi4);
    // Old and new line numbers, GitLab style, each at its line's top (a text never breaks on "\n").
    const mono = typeof settings().font_family === "string" ? String(settings().font_family) : null;
    const nw = Math.ceil(f.nums.digits * this.codeFont * 0.62) + 12;
    const col = (rows) => div().w(nw).h(text).flex_none().relative().text_size(this.codeFont).text_color(t.dim)
      .when(Boolean(mono), (e) => e.font_family(mono))
      .children(rows.flatMap((r, i) => (r ? [h_flex().absolute().top(i * lh).left(0).right(6).h(lh).justify_end().child(r)] : [])));
    return box
      .child(div().w_full().h(text + 2 * pad).flex_none().py(pad)
        .child(div().w_full().h(text).overflow_hidden().relative()
          .child(h_flex().w_full().h(text + slack).flex_none().items_start()
            .child(h_flex().h(text).flex_none().mr(6).border_r(1).border_color(t.border).child(col(f.nums.old)).child(col(f.nums.now)))
            .child(div().flex_1().min_w(0).h(text + slack).child(Editor.new(f.state).size_full())))
          .children(f.runs.map((r) => div().absolute().left(0).right(0).top(r.from * lh).h(r.n * lh).bg(tint(color(r.kind), r.kind === "h" ? "1a" : "26") ?? t.hover)))
          .children(f.runs.filter((r) => r.kind !== "h").map((r) => div().absolute().left(0).w(3).top(r.from * lh).h(r.n * lh).bg(color(r.kind))))))
      .when(f.diff.cut, (el) => el.child(div().px(10).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.ansi3).child("Diff truncated")));
  }

  /** Over a file shown as of a commit: which commit, and the way back. */
  atBanner(t) {
    const a = this.atCommit;
    return h_flex().h(30).flex_none().w_full().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(tint(t.accent, "14") ?? t.raised).text_size(12)
      .child(div().flex_none().text_color(t.dim).child(a.deleted ? "before" : "at"))
      .child(div().flex_none().text_color(t.accent).child(a.short))
      .child(div().flex_none().text_color(t.dim).child("·"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${a.path} · ${a.subject}`))
      .child(h_flex().id("fp-at-back").h(22).px(6).flex_none().rounded(5).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.commitBack(cx)).text_color(t.accent).child("← back to commit"));
  }

  message(t, text, sub) {
    return v_flex().flex_1().items_center().justify_center().gap(6).text_color(t.dim)
      .child(div().text_size(14).child(text)).when(Boolean(sub), (el) => el.child(div().text_size(11.5).child(sub)));
  }

  /**
   * A fence: header (language, Copy) over a readonly Editor. A code Editor always lets its
   * text scroll past the end by max(half its height, 3 rows), so it is laid out that much
   * taller than its text inside a box clipped to the text: it never scrolls vertically, and
   * the wheel goes on to the document.
   */
  codeBlock(b, i, t) {
    const id = b.kind === "mmd" ? `${b.id}-src` : `code-${i}`, lh = lineHeight(this.codeFont), pad = Math.round(CODE_PAD * this.textZoom);
    const text = this.rows(b) * lh, slack = Math.max(text, 3 * lh);
    const copied = Boolean(b.copied);
    return v_flex().id(id).w_full().flex_none().rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden()
      .child(h_flex().h(24).pl(10).pr(3).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(lang.fenceLabel(b.kind === "mmd" ? "mermaid" : b.info)))
        .child(h_flex().id(`${id}-copy`).h(20).flex_none().px(5).gap(4).rounded(4).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.copyBlock(b, cx))
          .child(svg(ICON + (copied ? "check.svg" : "copy.svg")).size(13).text_color(copied ? t.done : t.muted))
          .when(copied, (el) => el.child(div().text_size(11).text_color(t.done).child("Copied")))))
      .child(div().w_full().h(text + 2 * pad).flex_none().py(pad)
        .child(div().w_full().h(text).overflow_hidden().relative()
          .child(div().w_full().h(text + slack).flex_none().child(Editor.new(b.state).size_full()))
          // Rows with matches, when rows are lines (no soft wrap).
          .when(Boolean(b.find) && !b.wrap, (e) => e.children(this.lineMarks(b.find.rows, lh, t, b.find.current ? b.find.at[b.find.k].line : -1)))));
  }

  /** The fences that show as code boxes, in document order (Mermaid sources only when shown). */
  codeBoxes() {
    return this.blocks.filter((b) => b.state && (b.kind === "code" || b.d?.error));
  }

  /** Copies a fence's text (without the fence lines); the button says "Copied" for a moment. */
  copyBlock(b, cx, text = b.text) {
    cx.write_to_clipboard(text);
    const mark = (b.copied ?? 0) + 1;
    b.copied = mark;
    cx.timer.after(COPIED_MS, (cx) => { if (b.copied !== mark) return; b.copied = 0; cx.notify(); });
    cx.notify();
  }

  diagramBlock(b, i, t) {
    const d = b.d ?? { pending: true };
    if (d.ok) {
      // Rendered at -s 2: half the PNG width is crisp; no h / w_full on the image. The box
      // reserves the final height, also while image() decodes the PNG.
      const s = this.diagramSize(d.w, d.h), n = this.blocks.filter((o) => o.kind === "mmd").indexOf(b);
      const right = Math.max(0, Math.floor(((this.colW ?? s.w) - s.w) / 2));   // the image's top-right corner
      return h_flex().id(b.id).w_full().h(s.h + 8).flex_none().justify_center().py(4).relative().child(image(d.path).w(s.w))
        .child(this.button(`${b.id}-expand`, "expand.svg", t, (_e, cx) => this.expandDiagram(n, cx)).absolute().top(4).right(right).bg(t.raised));
    }
    if (d.error && b.state) {
      return v_flex().id(b.id).w_full().flex_none().gap(6)
        .child(h_flex().w_full().px(10).py(6).gap(10).items_start().rounded(6).border_1().border_color(t.border).bg(t.raised).text_size(11.5)
          .child(div().flex_1().min_w(0).text_color(d.setup ? t.ansi3 : t.ansi1)
            .when(typeof settings().font_family === "string" && !d.setup, (el) => el.font_family(String(settings().font_family))).child(d.error))
          .child(div().id(`${b.id}-retry`).flex_none().cursor_pointer().text_color(t.accent).on_click((_e, cx) => this.retryDiagram(b, cx)).child("Retry")))
        .child(this.codeBlock(b, i, t));
    }
    // Pending: never ask image() for a PNG that doesn't exist yet (it would stay blank).
    // A diagram rendered before (sizes.json) reserves its final height; a new one, an estimate.
    const known = b.key ? this.mermaid.size(b.key) : null;
    return h_flex().id(b.id).w_full().h(known ? this.diagramSize(known.w, known.h).h + 8 : Math.round(Math.min(240, 40 + b.lines * 12) * this.textZoom)).flex_none().gap(8).items_center().justify_center()
      .rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.dim)
      .child(div().w(12).flex_none().text_color(t.accent).frames(SPIN, 90).child(SPIN[0]))
      .child("Rendering diagram…");
  }

  previewPane(t, narrow) {
    const doc = this.doc;
    let body;
    if (this.commitShown()) body = this.commitView(this.commit, t, narrow);
    else if (!this.file) body = this.message(t, "Select a file", "↑ ↓ move · → ← open/close folder · Enter open · Tab tree/preview · b show/hide tree · / find · + − 0 zoom · r reload" + (this.overlay ? " · Esc close" : ""));
    else if (!doc) body = this.message(t, "Loading…");
    else if (doc.kind === "markdown")
      body = v_flex().flex_1().min_h(0).child(this.notesBar(t)).child(v_flex().id(`doc:${this.file}`).flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().w_full().justify_center().px(narrow ? 12 : 24).py(narrow ? 12 : 20)
          .child(v_flex().id("fp-col").w_full().max_w(Math.round(COL_W * this.textZoom)).gap(Math.round(12 * this.textZoom)).text_size(this.proseSize())
            .on_size_change((size, cx) => { if (Math.round(size.width) !== this.colW) { this.colW = Math.round(size.width); cx.notify(); } })
            .children((() => {
              const placed = this.notes.place(this.noteKey(), this.blocks).at;
              return this.blocks.map((b, i) => b.kind === "md"
                ? this.annotated(b, i, t, placed[i] ?? [], this.marked(b, t, this.aimable(i,
                  TextView.markdown(`md-${i}`, this.markedText(b, t)).selectable(true).on_link_click((url, cx) => this.link(url, cx)))))
                : this.marked(b, t, b.kind === "mmd" ? this.diagramBlock(b, i, t) : this.codeBlock(b, i, t)));
            })()))));
    else if (doc.kind === "text" && this.code) body = this.codeView(t);
    else body = this.message(t, doc.message ?? "Cannot preview this file");
    return v_flex().id("fp-preview-pane").flex_1().min_w(0).h_full().min_h(0).bg(t.surface)
      .track_focus(this.previewFocus).on_key_down((e, cx) => this.onKey(e, cx, "preview"))
      .key_context(DOC_CONTEXT).on_action(FIND_OPEN, (_e, cx) => this.openDocFind(cx))
      .when(Boolean(this.atCommit), (el) => el.child(this.atBanner(t)))
      .when(Boolean(this.ds), (el) => el.child(this.findBar("doc", t)))
      .child(body);
  }

  // ---- annotations ----

  /**
   * The agents a draft can go to, all on the file's machine: the shown tab's, else every one
   * there (a popup opened on another machine's folder is not that tab's).
   */
  draftTargets() {
    const tab = activeTab(), on = this.ctx?.on ?? null;
    const sameMachine = (a) => (on ? a.address.startsWith(`${on}/`) : !a.address.includes("/"));
    const there = agents().filter(sameMachine);
    const inTab = there.filter((a) => a.tab === tab);
    return inTab.length ? inTab : there;
  }

  /** The comments of the open file, in document order, with their paragraph and section. */
  noteItems() {
    const key = this.noteKey();
    if (!key) return [];
    const { at, lost } = this.notes.place(key, this.blocks);
    const heads = headings(this.blocks);
    const items = [];
    this.blocks.forEach((b, i) => { for (const note of at[i] ?? []) items.push({ note, block: b, section: section(heads, b.start)?.text ?? null }); });
    for (const note of lost) items.push({ note, block: null, section: null });
    return items;
  }

  feedbackText(items) {
    const abs = this.tree.abs(this.file);
    return Notes.feedback(items, { name: this.file.split("/").pop(), where: this.ctx?.on ? `${this.ctx.on}:${abs}` : abs });
  }

  /** Copy: the feedback (unsent comments, else all) on the clipboard. */
  copyFeedback(cx) {
    const items = this.noteItems(), unsent = items.filter((x) => !x.note.sent);
    const use = unsent.length ? unsent : items;
    if (!use.length) return;
    cx.write_to_clipboard(this.feedbackText(use));
    this.noteStatus = { text: `Copied ${use.length} comment${use.length === 1 ? "" : "s"}`, until: Date.now() + 2500 };
    cx.notify();
    cx.timer.after(2600, (cx) => cx.notify());
  }

  /**
   * Draft: pastes the feedback into the agent's prompt without pressing Enter, for review there.
   * Clipboard → focus that terminal → terminal.paste (the clipboard keeps the text afterwards).
   */
  draftTo(agent, cx) {
    const items = this.noteItems(), unsent = items.filter((x) => !x.note.sent);
    const use = unsent.length ? unsent : items;
    if (!use.length || !agent) return;
    const key = this.noteKey();
    cx.write_to_clipboard(this.feedbackText(use));
    this.picking = false;
    if (this.overlay) closeOverlay(this.overlay);   // the popup would keep the keyboard
    run("pane.focus", { terminal: agent.address });
    run("terminal.paste");
    const to = `${agent.program?.name ?? agent.app ?? "agent"} · ${agent.tab_name || agent.space_name}`;
    this.noteStatus = { text: `Drafted into ${to}: review it there, then press Enter`, until: Date.now() + 6000 };
    cx.spawn(async (cx) => { await this.notes.markSent(key, use.map((x) => x.note.id), agent.address); cx.notify(); });
    cx.timer.after(6100, (cx) => cx.notify());
  }

  sendClick(cx) {
    const targets = this.draftTargets();
    if (targets.length === 1) return this.draftTo(targets[0], cx);
    if (!targets.length) {
      this.noteStatus = { text: "No agent in this tab: use Copy, or start one", until: Date.now() + 4000 };
      cx.timer.after(4100, (cx) => cx.notify());
    } else this.picking = !this.picking;
    cx.notify();
  }

  clearNotes(cx) {
    const key = this.noteKey();
    if (!key) return;
    this.picking = false;
    cx.spawn(async (cx) => { await this.notes.clear(key); cx.notify(); });
  }

  /** The bar over a commented document: count, Send to agent (a draft), Copy, Clear. */
  notesBar(t) {
    const items = this.noteItems();
    const status = this.noteStatus && this.noteStatus.until > Date.now() ? this.noteStatus.text : this.notes.error;
    if (!items.length && !status) return div();
    const unsent = items.filter((x) => !x.note.sent).length;
    const stop = (_e, cx) => cx.stop_propagation();
    const btn = (id, label, primary, go, tip) => h_flex().id(id).h(24).flex_none().px(10).items_center().rounded(5).cursor_pointer()
      .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.bg(t.accent).text_color(t.accent_foreground)))
      .when(!primary, (e) => e.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover)))
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .on_mouse_down("left", stop).on_click(go).child(div().text_size(12).child(label));
    const targets = this.picking ? this.draftTargets() : [];
    return v_flex().flex_none().w_full().border_b(1).border_color(t.border).bg(t.raised)
      .child(h_flex().w_full().h(38).px(12).gap(8).items_center()
        .child(div().flex_none().text_size(12).text_color(t.ansi3).child("💬"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(status ? t.foreground : t.muted)
          .child(status ?? (items.length ? `${items.length} comment${items.length === 1 ? "" : "s"}${unsent < items.length ? ` · ${items.length - unsent} drafted` : ""}` : "")))
        .when(items.length > 0, (e) => e
          .child(btn("fp-notes-send", unsent ? `Send to agent (${unsent})` : "Send again", true, (_e, cx) => this.sendClick(cx),
            "Pastes the comments into the agent's prompt without pressing Enter, so you can review them there"))
          .child(btn("fp-notes-copy", "Copy", false, (_e, cx) => this.copyFeedback(cx), "Copies the comments as feedback"))
          .child(btn("fp-notes-clear", "Clear", false, (_e, cx) => this.clearNotes(cx), "Deletes this file's comments"))))
      .when(targets.length > 0, (e) => e.child(v_flex().w_full().px(12).pb(8).gap(3)
        .child(div().text_size(11).text_color(t.dim).child("Draft into which agent?"))
        .children(targets.map((a) => h_flex().id(`fp-pick-${a.address}`).h(26).px(8).gap(8).items_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.draftTo(a, cx))
          .child(div().flex_none().text_size(12).text_color(t.foreground).child(a.program?.name ?? a.app ?? "Agent"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${a.space_name} · ${a.tab_name || ""} · ${a.address} · ${a.status}`))))));
  }

  /** The open file's key in the comments store: machine (or "local") and absolute path. */
  noteKey() { return this.file && this.tree?.root ? noteKey(this.ctx?.on, this.tree.abs(this.file)) : null; }

  /** Press / release / right-click handlers, on a paragraph's TextView (which may keep the press). */
  aimable(i, el) {
    return el
      .on_mouse_down("left", (e) => this.aimDown(i, e))
      .on_mouse_up("left", (e, cx) => this.aimUp(i, e, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openComment(i, cx); });
  }

  aimDown(i, e) {
    this.pressed = { i, when: Date.now(), x: Number(e?.position?.x) || 0, y: Number(e?.position?.y) || 0 };
  }

  /** A release: a drag of DRAG_PX or more offers "+ Comment" on the paragraph it started in. */
  aimUp(i, e, cx) {
    const down = this.pressed;
    this.pressed = null;
    if (!down || this.commenting) return;
    const x = Number(e?.position?.x) || 0, y = Number(e?.position?.y) || 0;
    if (Math.hypot(x - down.x, y - down.y) < DRAG_PX) return;
    this.aiming = { i: down.i };
    cx?.notify();
  }

  /** A press anywhere else puts the bar away (the bar and the field stop their own presses). */
  aimAway(cx) {
    if (this.pressed && Date.now() - this.pressed.when > 32) this.pressed = null;
    if (!this.aiming) return;
    this.aiming = null;
    cx?.notify();
  }

  /** The comment field on paragraph i: a new comment, or `edit` (a note) to change its words. */
  openComment(i, cx, edit = null) {
    const b = this.blocks[i];
    if (!b || b.kind !== "md" || !this.noteKey()) return;
    this.closeComment();
    const field = TextareaState.new({ placeholder: "What about this paragraph?", value: edit?.text ?? "" });
    field.set_auto_grow(2, 8);
    // Ctrl/Cmd-Enter saves (a secondary submit); Enter makes a new line.
    field.on("submit", (ev, cx) => { if (ev?.secondary === true) this.saveComment(cx); });
    this.commenting = { i, field, quote: quoteOf(b.text), edit };
    this.aiming = null; this.pressed = null;
    cx?.notify();
    cx?.spawn(async (cx) => { await cx.sleep(30); if (this.commenting?.field === field) { field.focus(); cx.notify(); } });
  }

  closeComment(cx) {
    const c = this.commenting;
    this.commenting = null;
    try { c?.field?.release?.(); } catch { /* already released */ }
    cx?.notify();
  }

  saveComment(cx) {
    const c = this.commenting, key = this.noteKey();
    if (!c || !key) return;
    const text = String(c.field.value() ?? "").trim(), b = this.blocks[c.i];
    this.closeComment(cx);
    if (!text || !b) return;
    if (c.edit) cx.spawn(async (cx) => { await this.notes.update(key, c.edit.id, text); cx.notify(); });
    else cx.spawn(async (cx) => { await this.notes.add(key, b, text); cx.notify(); });
  }

  deleteComment(id, cx) {
    const key = this.noteKey();
    if (!key) return;
    cx.spawn(async (cx) => { await this.notes.remove(key, id); cx.notify(); });
  }

  /** A paragraph with its comments: an accent bar, the "+ Comment" offer, the field, the notes. */
  annotated(b, i, t, notes, el) {
    const stop = (_e, cx) => cx.stop_propagation();
    const aiming = this.aiming?.i === i, writing = this.commenting?.i === i;
    const pill = (id, label, primary, go) => h_flex().id(id).h(22).flex_none().px(9).items_center().rounded(5).cursor_pointer()
      .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.bg(t.accent).text_color(t.accent_foreground)))
      .when(!primary, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", stop).on_click(go).child(div().text_size(11.5).child(label));
    return v_flex().id(`ann-${i}`).w_full().flex_none().relative()
      .on_mouse_down("left", (e) => this.aimDown(i, e))
      .on_mouse_up("left", (e, cx) => this.aimUp(i, e, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openComment(i, cx); })
      .child(el)
      // Commented, or being commented: a bar in the left padding, like a margin note.
      .when(notes.length > 0 || writing || aiming, (e) => e.child(div().absolute().top(0).bottom(0).left(-BAR_X - 2).w(3).rounded(2)
        .bg(notes.length ? t.ansi3 : t.accent)))
      .when(aiming, (e) => e.child(h_flex().mt(4).flex_none().gap(6).items_center()
        .child(pill(`ann-offer-${i}`, "+ Comment", true, (_e, cx) => this.openComment(i, cx)))
        .child(div().text_size(11).text_color(t.dim).child("on this paragraph"))))
      .when(notes.length > 0, (e) => e.child(v_flex().mt(6).gap(4).flex_none().children(notes.map((n) => h_flex().id(`note-${n.id}`)
        .w_full().px(8).py(5).gap(8).items_start().rounded(6).bg(t.raised).border_1().border_color(t.border)
        .on_mouse_down("left", stop)
        .when(Boolean(n.sent), (e) => e.opacity(0.6))
        .child(div().flex_none().text_size(11).text_color(n.sent ? t.ansi2 : t.ansi3).child(n.sent ? "✓" : "💬"))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(n.text))
        .when(Boolean(n.sent), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child("drafted")))
        .child(div().id(`note-e-${n.id}`).flex_none().px(4).cursor_pointer().text_size(11).text_color(t.dim).tooltip("Edit")
          .hover((s) => s.text_color(t.accent)).on_click((_e, cx) => this.openComment(i, cx, n)).child("✎"))
        .child(div().id(`note-x-${n.id}`).flex_none().px(4).cursor_pointer().text_size(11).text_color(t.dim).tooltip("Delete")
          .hover((s) => s.text_color(t.ansi1)).on_click((_e, cx) => this.deleteComment(n.id, cx)).child("✕"))))))
      .when(writing, (e) => e.child(v_flex().id(`ann-box-${i}`).w_full().mt(6).gap(5).p(7).flex_none().rounded(7)
        .bg(t.popover).border_1().border_color(t.accent)
        .on_mouse_down("left", stop).on_mouse_down("right", stop)
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(`On: "${this.commenting.quote}"`))
        .child(div().w_full().child(Textarea.new(this.commenting.field)))
        .child(h_flex().gap(4).items_center()
          .child(div().flex_1().text_size(10.5).text_color(t.dim).child(this.notes.error ?? "Ctrl+Enter to save"))
          .child(pill(`ann-cancel-${i}`, "Cancel", false, (_e, cx) => this.closeComment(cx)))
          .child(pill(`ann-ok-${i}`, this.commenting.edit ? "Save" : "Comment", true, (_e, cx) => this.saveComment(cx))))));
  }

  /** A Markdown block with its search marks, drawn in the column's side padding so nothing moves. */
  marked(b, t, el) {
    return v_flex().w_full().flex_none().relative().child(el)
      // Search: a bar in the right padding; the current block also gets a frame.
      .when(Boolean(b.find), (e) => e.child(div().absolute().top(0).bottom(0).right(b.find.current ? -BAR_X - 1 : -BAR_X).w(b.find.current ? 5 : 3).rounded(2).bg(t.accent)))
      .when(Boolean(b.find?.current), (e) => e.child(div().absolute().top(-4).bottom(-4).left(-4).right(-4).rounded(6).border_1().border_color(t.accent)));
  }

  /** How the code view lays out: "full" (line gutter, outer scroll) or "plain" (the Editor scrolls; ruler). */
  codeLayout() {
    if (!this.git || !this.doc || lang.wraps(lang.forPath(this.file ?? ""))) return "plain";
    return this.doc.lines <= FULL_MAX ? "full" : "plain";
  }

  /**
   * The whole-file Editor. In a repo it is laid out at its full height (taller than its text, so
   * it never scrolls itself) inside a scrolling box, next to a gutter of changed lines that
   * scrolls with it. Past FULL_MAX lines, or soft-wrapped, it keeps its own scroll and has no
   * gutter. Either way an overview ruler at the right edge shows the whole file's changes.
   */
  codeView(t) {
    const editor = Editor.new(this.code).size_full(), m = this.codeMarks, ds = this.ds;
    const hits = ds?.hits.length ? ds.hits : null, cur = hits ? hits[ds.at].line : 0;
    let body;
    if (this.codeLayout() === "plain") {
      body = div().flex_1().min_w(0).h_full().child(editor);
      if (!this.git && !hits) return div().flex_1().min_h(0).size_full().child(body);
    } else {
      const lh = lineHeight(this.codeFont), text = this.doc.lines * lh, slack = Math.max(text, 3 * lh);
      body = div().id(`code:${this.file}`).flex_1().min_w(0).h_full().overflow_y_scrollbar()
        .child(h_flex().w_full().h(text).flex_none().items_start()
          .child(div().w(GUTTER).h(text).flex_none().relative()
            .when(Boolean(m), (e) => e
              .children(m.runs.map((r) => div().absolute().left(3).w(3).top((r.from - 1) * lh).h(r.n * lh).bg(barColor(r.kind, t))))
              .children(m.dels.map((n) => svg(ICON + "deleted.svg").size(7).absolute().left(1).top(Math.max(0, Math.min(text - 7, n * lh - 3.5))).text_color(t.ansi1)))))
          .child(div().flex_1().min_w(0).h(text).overflow_hidden().relative()
            .child(div().w_full().h(text + slack).flex_none().child(editor))
            .when(Boolean(hits), (e) => e.children(this.lineMarks(hits.map((h) => h.line - 1), lh, t, cur - 1)))));
    }
    // Rows [from, from + n) as a share of the strip; the lower half hangs from the bottom so a
    // minimum height never pokes out of the strip.
    const rows = Math.max(1, this.doc.lines), pct = (n) => `${(100 * n) / rows}%`;
    const at = (el, from, n) => (2 * from + n <= rows ? el.top(pct(from)) : el.bottom(pct(rows - from - n)));
    return h_flex().flex_1().min_h(0).size_full().child(body)
      .when(Boolean(this.git), (el) => el.child(div().w(RULER).flex_none().h_full().relative().border_l(1).border_color(t.border)
        .when(Boolean(m), (e) => e
          .children(m.runs.map((r) => at(div().absolute().left(2).w(RULER - 4).h(pct(r.n)).min_h(4).rounded(1).bg(barColor(r.kind, t)), r.from - 1, r.n)))
          .children(m.dels.map((n) => at(div().absolute().left(1).w(RULER - 2).h(3).rounded(1).bg(t.ansi1), n, 0))))))
      // Search: a strip of its own, so its marks never cover the git ones.
      .when(Boolean(hits), (el) => el.child(div().w(RULER).flex_none().h_full().relative().border_l(1).border_color(t.border)
        .children(hits.map((h) => at(div().absolute().left(h.line === cur ? 0 : 2).w(h.line === cur ? RULER : RULER - 4).h(pct(1))
          .min_h(h.line === cur ? 4 : 2).bg(h.line === cur ? t.foreground : t.accent), h.line - 1, 1)))));
  }

  /**
   * Rows (from 0) with matches, aligned on the text: a tint across the row and a bar at the
   * right edge. `at`: the row of the current match, stronger.
   */
  lineMarks(rows, lh, t, at = -1) {
    const soft = tint(t.accent, "22"), strong = tint(t.accent, "44");
    return rows.flatMap((r) => {
      const on = r === at, out = [];
      const bg = on ? strong : soft;
      if (bg) out.push(div().absolute().left(0).right(0).top(r * lh).h(lh).bg(bg));
      out.push(div().absolute().right(0).w(on ? 4 : 2).top(r * lh).h(lh).bg(t.accent));
      return out;
    });
  }

  statusBar(t) {
    const doc = this.commitShown() ? null : this.doc, parts = [];
    if (this.commitShown()) parts.push(...this.commitParts());
    else if (this.file && (!doc || doc.kind === "markdown" || doc.kind === "text")) parts.push(lang.label(this.file));
    if (doc?.truncated) parts.push(`Truncated: showing the first ${(LIMIT / 1e6).toFixed(0)} MB${doc.size ? ` of ${(doc.size / 1e6).toFixed(1)} MB` : ""}`);
    if (doc?.kind === "markdown") {
      const n = this.blocks.filter((b) => b.kind === "code").length;
      if (n) parts.push(plural(n, "code block"));
      const m = this.blocks.filter((b) => b.kind === "mmd"), busy = m.filter((b) => b.d?.pending).length;
      if (m.length) parts.push(busy ? `Rendering ${plural(busy, "diagram")}…` : plural(m.length, "diagram"));
    }
    const where = this.docWhere();
    if (where) parts.push(`Find: ${where}`);
    if (this.note) parts.push(this.note);
    if (this.file && this.loadedAt && doc && doc.kind !== "missing" && !this.atCommit) parts.push(ago(this.loadedAt));
    if (this.ctx?.polling) parts.push("polling (folder too big to watch)");
    return h_flex().h(22).flex_none().px(10).gap(10).items_center().overflow_hidden().border_t(1).border_color(t.border).bg(t.chrome).text_size(11).text_color(t.dim)
      .when(this.loadingFile || this.loadingTree || this.blocks.some((b) => b.d?.pending) || Boolean(this.commit?.loading || this.ctx?.log?.loading), (el) => el.child(div().w(10).flex_none().text_color(t.accent).frames(SPIN, 90).child(SPIN[0])))
      .child(div().flex_none().max_w(480).truncate().text_color(this.file || this.commit ? t.muted : t.dim).child(this.statusName()))
      .children(parts.map((p) => div().flex_none().child("· " + p)))
      .child(div().flex_1())
      .child(div().flex_none().child(this.treeFocus.is_focused() ? "tree" : this.commitsFocus.is_focused() ? "commits" : this.changesFocus.is_focused() ? "changes" : this.previewFocus.is_focused() ? "preview" : ""));
  }
}
