// Mermaid fences rendered to PNG with mermaid-cli, always on this machine.
// One render at a time (each starts a Chromium); results live in the hidden .cache/ folder,
// which doesn't trigger a mod reload.
import { exec, home, appHome } from "herdr";
import * as fs from "fs/promises";
import { sh, slash, localWindows } from "./shell.js";

// Set to an absolute mmdc path to skip the lookup (node beside it is used when present).
const MMDC = "";
// Dev: skip the fnm / PATH / login-shell lookup, so a bogus MMDC exercises the fallback.
const NO_LOOKUP = false;

const REL = "mods/file-preview/.cache/";      // image() paths are relative to ~/.config/herdr-app
const TIMEOUT = 20000, KEEP = 200;
const SIZES = "sizes.json", MAX_SIZES = 2 * KEEP;   // PNG sizes, so a re-render's placeholder has the final height

export const MISSING = "Install @mermaid-js/mermaid-cli to render diagrams";
export const NO_BROWSER = "Mermaid needs Google Chrome or Chromium";

const BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
// $PUPPETEER_EXECUTABLE_PATH, then the given paths (also under ~/Applications), then Linux names.
const FIND_BROWSER = 'for p in "$PUPPETEER_EXECUTABLE_PATH" "$@"; do [ -n "$p" ] && [ -x "$p" ] && { printf %s "$p"; exit 0; }; ' +
  'case "$p" in /Applications/*) q="$HOME$p"; [ -x "$q" ] && { printf %s "$q"; exit 0; };; esac; done; ' +
  'for n in google-chrome google-chrome-stable chromium chromium-browser; do command -v "$n" && exit 0; done; exit 1';
// Prints "<mmdc>\n<node or empty>" for a path or a bare name; exit 3 when it isn't there.
const LOCATE = 'm=$(command -v "$1") || exit 3; [ -x "$m" ] || exit 3; d=$(dirname "$m"); printf "%s\\n" "$m"; [ -x "$d/node" ] && printf %s "$d/node"; exit 0';
// Keeps the KEEP newest PNGs (and their .mmd), plus the KEEP newest stray .mmd files.
const PRUNE = 'cd "$1" 2>/dev/null || exit 0; ls -t -- *.png 2>/dev/null | tail -n +$(($2 + 1)) | while IFS= read -r f; do rm -f -- "$f" "${f%.png}.mmd"; done; ' +
  'ls -t -- *.mmd 2>/dev/null | tail -n +$(($2 + 1)) | while IFS= read -r f; do [ -e "${f%.mmd}.png" ] || rm -f -- "$f"; done';

const dir = () => appHome() + "/" + REL;

/** 32-bit FNV-1a as 8 hex digits. */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export const themeOf = (dark) => (dark ? "dark" : "default");
export const cacheKey = (source, theme) => fnv1a(source + "|" + theme);
export const imagePath = (key) => REL + key + ".png";
/** Key of a render at another -s scale; scale 2 keeps the plain key. */
export const scaledKey = (key, scale) => (scale === 2 ? key : `${key}-s${scale}`);

function pngSize(u8) {
  const be = (o) => ((u8[o] << 24) >>> 0) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3];
  return u8.length > 24 && u8[1] === 80 && u8[2] === 78 && u8[3] === 71 ? { w: be(16), h: be(20) } : null;
}

