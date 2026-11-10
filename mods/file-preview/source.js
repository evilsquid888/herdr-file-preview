// Reads one file for preview, here or on a remote machine.
import { exec, readTextFile, writeTextFile } from "herdr";
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
// and swaps it in atomically. Remote: exec has no stdin, so the text goes there as base64 in
// pieces (one argument each, under every OS's command-line limit) into a temporary file
// next to the original; one last script checks the file is still what editing started from
// (cksum: CRC and size, POSIX everywhere), decodes, keeps the mode and renames it into place.

// Base64 characters per exec: under Windows' 32 KiB command line, for a Windows host too.
const PIECE = 24000;
const TOKEN = '{ cksum < "$1"; } 2>/dev/null || echo missing';
const PUT_FIRST = 'printf %s "$2" > "$1"';
const PUT_MORE = 'printf %s "$2" >> "$1"';
// $1 file, $2 base64 temp, $3 expected token ("" = don't check). Prints the new token.
const COMMIT = [
  'f=$1; b=$2; o=$2.out',
  'fail() { rm -f "$b" "$o"; exit "$1"; }',
  'if [ -n "$3" ]; then now=$({ cksum < "$f"; } 2>/dev/null || echo missing); [ "$now" = "$3" ] || fail 4; fi',
  '{ base64 -d < "$b" > "$o" || base64 -D < "$b" > "$o"; } 2>/dev/null || fail 5',
  // A symlink keeps being one: write through it (not atomic, but the link survives).
  'if [ -L "$f" ]; then cat "$o" > "$f" || fail 6; rm -f "$b" "$o"; else',
  '  [ -e "$f" ] && chmod "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" "$o" 2>/dev/null',
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
 * Remote: only if its token still equals `token` (null: don't check). Resolves with the new
 * token (remote) or null; rejects with Conflict when the file moved on, else with an Error.
 */
export async function saveText(path, text, { on, base, token }) {
  if (!on) {
    let expected = base;
    if (expected === null) expected = await readTextFile(path).catch(() => null);
    try { await writeTextFile(path, text, expected); }
    catch (e) {
      const now = await readTextFile(path).catch(() => undefined);
      if (now !== undefined && now !== expected) throw new Conflict();
      throw new Error(String(e?.message ?? e));
    }
    return null;
  }
  const b64 = base64(text);
  const slashAt = path.lastIndexOf("/");
  const tmp = `${path.slice(0, slashAt + 1)}.${path.slice(slashAt + 1)}.fp-${Date.now().toString(36)}.b64`;
  for (let i = 0; i === 0 || i < b64.length; i += PIECE) {
    const r = await sh(i === 0 ? PUT_FIRST : PUT_MORE, ["fp", tmp, b64.slice(i, i + PIECE)], { on });
    if (r.code !== 0) {
      await sh('rm -f "$1"', ["fp", tmp], { on }).catch(() => {});
      throw new Error((r.stderr || "Cannot write there").trim().slice(0, 200));
    }
  }
  const r = await sh(COMMIT, ["fp", path, tmp, token ?? ""], { on });
  if (r.code === 4) throw new Conflict();
  if (r.code === 5) throw new Error("Cannot decode on that machine (base64 missing?)");
  if (r.code !== 0) throw new Error((r.stderr || "Cannot save the file there").trim().slice(0, 200));
  return r.stdout.trim() || null;
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
