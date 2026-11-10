// Reads one file for preview, here or on a remote machine.
import { exec, readTextFile, writeTextFile, hc, appHome } from "herdr";
import * as fs from "fs/promises";
import { isMarkdown } from "./lang.js";
import { sh, slash, localWindows } from "./shell.js";

export const LIMIT = 1000000; // characters shown; more is truncated with a notice

// Prints "<size> <bytes in the first 8 KiB> <same without NULs>"; exit 3 when unreadable.
const PROBE = 'test -r "$1" || exit 3; s=$(wc -c < "$1"); n=$(head -c 8192 "$1" | wc -c); m=$(head -c 8192 "$1" | tr -d "\\000" | wc -c); echo $s $n $m';
const HEAD = 'head -c "$2" "$1"';
// "<mtime> <size>" with GNU stat, else BSD/macOS stat.
const STAT = 'stat -c "%Y %s" "$1" 2>/dev/null || stat -f "%m %z" "$1"';

/** A cheap change stamp for polling: "<mtime> <size>", or "missing". Rejects when the machine is unreachable. */
export async function stamp(path, on) {
  const r = await sh(STAT, ["fp", path], { on });
  return r.code === 0 ? r.stdout.trim() : "missing";
}

/**
 * -> { kind: "missing" | "binary" | "error", message }
 *  | { kind: "markdown" | "text", text, truncated, size? }
 */
export async function readSource(path, on) {
  let text;
  try {
    text = await readTextFile(path, { on });
  } catch {
    // Not UTF-8, or past readTextFile's 1 MiB: find out which with one small script.
    return probe(path, on);
  }
  if (text === null) return { kind: "missing", message: "This file no longer exists" };
  return classify(path, text, false);
}

export function classify(path, text, cut) {
  if (text.includes("\0")) return { kind: "binary", message: "Binary file · no preview" };
  let truncated = cut;
  if (text.length > LIMIT) {
    const nl = text.lastIndexOf("\n", LIMIT);
    text = text.slice(0, nl > LIMIT / 2 ? nl : LIMIT);
    truncated = true;
  }
  return { kind: isMarkdown(path) ? "markdown" : "text", text, truncated };
}

async function probe(path, on) {
  const r = await sh(PROBE, ["fp", path], { on }).catch(() => null);
  if (!r) return { kind: "error", message: "Cannot read this file (machine unreachable?)" };
  if (r.code === 3) return { kind: "error", message: "No permission to read this file" };
  const [size, n, m] = r.stdout.trim().split(/\s+/).map(Number);
  if (r.code !== 0 || !Number.isFinite(size)) return { kind: "error", message: (r.stderr || "Cannot read this file").trim().slice(0, 200) };
  if (n !== m) return { kind: "binary", message: "Binary file · no preview" };
  if (size <= LIMIT) return { kind: "binary", message: "Not UTF-8 text · no preview" };
  const h = await sh(HEAD, ["fp", path, String(LIMIT)], { on }).catch(() => null);
  if (!h || h.code !== 0) return { kind: "error", message: "Cannot read this file" };
  const out = classify(path, h.stdout, true);
  if (out.kind !== "binary") out.size = size;
  return out;
}

// ---- saving (edit mode) ----------------------------------------------------------
//
// Local: writeTextFile writes only while the file still holds the text editing started from,
// and swaps it in atomically.
//
// Remote, first choice: the text goes into a private temporary file here, and `hc put` sends
// it over herdr-core's own connection beside a terminal on that machine (herdr-core's state
// folder there, private to the account). No file text is ever an argument, there or here.
// Then one script there (COMMIT) checks the file is still what editing started from (cksum:
// CRC and size, POSIX everywhere), copies the text into a private temporary file next to the
// original, keeps the mode and renames it into place, and deletes what `hc put` left.
//
/// Remote, fallback (no live terminal on that machine, or `hc put` failed), only when the
// caller allows it (`args`: the user was asked): exec has no stdin, so the text goes as base64
// in pieces, each an argument of `sh -c`, into a temporary file, then the same COMMIT. Other
// accounts there can read those arguments from the process list while it runs (README:
// Security).
//
// Every temporary file there comes from mktemp under umask 077: a name nobody can plant a
// symlink at beforehand, and never readable by others, whatever the original's mode.

