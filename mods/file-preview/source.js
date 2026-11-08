// Reads one file for preview, here or on a remote machine.
import { exec, readTextFile } from "herdr";
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