/** mmdc's stderr without the stack: the message and the parser's pointer lines. */
function trimError(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (/^\s+at /.test(line) || /\((https?|file):\/\//.test(line)) break;
    if (line.trim() || out.length) out.push(line.replace(/\s+$/, ""));
  }
  while (out.length && !out[out.length - 1]) out.pop();
  const msg = out.slice(0, 8).join("\n").trim();
  return (msg.length > 600 ? msg.slice(0, 600) + "…" : msg) || "Mermaid could not render this diagram";
}

/**
 * One per mod copy. request() answers through each waiter's done(result, cx), where result is
 * { ok: true, path, w, h } | { error, setup?: true }. Waiters whose alive() turns false are skipped.
 */
export class Mermaid {
  constructor() {
    this.tool = null;          // Promise<{ cmd, pre, pp } | { error }>, resolved once
    this.known = new Map();    // key -> result (renders and real errors; never timeouts)
    this.jobs = new Map();     // key -> { key, source, waiters } queued or running
    this.queue = [];
    this.busy = false;
    this.closed = false;
    this.sizes = new Map();    // key -> { w, h } of every PNG seen, persisted in .cache/sizes.json
    this.ready = fs.readFile(dir() + SIZES, "utf8").then((t) => {
      for (const [k, v] of Object.entries(JSON.parse(t))) if (v?.w > 0 && v?.h > 0) this.sizes.set(k, { w: v.w, h: v.h });
    }).catch(() => {});
    this.saving = Promise.resolve();
  }

  close() { this.closed = true; this.queue = []; this.jobs.clear(); }

  /** Called once at copy start: LRU-ish by mtime (cache hits are touched). */
  prune() {
    return sh(PRUNE, ["fp", dir(), String(KEEP)]).catch(() => {});
  }

  /** A result already known this session, or null. */
  cached(key) { return this.known.get(key) ?? null; }

  pending() { return this.jobs.size; }

  /** Pixel size of the key's PNG, from this or an earlier session; null when never seen. */
  size(key) { return this.sizes.get(key) ?? null; }

  /** Before first paint: PNGs already on disk become known, so they show without a placeholder. */
  async prepare(keys) {
    await this.ready;
    for (const key of keys) {
      if (this.closed) return;
      if (this.known.has(key) || this.jobs.has(key)) continue;
      const hit = await this.load(key).catch(() => null);
      if (hit) this.known.set(key, hit);
    }
  }

  /** Retry of a setup notice: forget the mmdc / browser lookup and every setup error. */
  retrySetup() {
    this.tool = null;
    for (const [k, v] of this.known) if (v.setup) this.known.delete(k);
  }

  /** Retry of a render error: forget it, so the next request renders again. */
  forget(key) { if (this.known.get(key)?.error) this.known.delete(key); }

  /** d = { key, source, theme: "dark" | "default", scale? } (scale defaults to 2) */
  request(d, waiter, cx) {
    if (this.closed) return;
    const key = d.key;
    const hit = this.known.get(key);
    if (hit) return waiter.done(hit, cx);
    const job = this.jobs.get(key);
    if (job) { job.waiters.push(waiter); return; }
    const j = { ...d, waiters: [waiter] };
    this.jobs.set(key, j);
    this.queue.push(j);
    this.pump(cx);
  }

  pump(cx) {
    if (this.busy || this.closed) return;
    let job;
    while ((job = this.queue.shift()) && !job.waiters.some((w) => w.alive())) this.jobs.delete(job.key);
    if (!job) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      let finish = null;
      const answer = (res) => {
        if (!this.jobs.has(job.key)) return;
        this.jobs.delete(job.key);
        if (!res.timeout) this.known.set(job.key, res);
        for (const w of job.waiters) if (w.alive()) w.done(res, cx);
      };
      try { finish = await this.run(job, cx, answer); }
      catch (e) { answer({ error: String(e?.message ?? e) }); }
      // A timed-out mmdc keeps running until exec's own limit: wait, so only one Chromium runs.
      if (finish) await finish.catch(() => {});
      this.busy = false;
      this.pump(cx);
    });
  }

  /** Renders one job, answering as soon as it is known. Returns the still-running exec on a timeout. */
  async run(job, cx, answer) {
    // Already on disk (an earlier session, another copy): no mmdc or browser needed.
    const done = await this.load(job.key);
    if (done) { answer(done); return null; }
    const tool = await (this.tool ??= this.resolve());
    if (tool.error) { answer({ error: tool.error, setup: true }); return null; }
    const base = dir() + job.key, png = base + ".png";
    await fs.writeFile(base + ".mmd", job.source);
    const args = [...tool.pre, "-i", base + ".mmd", "-o", png, "-t", job.theme, "-b", "transparent", "-s", String(job.scale ?? 2), "-q", "-p", tool.pp];
    const proc = exec(tool.cmd, args).then((r) => ({ r }), (e) => ({ e }));
    let timer;
    const late = new Promise((ok) => { timer = cx.timer.after(TIMEOUT, () => ok({ timeout: true })); });
    const first = await Promise.race([proc, late]);
    timer.cancel();
    if (first.timeout) { answer({ error: `Rendering took longer than ${TIMEOUT / 1000} s`, timeout: true }); return proc; }
    if (first.e) { answer({ error: `Cannot run mmdc: ${String(first.e.message ?? first.e)}` }); return null; }
    if (first.r.code !== 0) { answer({ error: trimError(first.r.stderr || first.r.stdout) }); return null; }
    answer((await this.load(job.key)) ?? { error: "mmdc finished without writing a PNG" });
    return null;
  }

  /** A PNG already in .cache/, with its size from IHDR; null when absent. */
  async load(key) {
    const abs = dir() + key + ".png";
    if (!(await fs.exists(abs).catch(() => false))) return null;
    const size = pngSize(await fs.readFile(abs));
    if (!size) return null;
    exec("touch", [abs]).catch(() => {});   // keeps it among the newest for prune()
    this.remember(key, size);
    return { ok: true, path: imagePath(key), w: size.w, h: size.h };
  }

  /** Records a PNG size; sizes.json keeps the MAX_SIZES most recent. */
  remember(key, size) {
    const old = this.sizes.get(key);
    if (old && old.w === size.w && old.h === size.h) return;
    this.sizes.delete(key);
    this.sizes.set(key, { w: size.w, h: size.h });
    while (this.sizes.size > MAX_SIZES) this.sizes.delete(this.sizes.keys().next().value);
    this.saving = this.saving.then(async () => {
      await fs.mkdir(dir(), { recursive: true });
      await fs.writeFile(dir() + SIZES, JSON.stringify(Object.fromEntries(this.sizes)));
    }).catch(() => {});
  }

  /** node + mmdc, then a browser for puppeteer. */
  async resolve() {
    let tool = MMDC ? await locate(MMDC) : null;
    if (!tool && !NO_LOOKUP) tool = (await locate(home() + "/.local/share/fnm/aliases/default/bin/mmdc")) ?? (await locate("mmdc")) ?? (await viaShell());
    if (!tool) return { error: MISSING };
    const b = await sh(FIND_BROWSER, ["fp", ...BROWSERS]).catch(() => null);
    const browser = b?.code === 0 ? b.stdout.trim().split("\n")[0] : "";
    if (!browser) return { error: NO_BROWSER };
    await fs.mkdir(dir(), { recursive: true });
    const pp = dir() + "puppeteer.json";
    await fs.writeFile(pp, JSON.stringify({ executablePath: browser, headless: "shell" }));
    return { ...tool, pp, browser };
  }
}