// Base64 characters per exec: under Windows' 32 KiB command line, for a Windows host too.
const PIECE = 24000;
const TOKEN = '{ cksum < "$1"; } 2>/dev/null || echo missing';
// $1: the temporary file's path without its random end; in the temp folder when the file's
// own folder can't be written to. Prints the path made.
const MKTEMP = 'umask 077; mktemp "$1.XXXXXX" 2>/dev/null || mktemp "${TMPDIR:-/tmp}/fp.XXXXXX"';
const PUT_MORE = 'printf %s "$2" >> "$1"';
// $1 file, $2 what came over (base64, or the raw text with $4 = raw), $3 expected token
// ("" = don't check). Removes $2 on every exit. Prints the new token.
const COMMIT = [
  'f=$1; b=$2; o=; u=$(umask); umask 077; d=$(dirname "$f")',
  'fail() { rm -f "$b"; [ -z "$o" ] || rm -f "$o"; exit "$1"; }',
  'if [ -n "$3" ]; then now=$({ cksum < "$f"; } 2>/dev/null || echo missing); [ "$now" = "$3" ] || fail 4; fi',
  // A read-only file stays as it is (a rename would replace it all the same).
  '[ ! -e "$f" ] || [ -w "$f" ] || fail 8',
  // Next to the original, so the rename stays on one filesystem (atomic); in the temp folder
  // (r empty: no rename) when the original's folder can't be written to.
  'r=1; o=$(mktemp "$d/.$(basename "$f").fp.XXXXXX" 2>/dev/null) || { r=; o=$(mktemp "${TMPDIR:-/tmp}/fp.XXXXXX" 2>/dev/null) || { o=; fail 7; }; }',
  'if [ "$4" = raw ]; then cat "$b" > "$o" || fail 7; else { base64 -d < "$b" > "$o" || base64 -D < "$b" > "$o"; } 2>/dev/null || fail 5; fi',
  // Written through (not atomic) instead of renamed over: a symlink (it stays one), a file with
  // other hard links (they keep seeing it), another account's file (it stays theirs, with
  // its ACLs) and a file in a folder we can't write to. Renaming would cut the link or hand
  // the file to us.
  'n=$(stat -c %h "$f" 2>/dev/null || stat -f %l "$f" 2>/dev/null || echo 1)',
  'if [ -z "$r" ] || [ -L "$f" ] || { [ -e "$f" ] && { [ ! -O "$f" ] || [ "$n" != 1 ]; }; }; then cat "$o" > "$f" || fail 6; rm -f "$b" "$o"; else',
  // The original's mode; a new file gets what the account's own umask gives. If neither
  // can be worked out the file stays 0600: tighter, never looser.
  '  if [ -e "$f" ]; then chmod "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" "$o" 2>/dev/null',
  '  else chmod "$(printf %o $((0666 & ~0$u)))" "$o" 2>/dev/null; fi',
  '  mv -f "$o" "$f" || fail 6; rm -f "$b"; fi',
  'cksum < "$f"',
].join("\n");
// What `hc put` left under herdr-core's state folder when its answer couldn't be used. $1: the
// uploaded file's (random) name.
const PUT_SWEEP = 'for p in "${XDG_STATE_HOME:-$HOME/.local/state}"/herdr-core/*/files/*/"$1"; do [ ! -f "$p" ] || rm -f "$p"; done';

/** Raised when the file on disk is no longer what editing started from. */
export class Conflict extends Error {
  constructor() { super("The file changed on disk"); this.conflict = true; }
}

