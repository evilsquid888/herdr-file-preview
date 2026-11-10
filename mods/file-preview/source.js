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
// Remote, fallback (no live terminal on that machine, or `hc put` failed): exec has no stdin,
// so the text goes as base64 in pieces, each an argument of `sh -c`, into a temporary file
// next to the original, then the same COMMIT. Other accounts there can read those arguments
// from the process list while it runs (README: Security).
//
// Every temporary file there comes from mktemp under umask 077: a name nobody can plant a
// symlink at beforehand, and never readable by others, whatever the original's mode.

// Base64 characters per exec: under Windows' 32 KiB command line, for a Windows host too.
const PIECE = 24000;
const TOKEN = '{ cksum < "$1"; } 2>/dev/null || echo missing';
// $1: the temporary file's path without its random end. Prints the path made.
const MKTEMP = 'umask 077; mktemp "$1.XXXXXX"';
const PUT_MORE = 'printf %s "$2" >> "$1"';
// $1 file, $2 what came over (base64, or the raw text with $4 = raw), $3 expected token
// ("" = don't check). Removes $2 on every exit. Prints the new token.
const COMMIT = [
  'f=$1; b=$2; o=; u=$(umask); umask 077',
  'fail() { rm -f "$b"; [ -z "$o" ] || rm -f "$o"; exit "$1"; }',
  'if [ -n "$3" ]; then now=$({ cksum < "$f"; } 2>/dev/null || echo missing); [ "$now" = "$3" ] || fail 4; fi',
  // Next to the original, so the rename stays on one filesystem (atomic).
  'o=$(mktemp "$(dirname "$f")/.$(basename "$f").fp.XXXXXX" 2>/dev/null) || { o=; fail 7; }',
  'if [ "$4" = raw ]; then cat "$b" > "$o" || fail 7; else { base64 -d < "$b" > "$o" || base64 -D < "$b" > "$o"; } 2>/dev/null || fail 5; fi',
  // Written through (not atomic) instead of renamed over: a symlink (it stays one), a file with
  // other hard links (they keep seeing it) and another account's file (it stays theirs, with
  // its ACLs). Renaming would cut the link or hand the file to us.
  'n=$(stat -c %h "$f" 2>/dev/null || stat -f %l "$f" 2>/dev/null || echo 1)',
  'if [ -L "$f" ] || { [ -e "$f" ] && { [ ! -O "$f" ] || [ "$n" != 1 ]; }; }; then cat "$o" > "$f" || fail 6; rm -f "$b" "$o"; else',
  // The original's mode; a new file gets what the account's own umask gives. If neither
  // can be worked out the file stays 0600: tighter, never looser.
  '  if [ -e "$f" ]; then chmod "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" "$o" 2>/dev/null',
  '  else chmod "$(printf %o $((0666 & ~0$u)))" "$o" 2>/dev/null; fi',
  '  mv -f "$o" "$f" || fail 6; rm -f "$b"; fi',
  'cksum < "$f"',
].join("\n");

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
 * Saves `text` to `path`. Local: only if the file still equals `base` (null: whatever it holds).
 * Remote: only if its token still equals `token` (null: don't check). `via`: a live terminal
 * on that machine (`spark/t19`) for `hc put`; without one, or when it fails, base64 pieces.
 * Resolves with { token, how } (token: remote's new one, else null; how: "local" | "put" |
 * "pieces"); rejects with Conflict when the file moved on, else with an Error.
 */
export async function saveText(path, text, { on, base, token, via = null }) {
  if (!on) {
    let expected = base;
    if (expected === null) expected = await readTextFile(path).catch(() => null);
    try { await writeTextFile(path, text, expected); }
    catch (e) {
      const now = await readTextFile(path).catch(() => undefined);
      if (now !== undefined && now !== expected) throw new Conflict();
      throw new Error(String(e?.message ?? e));
    }
    return { token: null, how: "local" };
  }
  const landed = via ? await putThere(text, via).catch(() => null) : null;
  if (landed) return { token: await commit(path, landed, token, on, true), how: "put" };
  return { token: await sendPieces(path, text, token, on), how: "pieces" };
}

/**
 * `hc put`: the text as a file beside terminal `via`, over herdr-core. Resolves with where it
 * landed there; rejects when it couldn't (the caller falls back to pieces). The file here is
 * removed whatever happens.
 */
async function putThere(text, via) {
  const dir = slash(appHome(), null).replace(/\/+$/, "") + "/mods/file-preview/.cache/put/";
  await fs.mkdir(dir, { recursive: true });
  const local = dir + `fp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}.txt`;
  try {
    await fs.writeFile(local, text, { encoding: "utf8", mode: 0o600 });
    const r = await hc(["put", "--json", via, local]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc put failed").trim().slice(0, 200));
    const out = JSON.parse(r.stdout);
    if (typeof out?.path !== "string" || !out.path.startsWith("/")) throw new Error("hc put: no path");
    if (out.bytes !== utf8Bytes(text)) throw new Error(`hc put: ${out.bytes} bytes arrived, ${utf8Bytes(text)} sent`);
    return out.path;
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
  if (r.code === 7) throw new Error("Cannot write there");
  if (r.code !== 0) throw new Error((r.stderr || "Cannot save the file there").trim().slice(0, 200));
  return r.stdout.trim() || null;
}

/** UTF-8 length in bytes, what `hc put` reports. */
function utf8Bytes(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) { n += 4; i++; }
    else n += 3;
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