/** { cmd, pre } that runs mmdc, verified with --version; null when it doesn't run. */
async function locate(path) {
  const r = await sh(LOCATE, ["fp", path]).catch(() => null);
  if (!r || r.code !== 0) return null;
  const [mmdc, node] = r.stdout.split("\n");
  // node beside mmdc: no reliance on the shebang finding node on exec's minimal PATH.
  const tool = node ? { cmd: node, pre: [mmdc] } : { cmd: mmdc, pre: [] };
  const v = await exec(tool.cmd, [...tool.pre, "--version"]).catch(() => null);
  return v?.code === 0 ? { ...tool, version: v.stdout.trim() } : null;
}

/** Last resort: a login shell's PATH (fnm in fish gives a per-session path, valid while it lives). */
async function viaShell() {
  const s = await exec("sh", ["-c", 'printf %s "$SHELL"']).catch(() => null);
  const shells = ["fish", "/opt/homebrew/bin/fish", "/usr/local/bin/fish"];
  if (s?.stdout && !shells.includes(s.stdout)) shells.push(s.stdout);
  for (const sh of shells) {
    const r = await exec(sh, ["-lic", "command -v mmdc"]).catch(() => null);
    const path = r?.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("/"));
    if (path) { const tool = await locate(path); if (tool) return tool; }
  }
  return null;
}
