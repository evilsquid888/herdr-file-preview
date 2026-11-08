// Splits a Markdown document into prose and fenced code blocks.
// Prose goes to TextView.markdown (GFM is fine there); fences get their own readonly Editor,
// because TextView draws code without colors.

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
// Very long prose is cut into chunks at blank lines so one TextView never holds a whole 1 MB file.
const CHUNK = 32000;

/**
 * -> [{ kind: "md", text, start, end } | { kind: "code", info, text, start, end }]
 * start/end: the source lines the block covers, from 1, inclusive (a fence with its fence lines).
 */
export function segment(source) {
  const lines = source.split("\n"), out = [];
  let prose = [], from = 0;
  const flush = () => {
    if (!prose.length) return;
    const text = prose.join("\n");
    prose = [];
    if (!text.trim()) return;
    for (const c of paragraphs(text)) out.push({ kind: "md", text: c.text, start: from + c.line + 1, end: from + c.line + c.text.split("\n").length });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    // A backtick fence's info string may not contain backticks (CommonMark).
    if (!m || (m[2][0] === "`" && m[3].includes("`"))) { if (!prose.length) from = i; prose.push(lines[i]); continue; }
    const indent = m[1].length, mark = m[2], info = m[3].trim().split(/\s+/)[0] ?? "";
    const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !close.test(lines[j]); j++) body.push(stripIndent(lines[j], indent));
    flush();
    out.push({ kind: "code", info, text: body.join("\n"), start: i + 1, end: Math.min(j, lines.length - 1) + 1 });
    i = j; // an unclosed fence runs to the end of the document
  }
  flush();
  return out;
}

function stripIndent(line, n) {
  let k = 0;
  while (k < n && line[k] === " ") k++;
  return line.slice(k);
}

/**
 * Prose cut at blank lines, so each paragraph is its own block (and can carry comments).
 * -> [{ text, line }]: line = the piece's first line within `text`, from 0.
 * A piece that starts indented continues the one before it (a list item's second paragraph,
 * a nested list): alone it would render as an indented code block. Huge pieces still go
 * through chunks().
 */
function paragraphs(text) {
  const lines = text.split("\n"), out = [];
  let cur = null;
  const push = () => {
    if (cur) for (const c of chunks(cur.lines.join("\n"))) out.push({ text: c.text, line: cur.line + c.line });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { if (cur) cur.blank = true; continue; }
    const continues = cur && cur.blank && /^(\s{2,}|\t)/.test(l);
    if (cur && cur.blank && !continues) push();
    if (!cur) cur = { line: i, lines: [], blank: false };
    else if (cur.blank) for (let k = cur.line + cur.lines.length; k < i; k++) cur.lines.push("");
    cur.lines.push(l);
    cur.blank = false;
  }
  push();
  return out;
}

/** -> [{ text, line }]: line = the chunk's first line within `text`, from 0. */
function chunks(text) {
  if (text.length <= CHUNK) return [{ text, line: 0 }];
  const out = [];
  let start = 0, line = 0;
  while (text.length - start > CHUNK) {
    let cut = text.lastIndexOf("\n\n", start + CHUNK);
    if (cut <= start) cut = text.indexOf("\n\n", start + CHUNK);
    if (cut < 0) break;
    const piece = text.slice(start, cut);
    out.push({ text: piece, line });
    line += piece.split("\n").length + 1;   // the piece, then the blank line it was cut at
    start = cut + 2;
  }
  out.push({ text: text.slice(start), line });
  return out;
}
