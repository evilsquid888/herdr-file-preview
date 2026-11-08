// HTML documents as blocks: the page's top-level elements, each drawn by TextView.html and
// annotated like a Markdown paragraph. No DOM here, so a small tag scanner finds the elements:
//   - only <body> counts (the whole text when there is none); <head>, <script>, <style>,
//     <template>, <noscript> and comments are left out;
//   - layout wrappers (div, main, article, section, header, footer, nav, aside, form, center)
//     holding several elements are opened up, so a page wrapped in <div id="app"> still
//     splits into its headings, paragraphs, lists and tables;
//   - text between elements is a block of its own.
// Each block keeps the source lines it came from, so feedback can point at them.
import { picturesOf } from "./markdown.js";

export const isHtml = (path) => /\.html?$/i.test(String(path));

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const SKIP = new Set(["script", "style", "template", "noscript", "head", "title"]);
const WRAPPERS = new Set(["div", "main", "article", "section", "header", "footer", "nav", "aside", "form", "center", "body", "html", "span"]);
const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const MAX_DEPTH = 6;

/** Top-level children of text[from, to): [{ from, to, tag | null }]. Skipped elements vanish. */
function children(text, from, to) {
  const out = [];
  let depth = 0, start = -1, top = null, skip = null, cursor = from;
  TAG.lastIndex = from;
  for (let m; (m = TAG.exec(text)) && m.index < to;) {
    const [whole, close, rawName, , selfClose] = m;
    const at = m.index, end = at + whole.length;
    if (!rawName) {   // a comment, doctype or processing instruction
      if (depth === 0 && !skip && at > cursor && text.slice(cursor, at).trim()) out.push({ from: cursor, to: at, tag: null });
      if (depth === 0 && !skip) cursor = end;
      continue;
    }
    const name = rawName.toLowerCase();
    if (skip) {   // inside <script> & co.: only its own closing tag counts
      if (close && name === skip.name) { if (--skip.n === 0) { skip = null; if (depth === 0) cursor = end; } }
      else if (!close && name === skip.name) skip.n++;
      continue;
    }
    if (!close && SKIP.has(name) && !selfClose) {
      if (depth === 0 && at > cursor && text.slice(cursor, at).trim()) out.push({ from: cursor, to: at, tag: null });
      skip = { name, n: 1 };
      continue;
    }
    const isVoid = VOID.has(name) || selfClose === "/";
    if (!close) {
      if (depth === 0) {
        if (at > cursor && text.slice(cursor, at).trim()) out.push({ from: cursor, to: at, tag: null });
        start = at; top = name;
      }
      if (isVoid) { if (depth === 0) { out.push({ from: start, to: end, tag: name }); cursor = end; } }
      else depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) { out.push({ from: start, to: end, tag: top }); cursor = end; }
    }
  }
  if (depth > 0 && start >= 0) out.push({ from: start, to, tag: top });   // unclosed: runs to the end
  else if (cursor < to && text.slice(cursor, to).trim()) out.push({ from: cursor, to, tag: null });
  return out;
}

/** The inside of an element's range (after its opening tag, before its closing one). */
function inner(text, el) {
  const open = text.indexOf(">", el.from) + 1;
  const close = text.lastIndexOf("</", el.to);
  return { from: open, to: close > open ? close : el.to };
}

function blocksIn(text, from, to, depth, out) {
  for (const c of children(text, from, to)) {
    if (c.tag && WRAPPERS.has(c.tag) && depth < MAX_DEPTH) {
      const box = inner(text, c);
      const kids = children(text, box.from, box.to);
      if (kids.length > 1 || (kids.length === 1 && kids[0].tag && WRAPPERS.has(kids[0].tag))) { blocksIn(text, box.from, box.to, depth + 1, out); continue; }
    }
    out.push(c);
  }
}

/** -> [{ kind: "md", html: true, text, start, end, pics? }], lines counted from 1. */
export function htmlSegments(text) {
  const body = /<body\b[^>]*>/i.exec(text);
  const from = body ? body.index + body[0].length : 0;
  const endBody = text.search(/<\/body\s*>/i);
  const to = endBody > from ? endBody : text.length;
  const ranges = [];
  blocksIn(text, from, to, 0, ranges);
  const lineAt = (i) => { let n = 1; for (let k = text.indexOf("\n"); k !== -1 && k < i; k = text.indexOf("\n", k + 1)) n++; return n; };
  return ranges.map((r) => {
    let slice = text.slice(r.from, r.to);
    const lead = slice.length - slice.trimStart().length;
    slice = slice.trim();
    const start = lineAt(r.from + lead);
    const pics = picturesOf(slice);
    return { kind: "md", html: true, text: slice, start, end: start + slice.split("\n").length - 1, ...(pics ? { pics } : {}) };
  }).filter((b) => b.text);
}
