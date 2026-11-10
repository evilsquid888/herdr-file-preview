// squid-ink in the layout's side panel (main-ink: the stack child "squid-ink" of the right
// column "panel", next to Files and Changes), for the launcher and the popup's Anchor button.
// Mods import only from their own folder, so mods/squid-ink-panel/dock.js is a byte-for-byte
// copy (scripts/sync.sh refuses a mismatch).
import { panes, focused, layout, run } from "herdr";

export const MOD = "squid-ink";
const PANEL = "panel", STACK = "panel-body";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

/** The shown layout has the side panel block (another layout falls back to the popup). */
export function sideAvailable() {
  return Boolean(find(layout(), MOD));
}

/** The side panel is open on squid-ink. */
export function sideShown() {
  const root = layout(), panel = find(root, PANEL), body = find(root, STACK);
  return Boolean(panel && !panel.hidden && body?.active === MOD);
}

/** Opens the side panel on squid-ink, which takes the keyboard. */
export function showSide() {
  run("layout.select", { stack: STACK, child: MOD });
  run("layout.show", { id: PANEL });
  run(`${MOD}.focus-side`);
}

export function hideSide() {
  run("layout.hide", { id: PANEL });
}

/** The launcher's toggle: the side panel, or the popup where the layout has none. */
export function toggle() {
  if (!sideAvailable()) return run("mod.open", { name: MOD });
  if (sideShown()) hideSide();
  else showSide();
}

/** A pane docked by an older version (mode "panel") in a tab, if any: its ✕ still closes it. */
export function panelOf(tab) {
  return panes().find((p) => p.tab === tab && p.mod === MOD && !p.terminal) ?? null;
}

/** The focused tab, for panelOf (null without a window). */
export function focusedTab() {
  return focused()?.tab ?? null;
}
