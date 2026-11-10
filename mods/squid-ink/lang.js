// File extension / fence info string -> Editor language id (verified ids).

// Aliases normalized before creating an EditorState. `shell` and `golang` do not highlight.
const ALIAS = {
  js: "js", javascript: "js", jsx: "js", ts: "js", tsx: "js", typescript: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash", console: "bash",
  py: "python", python: "python", pyi: "python",
  c: "c", h: "c",
  go: "go", golang: "go",
  json: "json", jsonc: "json", jsonl: "json", ndjson: "json", json5: "json", geojson: "json",
  yaml: "yaml", yml: "yaml", toml: "yaml",
  // Extras the Editor seems to know (used by the shipped `files` mod); not verified here.
  html: "html", css: "css",
};

const NAMES = { js: "JavaScript", bash: "Bash", python: "Python", c: "C", go: "Go", json: "JSON", yaml: "YAML", html: "HTML", css: "CSS" };

const MARKDOWN = new Set(["md", "markdown", "mdx"]);

export function extension(path) {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export const isMarkdown = (path) => MARKDOWN.has(extension(path));

/** Editor language for a file path, or null (plain text). */
export const forPath = (path) => ALIAS[extension(path)] ?? null;

/** Editor language for a fence info string (first word), or null (plain text). */
export const forFence = (info) => ALIAS[(info ?? "").toLowerCase()] ?? null;

/** JSON is often one minified line: always soft-wrapped. */
export const wraps = (id) => id === "json";

/**
 * Visual rows of soft-wrapped text at `cols` columns. Mirrors the Editor's wrap, calibrated on
 * minified JSON: a row breaks before `{` or `[` or after a space, else mid-token.
 */
export function wrappedRows(text, cols) {
  let rows = 0;
  for (const line of text.split("\n")) {
    let start = 0;
    rows++;
    while (line.length - start > cols) {
      let cut = -1;
      for (let i = start + cols; i > start; i--) {
        const c = line[i];
        if (c === "{" || c === "[" || line[i - 1] === " ") { cut = i; break; }
      }
      start = cut > start ? cut : start + cols;
      while (line[start] === " ") start++;
      rows++;
    }
  }
  return rows;
}

// Fence names that are more precise than the language they highlight as.
const FENCE_NAMES = {
  ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX", sh: "Shell", shell: "Shell", zsh: "Zsh",
  console: "Console", jsonc: "JSONC", json5: "JSON5", jsonl: "JSON Lines", ndjson: "NDJSON", geojson: "GeoJSON",
  toml: "TOML", mermaid: "Mermaid", text: "Text", txt: "Text", plain: "Text", plaintext: "Text",
};

/** A fence's header: "Python", "TypeScript", the info string as written, or "Text". */
export function fenceLabel(info) {
  const k = (info ?? "").toLowerCase();
  if (!k) return "Text";
  return FENCE_NAMES[k] ?? NAMES[ALIAS[k]] ?? info;
}

/** For people: "Markdown", "Python", "Plain text". */
export function label(path) {
  if (isMarkdown(path)) return "Markdown";
  const id = forPath(path);
  return id ? NAMES[id] : "Plain text";
}
