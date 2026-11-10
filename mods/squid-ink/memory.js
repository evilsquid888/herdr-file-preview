// What the popup had open per root: the shown file and the expanded folders, persisted in shared.
import { shared, setShared } from "herdr";

export const MEMORY_KEY = "squid-ink.memory";
export const MAX_ROOTS = 20, MAX_EXPANDED = 200;

/** One key per machine and root: "/abs/root" locally, "<machine>:/abs/root" on a remote space. */
export const rootKey = (root, on) => (on ? `${on}:${root}` : root);

function entries() {
  const m = shared(MEMORY_KEY);
  return m && typeof m === "object" && m.entries && typeof m.entries === "object" ? m.entries : {};
}

/** { file, expanded } stored for a root, or null. */
export function recall(key) {
  const e = entries()[key];
  if (!e || typeof e !== "object") return null;
  const file = typeof e.file === "string" && e.file ? e.file : null;
  const expanded = Array.isArray(e.expanded) ? e.expanded.filter((x) => typeof x === "string" && x && !x.split("/").some((p) => !p || p === "." || p === "..")) : [];
  return file || expanded.length ? { file, expanded } : null;
}

/** The entry to store: folders shallow first, so a cut keeps every kept folder's parents. */
export function snapshot(file, expanded) {
  const depth = (p) => p.split("/").length;
  const list = [...expanded].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, MAX_EXPANDED);
  return { file: file ?? null, expanded: list };
}

/** Stores (or, for an empty state, drops) a root's entry; keeps the MAX_ROOTS most recent. */
export function remember(key, snap) {
  const next = { ...entries() };
  if (!snap.file && !snap.expanded.length) delete next[key];
  else next[key] = { ...snap, at: Date.now() };
  const keys = Object.keys(next).sort((a, b) => (next[b].at ?? 0) - (next[a].at ?? 0));
  for (const k of keys.slice(MAX_ROOTS)) delete next[k];
  setShared(MEMORY_KEY, Object.keys(next).length ? { entries: next } : null);
}

/** Drops one root's entry. */
export function forget(key) {
  const next = { ...entries() };
  if (!(key in next)) return false;
  delete next[key];
  setShared(MEMORY_KEY, Object.keys(next).length ? { entries: next } : null);
  return true;
}
