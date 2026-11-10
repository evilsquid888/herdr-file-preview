// Launcher: toggles squid-ink in the layout's side panel (the popup where the layout has none).
// A keys.json binding runs one command, and this needs to look at the layout first, so it lives for one init.
import { View, div } from "gpui-kit";
import { props, closeOverlay } from "herdr";
import { toggle } from "./dock.js";

export default class Launcher extends View {
  init() {
    const overlay = props()?.overlay;      // props(), not init's argument (it arrives undefined)
    try { toggle(); }
    finally { if (overlay) closeOverlay(overlay); }   // `herdr-app check` has no overlay; closeOverlay(null) throws
  }
  render() { return div(); }
}
