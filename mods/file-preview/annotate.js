// Paragraph annotations: comments on a Markdown block, kept on this computer.
//
// A mod can't read the text a person selects (TextView reports no selection), so a comment
// belongs to a block: the paragraph under the drag, or the one right-clicked. The block's
// first line is the quote; the whole block is what the comment is about.
//
// Stored in <app home>/data/file-preview/comments.json:
//   { version: 1, files: { "<machine | local>:<absolute path>": [note, ...] } }
//   note = { id, quote, block, start, end, text, at }
// The quote and block text travel with each note, so a note finds its paragraph again after
// the file is edited (by its text first, then its quote, then its line).
import { appHome, readTextFile, writeTextFile } from "herdr";

export const DRAG_PX = 4;

const file = () => `${appHome()}/data/file-preview/comments.json`;

/** "<machine>:<abs>" for a remote file, "local:<abs>" for one on this computer. */
export const noteKey = (on, abs) => `${on || "local"}:${abs}`;

/** A block's first line without the Markdown that marks it (heading hashes, bullets, quote chevrons). */
export function quoteOf(text) {
  const line = String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const plain = line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")          // images: their alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")           // links: their words
    .replace(/<[^>]+>/g, "")                           // inline HTML tags
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/^\|/, "").replace(/\|$/, "")
    .replace(/[*_`]/g, "")
    .trim();
  return plain.length > 110 ? `${plain.slice(0, 107).trimEnd()}…` : plain;
}

export const noteId = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class Notes {
  constructor() {
    this.files = {};      // key -> [note]
    this.raw = null;      // the file as last read or written (writeTextFile's expected text)
    this.loaded = false;
    this.error = null;
  }

  async load() {
    try {
      this.raw = await readTextFile(file());
      const data = this.raw ? JSON.parse(this.raw) : null;
      this.files = data && typeof data.files === "object" && data.files ? data.files : {};
      this.error = null;
    } catch (e) {
      this.error = `Comments couldn't be read: ${String(e?.message ?? e).split("\n")[0]}`;
    }
    this.loaded = true;
  }

  of(key) { return this.files[key] ?? []; }

  async save() {
    const text = JSON.stringify({ version: 1, files: this.files }, null, 2);
    try {
      await writeTextFile(file(), text, this.raw);
      this.raw = text;
      this.error = null;
    } catch (e) {
      // Changed elsewhere (another copy of the mod): read it again, apply ours on top once.
      try {
        const now = await readTextFile(file());
        const theirs = now ? JSON.parse(now).files ?? {} : {};
        const merged = { ...theirs, ...this.files };
        const again = JSON.stringify({ version: 1, files: merged }, null, 2);
        await writeTextFile(file(), again, now);
        this.files = merged;
        this.raw = again;
        this.error = null;
      } catch (e2) {
        this.error = `Comment not saved: ${String(e2?.message ?? e2).split("\n")[0]}`;
      }
    }
  }

  async add(key, block, text) {
    const note = { id: noteId(), quote: quoteOf(block.text), block: block.text, start: block.start, end: block.end, text, at: Date.now() };
    this.files[key] = [...this.of(key), note];
    await this.save();
    return note;
  }

  async update(key, id, text) {
    this.files[key] = this.of(key).map((n) => (n.id === id ? { ...n, text, edited: Date.now(), sent: undefined } : n));
    await this.save();
  }

  /** Marks notes as handed to an agent (drafted): they stay, dimmed with a ✓, until cleared. */
  async markSent(key, ids, to) {
    const set = new Set(ids), at = Date.now();
    this.files[key] = this.of(key).map((n) => (set.has(n.id) ? { ...n, sent: { at, to } } : n));
    await this.save();
  }

  async clear(key) {
    delete this.files[key];
    await this.save();
  }

  async remove(key, id) {
    const list = this.of(key).filter((n) => n.id !== id);
    if (list.length) this.files[key] = list;
    else delete this.files[key];
    await this.save();
  }

  /**
   * The feedback an agent gets, Plannotator style: one numbered section per comment, in
   * document order. `items` = [{ note, block, section }] (block null: its paragraph is gone).
   */
  static feedback(items, { name, where }) {
    const lines = [`# Feedback on ${name}`, "", `File: ${where}`, `${items.length} comment${items.length === 1 ? "" : "s"}. Each one is about the quoted paragraph.`];
    items.forEach(({ note, block, section }, k) => {
      const start = block?.start ?? note.start, end = block?.end ?? note.end;
      const at = start && end && end > start ? `lines ${start}-${end}` : start ? `line ${start}` : "";
      const bits = [at, section ? `section "${section}"` : "", block ? "" : "paragraph no longer in the file"].filter(Boolean).join(", ");
      lines.push("", `## Annotation ${k + 1} — ${name}${bits ? ` (${bits})` : ""}`);
      if (note.quote) lines.push(`Comment on: "${note.quote}"`);
      lines.push(...String(note.text).split("\n").map((l) => `> ${l}`));
    });
    return lines.join("\n");
  }

  /**
   * Which block each note belongs to now: { [block index]: [note] }, plus the notes whose
   * paragraph is gone (`lost`). Same text first, then the same quote, then the nearest line.
   */
  place(key, blocks) {
    const at = {}, lost = [];
    const md = blocks.map((b, i) => ({ b, i })).filter((x) => x.b.kind === "md");
    for (const n of this.of(key)) {
      let hit = md.find((x) => x.b.text === n.block)
        ?? md.find((x) => n.quote && quoteOf(x.b.text) === n.quote)
        ?? md.find((x) => x.b.start <= n.start && n.start <= x.b.end);
      if (!hit) { lost.push(n); continue; }
      (at[hit.i] ??= []).push(n);
    }
    return { at, lost };
  }
}
