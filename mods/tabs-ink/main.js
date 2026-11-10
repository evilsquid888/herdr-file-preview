import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
// squid-ink's clone of Herdr's tabs (0.1.12): the same bar plus a Preview button that opens
// squid-ink in the side panel, the stack child "squid-ink" of the main-ink layout.
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, keys } from "herdr";

const PREVIEW = "squid-ink";
const PANEL_W = 368;   // the side panel's width in main-ink.json: where a tab never resized starts

// A keys.json combo as Herdr's status bar writes it: "cmd-shift-e" is ⌘⇧E on macOS, Ctrl+Shift+E elsewhere.
function shortcut(combo, mac) {
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const parts = combo.endsWith("--") ? [...combo.slice(0, -2).split("-"), "-"] : combo.split("-");
  return parts.map(p => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
}

/** The Preview button's hover: what it does, and the key bound to the same (the launcher's). */
function previewTip(mac) {
  const k = keys().find(b => b.section === "global" && b.action === `mod.open:${PREVIEW}-panel`);
  return "Open or close Squid Ink" + (k ? ` (${shortcut(k.keys, mac)})` : "");
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.widths = JSON.parse(localStorage.getItem("widths") ?? "{}");
  }

  // The side panel's width is remembered per tab (the layout keeps one for the whole window):
  // switching tab or space resizes it to that tab's, and a drag records it for the tab shown.
  syncWidth(tab, panel) {
    const px = panel?.size?.px;
    if (!tab || typeof px !== "number") return;
    if (tab.id !== this.widthTab) {
      const first = this.widthTab === undefined;
      this.widthTab = tab.id;
      // On start a tab never resized keeps the width shown, as its own.
      if (first && this.widths[tab.id] === undefined) { this.keepWidth(tab.id, px); return; }
      const want = this.widths[tab.id] ?? PANEL_W;
      if (Math.abs(want - px) >= 1) {
        this.widthPending = { want, until: Date.now() + 1000 };
        run("layout.resize", { id: "panel", px: want });
      }
      return;
    }
    // Until the resize lands, the old width isn't this tab's.
    if (this.widthPending) {
      if (Math.abs(px - this.widthPending.want) >= 1 && Date.now() < this.widthPending.until) return;
      this.widthPending = null;
    }
    this.keepWidth(tab.id, px);
  }

  keepWidth(id, px) {
    if (this.widths[id] === px || (this.widths[id] === undefined && px === PANEL_W)) return;
    this.widths[id] = px;
    // Closed tabs go with the next write.
    const open = new Set(spaces().flatMap(s => s.tabs.map(x => x.id)));
    for (const k of Object.keys(this.widths)) if (!open.has(k)) delete this.widths[k];
    localStorage.setItem("widths", JSON.stringify(this.widths));
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) || stored === PREVIEW ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    this.syncWidth(shown.find(c => c.active), panel);
    const panelButton = (id, label, icon, tip) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).when(Boolean(tip), el => el.tooltip(tip))
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else {
            run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" });
            if (id === PREVIEW) run(`${PREVIEW}.focus-side`);   // squid-ink takes the keyboard
          }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(Boolean(find(root, PREVIEW)), el => el.child(panelButton(PREVIEW, "Preview", "mods/squid-ink/icons/file-md.svg", previewTip(w?.platform === "macos"))))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-ink/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-ink/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-ink/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
