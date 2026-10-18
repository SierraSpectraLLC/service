/**
 * Where the far machine's screen sits inside the viewer, and how big.
 *
 * One picture of `w` x `h` remote pixels inside a box of `bw` x `bh` CSS pixels,
 * drawn at `s` CSS pixels per remote pixel with its top-left corner at (tx, ty).
 * Everything the viewer does - pinch, pan, fit, and turning a finger into the
 * pixel it is over - is arithmetic on those three numbers, so it lives here
 * where it can be tested without a screen.
 *
 * The rules a view always obeys after `clamp`:
 *   - never smaller than fits the box, never larger than MAX_SCALE;
 *   - a picture narrower than the box is centred, never left adrift;
 *   - a picture wider than the box always covers it, so panning stops at the
 *     edge of the desktop rather than sliding off into nothing.
 */

export type View = { s: number; tx: number; ty: number };
export type Size = { w: number; h: number };

/**
 * The largest zoom, in CSS pixels per remote pixel. Three is past the point
 * where a 9pt label reads comfortably on a phone held at arm's length, and
 * further only makes the picture blurry, since there is no more detail to show.
 */
export const MAX_SCALE = 3;

/** The scale at which the whole remote screen fits the box. */
export function fitScale(screen: Size, box: Size): number {
  if (screen.w <= 0 || screen.h <= 0 || box.w <= 0 || box.h <= 0) return 1;
  return Math.min(box.w / screen.w, box.h / screen.h);
}

export const scaleRange = (screen: Size, box: Size) => {
  const min = fitScale(screen, box);
  return { min, max: Math.max(min, MAX_SCALE) };
};

/** One axis: centre if it fits, otherwise keep the box covered. */
function settle(t: number, picture: number, box: number): number {
  if (picture <= box) return (box - picture) / 2;
  return Math.min(0, Math.max(box - picture, t));
}

export function clamp(v: View, screen: Size, box: Size): View {
  const { min, max } = scaleRange(screen, box);
  const s = Math.min(max, Math.max(min, v.s));
  return { s, tx: settle(v.tx, screen.w * s, box.w), ty: settle(v.ty, screen.h * s, box.h) };
}

/** The whole screen, centred. */
export function fitted(screen: Size, box: Size): View {
  return clamp({ s: fitScale(screen, box), tx: 0, ty: 0 }, screen, box);
}

/** Is the view at (or within a hair of) the fitted size? */
export function isFitted(v: View, screen: Size, box: Size): boolean {
  return v.s <= fitScale(screen, box) * 1.001;
}

/**
 * Zoom by `factor` keeping the remote pixel under (ax, ay) where it is - the
 * thing that makes a pinch feel like it has hold of the picture.
 */
export function zoomAt(v: View, factor: number, ax: number, ay: number, screen: Size, box: Size): View {
  const { min, max } = scaleRange(screen, box);
  const s = Math.min(max, Math.max(min, v.s * factor));
  const k = s / v.s;
  return clamp({ s, tx: ax - (ax - v.tx) * k, ty: ay - (ay - v.ty) * k }, screen, box);
}

export function panBy(v: View, dx: number, dy: number, screen: Size, box: Size): View {
  return clamp({ s: v.s, tx: v.tx + dx, ty: v.ty + dy }, screen, box);
}

/** The remote pixel under a point in the box, held to the screen's edges. */
export function toRemote(v: View, px: number, py: number, screen: Size): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(screen.w - 1, Math.floor((px - v.tx) / v.s))),
    y: Math.max(0, Math.min(screen.h - 1, Math.floor((py - v.ty) / v.s))),
  };
}

/** Where a remote pixel is drawn in the box: the middle of it. */
export function toBox(v: View, rx: number, ry: number): { x: number; y: number } {
  return { x: v.tx + (rx + 0.5) * v.s, y: v.ty + (ry + 0.5) * v.s };
}

/**
 * Pan just far enough that a remote pixel is at least `margin` inside the box.
 * Trackpad mode calls this as the cursor moves, so pushing the cursor at an edge
 * slides the desktop along, the way a phone remote-control app does.
 */
export function follow(v: View, rx: number, ry: number, margin: number, screen: Size, box: Size): View {
  const p = toBox(v, rx, ry);
  const m = Math.min(margin, box.w / 2, box.h / 2);
  let dx = 0, dy = 0;
  if (p.x < m) dx = m - p.x; else if (p.x > box.w - m) dx = box.w - m - p.x;
  if (p.y < m) dy = m - p.y; else if (p.y > box.h - m) dy = box.h - m - p.y;
  return dx === 0 && dy === 0 ? v : panBy(v, dx, dy, screen, box);
}

/**
 * Carry a view across a change of box (a phone turned sideways, the viewer
 * expanded): a fitted view stays fitted, anything else keeps the same remote
 * pixel at the centre at the same zoom.
 */
export function resize(v: View, screen: Size, from: Size, to: Size): View {
  if (isFitted(v, screen, from)) return fitted(screen, to);
  const cx = (from.w / 2 - v.tx) / v.s, cy = (from.h / 2 - v.ty) / v.s;
  return clamp({ s: v.s, tx: to.w / 2 - cx * v.s, ty: to.h / 2 - cy * v.s }, screen, to);
}