/** Remote: the file's change token ("<crc> <size>" or "missing"); null on a local file. */
export async function editToken(path, on) {
  if (!on) return null;
  const r = await sh(TOKEN, ["fp", path], { on });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Remote: the token of the file while it holds `text`. The token is taken before and after
 * reading the file, and counts only when both agree and the text read is `text`: a token
 * asked for on its own could be of a version written after `text` was read, and a save
 * checked against it would overwrite that version.
 * Resolves with { token } (null: couldn't tell), or { token: null, now } when the file holds
 * something else (`now`: its text, null when it is gone). Rejects when the file can't be read.
 */
export async function tokenFor(path, on, text) {
  for (let i = 0; i < 2; i++) {
    const before = await editToken(path, on);
    if (!before) return { token: null };
    const now = await readTextFile(path, { on });
    if (now !== text) return { token: null, now };
    if (await editToken(path, on) === before) return { token: before };
  }
  return { token: null };
}

/**
 * Saves `text` to `path`. Local: only if the file still equals `base` (null: whatever it holds).
 * Remote: only if its token still equals `token` (null: don't check). `via`: a live terminal
 * on that machine (`spark/t19`) for `hc put`. Without one, or when it fails, the text can only
 * go as command-line arguments: done when `args` allows it, else the save rejects with an
 * Error whose `needArgs` is true (nothing was written).
 * Resolves with { token, how } (token: remote's new one, else null; how: "local" | "put" |
 * "pieces"); rejects with Conflict when the file moved on, else with an Error.
 */
export async function saveText(path, text, { on, base, token, via = null, args = false }) {
  if (!on) {
    let expected = base;
    if (expected === null) expected = await readTextFile(path).catch(() => null);
    try { await writeTextFile(path, text, expected); }
    catch (e) {
      const now = await readTextFile(path).catch(() => undefined);
      if (now !== undefined && now !== expected) throw new Conflict();
      throw new Error(String(e?.message ?? e).replace(/^`?herdr\.writeTextFile`?:\s*/, ""));
    }
    return { token: null, how: "local" };
  }
  text = wellFormed(text);
  let why = "no terminal is open on that machine";
  if (via) {
    let landed = null;
    try { landed = await putThere(text, via, on); } catch (e) { why = String(e?.message ?? e); }
    if (landed) return { token: await commit(path, landed, token, on, true), how: "put" };
  }
  if (!args) throw Object.assign(new Error(why), { needArgs: true });
  return { token: await sendPieces(path, text, token, on), how: "pieces" };
}

/**
 * `hc put`: the text as a file beside terminal `via`, over herdr-core. Resolves with where it
 * landed there; rejects when it couldn't. The file here is removed whatever happens, and so is
 * a copy that landed there but can't be used.
 */
async function putThere(text, via, on) {
  const dir = slash(appHome(), null).replace(/\/+$/, "") + "/mods/squid-ink/.cache/put/";
  await fs.mkdir(dir, { recursive: true });
  const name = `fp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}.txt`;
  const local = dir + name;
  let sent = false, landed = null;
  try {
    await fs.writeFile(local, text, { encoding: "utf8", mode: 0o600 });
    sent = true;
    const r = await hc(["put", "--json", via, local]);
    if (r.code !== 0) {
      const said = (r.stderr || r.stdout || "").trim();
      let message = null;
      try { message = JSON.parse(said)?.error?.message; } catch {}   // --json: errors are JSON too
      throw new Error(`hc put: ${String(message || said || "failed").slice(0, 200)}`);
    }
    let out;
    try { out = JSON.parse(r.stdout); } catch { throw new Error("hc put: unreadable answer"); }
    if (typeof out?.path !== "string" || !out.path.startsWith("/")) throw new Error("hc put: no path");
    landed = out.path;
    if (out.bytes !== utf8Bytes(text)) throw new Error(`hc put: ${out.bytes} bytes arrived, ${utf8Bytes(text)} sent`);
    return landed;
  } catch (e) {
    if (landed) await sh('rm -f "$1"', ["fp", landed], { on }).catch(() => {});
    else if (sent) await sh(PUT_SWEEP, ["fp", name], { on }).catch(() => {});
    throw e;
  } finally {
    await fs.unlink(local).catch(() => {});
  }
}

/** The fallback: base64 pieces as arguments into a private temporary file, then COMMIT. */
async function sendPieces(path, text, token, on) {
  const b64 = base64(text);
  const slashAt = path.lastIndexOf("/");
  const made = await sh(MKTEMP, ["fp", `${path.slice(0, slashAt + 1)}.${path.slice(slashAt + 1)}.fp`], { on });
  const tmp = made.code === 0 ? made.stdout.trim() : "";
  if (!tmp) throw new Error((made.stderr || "Cannot write there").trim().slice(0, 200));
  try {
    for (let i = 0; i < b64.length; i += PIECE) {
      const p = await sh(PUT_MORE, ["fp", tmp, b64.slice(i, i + PIECE)], { on });
      if (p.code !== 0) throw new Error((p.stderr || "Cannot write there").trim().slice(0, 200));
    }
  } catch (e) {
    await sh('rm -f "$1"', ["fp", tmp], { on }).catch(() => {});
    throw e;
  }
  return commit(path, tmp, token, on, false);
}

/**
 * COMMIT on `tmp` (which it removes on every exit). A call that never came back (the
 * connection dropped) removes it from here, as far as it can.
 */
async function commit(path, tmp, token, on, raw) {
  let r;
  try { r = await sh(COMMIT, ["fp", path, tmp, token ?? "", raw ? "raw" : ""], { on }); }
  catch (e) {
    await sh('rm -f "$1"', ["fp", tmp], { on }).catch(() => {});
    throw e;
  }
  if (r.code === 4) throw new Conflict();
  if (r.code === 5) throw new Error("Cannot decode on that machine (base64 missing?)");
  if (r.code === 6 || r.code === 7) throw new Error("Cannot write there");
  if (r.code === 8) throw new Error("The file is read-only");
  if (r.code !== 0) throw new Error((r.stderr || "Cannot save the file there").trim().slice(0, 200));
  return r.stdout.trim() || null;
}

/** `text` with every lone surrogate as U+FFFD: what UTF-8 can hold (and what gets written). */
function wellFormed(text) {
  if (typeof text.toWellFormed === "function") return text.toWellFormed();
  let out = "";
  for (const ch of text) out += ch.length === 1 && ch >= "\ud800" && ch <= "\udfff" ? "�" : ch;
  return out;
}

/** UTF-8 length in bytes, what `hc put` reports. */
function utf8Bytes(text) {
  let n = 0;
  for (const ch of text) {            // by code point; a lone surrogate is written as U+FFFD
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** UTF-8 safe base64 (the mod runtime has no TextEncoder or Buffer). */
function base64(text) {
  const bin = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = [];
  for (let i = 0; i < bin.length; i += 3) {
    const a = bin.charCodeAt(i), b = bin.charCodeAt(i + 1) || 0, c = bin.charCodeAt(i + 2) || 0;
    const n = (a << 16) | (b << 8) | c;
    out.push(A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bin.length ? A[(n >> 6) & 63] : "=") + (i + 2 < bin.length ? A[n & 63] : "="));
  }
  return out.join("");
}

// ---- line endings (edit mode) ----
//
// The Editor holds LF text. A file's lines keep the endings they had: lines before and after
// the edited stretch keep their own, the stretch itself takes the file's usual one. So a file
// with both kinds isn't rewritten end to end by a one-line edit.

/** `s` with every CRLF as LF. */
export function lf(s) {
  return s.includes("\r") ? s.replace(/\r\n/g, "\n") : s;
}

/** How `base` ends its lines, for withEols(). */
export function eolPlan(base) {
  if (!base.includes("\r\n")) return { crlf: false };
  const parts = base.split("\n"), last = parts.length - 1, lines = [], eols = [];
  let crlf = 0;
  for (let i = 0; i <= last; i++) {
    const cr = i < last && parts[i].endsWith("\r");
    lines.push(cr ? parts[i].slice(0, -1) : parts[i]);
    if (i < last) eols.push(cr ? "\r\n" : "\n");
    if (cr) crlf++;
  }
  return { crlf: true, mixed: crlf < eols.length, main: crlf * 2 >= eols.length ? "\r\n" : "\n", lines, eols };
}

/** LF `text` with line endings after `plan` (eolPlan of the text it was edited from). */
export function withEols(text, plan) {
  if (!plan.crlf) return text;
  if (!plan.mixed) return text.replace(/\n/g, "\r\n");
  const now = text.split("\n"), was = plan.lines, n = now.length, m = was.length;
  let head = 0, tail = 0;
  while (head < n && head < m && now[head] === was[head]) head++;
  while (tail < n - head && tail < m - head && now[n - 1 - tail] === was[m - 1 - tail]) tail++;
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const j = i < head ? i : i >= n - tail ? i - n + m : -1;   // the same line in `was`
    out.push(now[i], j >= 0 && j < m - 1 ? plan.eols[j] : plan.main);
  }
  out.push(now[n - 1]);
  return out.join("");
}
