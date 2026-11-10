// Images: image files from the tree, and pictures embedded in Markdown / HTML.
//
// GPUI's image() reads only from Herdr's own folder, so every picture is copied into this
// mod's cache first, local or remote:
//   remote: base64 there (one exec through herdr-core) → a temporary text file here →
//           `base64 -d` here into the cache (no scp, no second connection)
//   local:  cp into the cache
// Cached under mods/squid-ink/.cache/img/<hash>.<ext>, the hash of machine, path, size and
// mtime: an edited picture gets a new file, an unchanged one is copied once. Sizes come from
// the file's own header (PNG, GIF, JPEG, WebP, BMP, SVG), so a picture lays out at its final size.
//
// On a remote machine an image file can also be shown the way terminal file managers (yazi)
// do: printed with the Kitty graphics protocol in a short-lived terminal there, nothing copied.
import { appHome, writeTextFile, hc } from "herdr";
import { sh, slash } from "./shell.js";
import { fnv1a } from "./mermaid.js";

export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
export const MAX_BYTES = 6 * 1024 * 1024;   // exec returns at most 8 MiB, and base64 grows by 4/3
const REL = "mods/squid-ink/.cache/img/";
const dir = () => slash(appHome(), null) + "/" + REL;

export const extOf = (path) => (String(path).match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
export const isImage = (path) => IMAGE_EXT.has(extOf(path));

// size and mtime ("<bytes> <epoch>"), or null when missing
const STAT = 'f=$1; [ -f "$f" ] || exit 3; s=$(wc -c < "$f" | tr -d " "); m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"); printf "%s %s" "$s" "$m"';
const B64 = 'base64 < "$1" | tr -d "\\n\\r"';
const B64_HEAD = 'head -c 131072 "$1" | base64 | tr -d "\\n\\r"';
const DECODE = 'mkdir -p "$(dirname "$2")" && base64 -d "$1" > "$2.part" && mv -f "$2.part" "$2"; s=$?; rm -f "$1"; exit $s';
const COPY = 'mkdir -p "$(dirname "$2")" && cp -f "$1" "$2.part" && mv -f "$2.part" "$2"';
const EXISTS = 'test -s "$1"';

const B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** The first `max` bytes of a base64 string (enough for a header). */
export function decodeHead(b64, max = 131072) {
  const out = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < b64.length && out.length < max; i++) {
    const v = B64CHARS.indexOf(b64[i]);
    if (v < 0) continue;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

/** { w, h } from an image's first bytes, or null. */
export function imageSize(u8, ext) {
  const be16 = (o) => (u8[o] << 8) | u8[o + 1], le16 = (o) => u8[o] | (u8[o + 1] << 8);
  const be32 = (o) => ((u8[o] << 24) >>> 0) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3];
  const le32 = (o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) + u8[o + 3] * 16777216;
  const ascii = (o, n) => String.fromCharCode(...u8.slice(o, o + n));
  if (u8.length > 24 && ascii(1, 3) === "PNG") return { w: be32(16), h: be32(20) };
  if (u8.length > 10 && ascii(0, 3) === "GIF") return { w: le16(6), h: le16(8) };
  if (u8.length > 26 && ascii(0, 2) === "BM") return { w: le32(18), h: Math.abs(le32(22) | 0) };
  if (u8.length > 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return { w: 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16)), h: 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16)) };
    if (kind === "VP8L") { const b = le32(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
    if (kind === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
  }
  if (u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8) {
    let o = 2;
    while (o + 9 < u8.length) {
      if (u8[o] !== 0xff) { o++; continue; }
      const m = u8[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: be16(o + 7), h: be16(o + 5) };
      o += 2 + be16(o + 2);
    }
  }
  if (ext === "svg") {
    const text = String.fromCharCode(...u8.slice(0, 4096));
    const tag = text.match(/<svg\b[^>]*>/i)?.[0] ?? "";
    const num = (name) => Number(tag.match(new RegExp(`\\b${name}\\s*=\\s*["']?([\\d.]+)(px)?["'\\s>]`, "i"))?.[1]);
    const w = num("width"), h = num("height");
    if (w && h) return { w, h };
    const vb = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (vb) return { w: Number(vb[1]), h: Number(vb[2]) };
    return { w: 600, h: 400 };
  }
  return null;
}

const done = new Map();      // cache key -> { src, w, h } (this session)
const pending = new Map();   // cache key -> Promise

/**
 * A picture, copied into the cache: { src (for image()), w, h } | { error }.
 * `abs` is the absolute path on machine `on` (null: this computer).
 */
export function cached(abs, on) {
  const id = `${on ?? ""}|${abs}`;
  if (pending.has(id)) return pending.get(id);
  const p = load(abs, on).finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}

async function load(abs, on) {
  const ext = extOf(abs) || "img";
  const st = await sh(STAT, ["fp", abs], { on }).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
  if (st.code === 3) return { error: "Image not found" };
  if (st.code !== 0) return { error: (st.stderr || "Cannot read this image").trim().slice(0, 160) };
  const [size, mtime] = st.stdout.trim().split(/\s+/).map(Number);
  if (size > MAX_BYTES) return { error: `Image is ${(size / 1048576).toFixed(1)} MB (the preview copies up to ${MAX_BYTES / 1048576} MB)` };
  const key = fnv1a(`${on ?? ""}|${abs}|${size}|${mtime}`);
  if (done.has(key)) return done.get(key);
  const dest = dir() + key + "." + ext, src = REL + key + "." + ext;
  const have = await sh(EXISTS, ["fp", dest]).then((r) => r.code === 0, () => false);
  let head;
  if (on) {
    // One read there: the whole file as base64; its header gives the size too.
    const r = await sh(B64, ["fp", abs], { on }).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
    if (r.code !== 0) return { error: (r.stderr || "Cannot read this image").trim().slice(0, 160) };
    head = decodeHead(r.stdout);
    if (!have) {
      const tmp = dir() + key + "." + Date.now().toString(36) + ".b64";
      await sh('mkdir -p "$1"', ["fp", dir()]).catch(() => null);
      try { await writeTextFile(tmp, r.stdout, null); }
      catch (e) { return { error: `Cannot cache this image: ${String(e?.message ?? e).split("\n")[0]}` }; }
      const d = await sh(DECODE, ["fp", tmp, dest]).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
      if (d.code !== 0) return { error: (d.stderr || "Cannot cache this image").trim().slice(0, 160) };
    }
  } else {
    if (!have) {
      const c = await sh(COPY, ["fp", abs, dest]).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
      if (c.code !== 0) return { error: (c.stderr || "Cannot cache this image").trim().slice(0, 160) };
    }
    const h = await sh(B64_HEAD, ["fp", abs]).catch(() => null);
    head = decodeHead(h?.stdout ?? "");
  }
  const dim = imageSize(head, ext) ?? { w: 800, h: 600 };
  const out = { src, w: dim.w, h: dim.h, bytes: size };
  done.set(key, out);
  return out;
}

/** Display size: fits `maxW` (and `maxH`, if given), never upscaled past `zoom` × natural. */
export function fit(w, h, maxW, maxH = Infinity, zoom = 1) {
  const s = Math.min(zoom, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// ---- over SSH, the yazi way ----

// Prints the picture with the Kitty graphics protocol (PNG straight; other formats through
// ImageMagick when it's there), sized to the terminal's width, then waits for Enter.
const KITTY = String.raw`f=$1
show() {
python3 - "$1" <<'PY'
import base64, os, sys
data = open(sys.argv[1], "rb").read()
cols = max(10, os.get_terminal_size().columns - 2)
b = base64.standard_b64encode(data)
first = True
while b:
    chunk, b = b[:4096], b[4096:]
    m = 1 if b else 0
    head = ("a=T,f=100,c=%d," % cols) if first else ""
    sys.stdout.write("\033_G%sm=%d;%s\033\\" % (head, m, chunk.decode()))
    first = False
sys.stdout.write("\n")
sys.stdout.flush()
PY
}
case "$f" in
  *.png|*.PNG) show "$f" ;;
  *) if command -v chafa >/dev/null 2>&1; then chafa -f kitty "$f"
     elif command -v convert >/dev/null 2>&1; then t=$(mktemp --suffix=.png); convert "$f[0]" "$t" && show "$t"; rm -f "$t"
     else echo "Showing this format needs chafa or ImageMagick on this machine (PNG works without)."; fi ;;
esac
printf '\n%s  ·  Enter closes\n' "$(basename "$f")"
read -r _`;

/** Starts the Kitty viewer on `on` for `abs`: its terminal address ("spark/t12"), or throws. */
export async function kittyTerminal(abs, on) {
  const r = await hc(["run", "--on", on, "--bg", "--rm", "--no-parent", "--json", "--name", `fp-img-${Date.now().toString(36)}`, "--", "sh", "-c", KITTY, "fp", abs]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Cannot start a terminal there").trim().slice(0, 160));
  let address = null;
  try { address = JSON.parse(r.stdout).address ?? null; } catch { address = r.stdout.trim().split(/\s+/).pop() || null; }
  if (!address) throw new Error("No terminal address came back");
  return address.includes("/") ? address : `${on}/${address}`;
}
