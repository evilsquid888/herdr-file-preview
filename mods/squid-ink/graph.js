// Draws one row of the commit graph: lane lines, curves into and out of the node, the node.
// Pure: no handlers, so it can run inside a virtual list's item renderer.
import { div, PathBuilder } from "gpui-kit";

export const STROKE = 1.5;

/** Lane colors from the theme's ANSI palette. */
export const palette = (t) => [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1];

const circle = (b, x, y, r) => b.move_to(x + r, y).arc_to(r, r, 0, false, true, x - r, y).arc_to(r, r, 0, false, true, x + r, y).close();

/** Lanes drawn at this row (1 + the rightmost one, capped at `max`): ref flags start after them. */
export function reach(row, max) {
  let r = row.node + 1;
  for (const [a, , b] of row.segs) r = Math.max(r, a + 1, b + 1);
  return Math.min(r, max);
}

/** A flag's pointer toward the node: a filled triangle `w` x `h`, tip on the left. */
export function pointer(color, w, h) {
  const p = PathBuilder.fill().move_to(w, 0).line_to(0, h / 2).line_to(w, h).close();
  return div().w(w).h(h).flex_none().relative().child(window.paint_path(p.build(), color).absolute().top(0).left(0).size_full());
}

/**
 * The graph cell of a row from Graph.add: `lw` px per lane, `h` px tall, lanes past `max` hidden
 * (a node there sits on the last column, hollow), `bg` the row color inside a merge ring, `flag` the x
 * of the row's first ref flag (a thin line from the node to it). One stroked path per color, then the node.
 */
export function cell(row, t, { lw, h, max, width, bg, flag }) {
  const pal = palette(t), mid = h / 2, y = [0, mid, h];
  const x = (lane) => Math.min(lane, max - 1) * lw + lw / 2;
  const byColor = new Map();
  for (const [a, ya, b, yb, c] of row.segs) {
    if (a >= max || b >= max) continue;
    let p = byColor.get(c % pal.length);
    if (!p) byColor.set(c % pal.length, (p = PathBuilder.stroke(STROKE)));
    const x0 = x(a), x1 = x(b), y0 = y[ya], y1 = y[yb];
    p.move_to(x0, y0);
    if (x0 === x1) p.line_to(x1, y1);
    else {
      // Bends near the node's half: leaves straight, turns, arrives straight.
      const k = (y1 - y0) / 2;
      p.cubic_bezier_to(x1, y1, x0, y0 + k, x1, y1 - k);
    }
  }
  const out = [];
  for (const [c, p] of byColor) out.push(window.paint_path(p.build(), pal[c]).absolute().top(0).left(0).size_full());
  const nx = x(row.node), color = pal[row.color % pal.length], hidden = row.node >= max;
  if (flag > nx) out.push(window.paint_path(PathBuilder.stroke(1).move_to(nx, mid).line_to(flag, mid).build(), hidden ? t.dim : color).absolute().top(0).left(0).size_full());
  if (row.c.head) {
    out.push(window.paint_path(circle(PathBuilder.stroke(1.5), nx, mid, 6).build(), t.foreground).absolute().top(0).left(0).size_full());
    out.push(window.paint_path(circle(PathBuilder.fill(), nx, mid, 4).build(), color).absolute().top(0).left(0).size_full());
  } else if (hidden || row.c.parents.length > 1) {
    // A merge (or a lane past the cap): a ring with the surface inside.
    out.push(window.paint_path(circle(PathBuilder.fill(), nx, mid, 4).build(), hidden ? t.dim : color).absolute().top(0).left(0).size_full());
    out.push(window.paint_path(circle(PathBuilder.fill(), nx, mid, 2).build(), bg ?? t.chrome).absolute().top(0).left(0).size_full());
  } else out.push(window.paint_path(circle(PathBuilder.fill(), nx, mid, 3.5).build(), color).absolute().top(0).left(0).size_full());
  return div().w(width).h(h).flex_none().relative().children(out);
}
