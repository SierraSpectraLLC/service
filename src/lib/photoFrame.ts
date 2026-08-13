// How a photo sits inside its thumbnail.
//
// A photo of an instrument is taken in a corridor, at an angle, holding a torch,
// usually sideways because that is how a phone was pointing. Shown raw it is
// either enormous or it is a picture of the ceiling. The record wants a small,
// consistent, recognizable tile - so the tile is a fixed box and the photo is
// framed inside it: turned upright, zoomed to the part that matters, nudged
// until the module is in the middle.
//
// What is stored is the FRAMING, never a new image. The original file is
// untouched - it is evidence, and cropping evidence to make a thumbnail look
// tidy is not a trade worth making. Re-framing later costs nothing and loses
// nothing, and every place that shows the photo applies the same numbers.
//
// Serialized as "rot,zoom,x,y" because it rides in one column beside the file it
// belongs to. Anything unparseable reads as "no framing", which is exactly what
// every photo taken before this existed should get.

export type Frame = {
  /** Quarter turns clockwise: 0, 90, 180, 270. Phones produce all four. */
  rotate: number;
  /** 1 fills the box; above that crops in. Bounded so nothing can be zoomed to a pixel. */
  zoom: number;
  /** Where the photo sits in the box, as a percentage of it. 0 is centred. */
  x: number;
  y: number;
};

export const NO_FRAME: Frame = { rotate: 0, zoom: 1, x: 0, y: 0 };

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const PAN_LIMIT = 50;   // percent, either way

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Bring any set of numbers into range, so a hand-edited value can't break a layout. */
export function normalizeFrame(f: Partial<Frame>): Frame {
  const rotate = ((Math.round((f.rotate ?? 0) / 90) * 90) % 360 + 360) % 360;
  return {
    rotate,
    zoom: round(clamp(Number(f.zoom ?? 1) || 1, ZOOM_MIN, ZOOM_MAX)),
    x: round(clamp(Number(f.x ?? 0) || 0, -PAN_LIMIT, PAN_LIMIT)),
    y: round(clamp(Number(f.y ?? 0) || 0, -PAN_LIMIT, PAN_LIMIT)),
  };
}

/** "rot,zoom,x,y" -> a frame. Junk, blank and legacy rows all read as unframed. */
export function parseFrame(raw: string | null | undefined): Frame {
  const parts = (raw ?? "").split(",");
  if (parts.length !== 4) return NO_FRAME;
  const [rotate, zoom, x, y] = parts.map(Number);
  if ([rotate, zoom, x, y].some((n) => !Number.isFinite(n))) return NO_FRAME;
  return normalizeFrame({ rotate, zoom, x, y });
}

/** A frame -> the string stored beside the file. Unframed stores as "", not "0,1,0,0". */
export function serializeFrame(f: Frame): string {
  const n = normalizeFrame(f);
  if (n.rotate === 0 && n.zoom === 1 && n.x === 0 && n.y === 0) return "";
  return [n.rotate, n.zoom, n.x, n.y].join(",");
}

/**
 * The CSS that puts a photo in its box.
 *
 * Order matters and is the fiddly part: translate first, then rotate, then
 * scale, so panning stays in the direction somebody dragged whatever the
 * rotation is. A quarter turn also swaps which side of the image fills the box,
 * so those two rotations get an extra scale to cover it - without that, a
 * sideways photo turned upright shows bars down both sides.
 */
export function frameStyle(f: Frame, coverAspect = 4 / 3): {
  transform: string; transformOrigin: string;
} {
  const n = normalizeFrame(f);
  const quarter = n.rotate === 90 || n.rotate === 270;
  // Turning a landscape photo on its side means its short edge now has to span
  // the box's long one; the aspect ratio is exactly how much short it falls.
  const fill = quarter ? Math.max(coverAspect, 1 / coverAspect) : 1;
  return {
    transform: `translate(${n.x}%, ${n.y}%) rotate(${n.rotate}deg) scale(${round(n.zoom * fill, 3)})`,
    transformOrigin: "center center",
  };
}

/** Turn a quarter clockwise, wrapping. The only rotation control worth having. */
export const turned = (f: Frame): Frame => normalizeFrame({ ...f, rotate: f.rotate + 90 });
