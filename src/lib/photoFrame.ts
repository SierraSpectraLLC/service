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
// Serialized as "rot,zoom,x,y,aspect" because it rides in one column beside the
// file it belongs to. Anything unparseable reads as "no framing", which is
// exactly what every photo taken before this existed should get.
//
// ---------------------------------------------------------------------------
// Why the photo's own aspect ratio is one of the numbers
// ---------------------------------------------------------------------------
// The first version framed with `object-fit: cover`, which crops the photo to
// the tile BEFORE any transform is applied. Panning then slides an
// already-cropped rectangle around: whatever cover threw away - the top and
// bottom of a portrait photo, most often - could not be recovered by dragging,
// because it had never been drawn. Which made the editor useless for the exact
// case it existed to fix.
//
// So a framed photo is drawn with `object-fit: contain` - all of it, fitted -
// and the zoom decides how much of the tile it fills. Zoom 1 is the whole
// photograph; the zoom that exactly fills the tile depends on the photo's shape
// as well as the tile's, which is why the shape has to be stored. Nothing else
// could recompute it: the tile is rendered on the server, which has never seen
// the image.
//
// Photos framed before this - four numbers, no aspect - keep the old rendering.
// They look exactly as they did, and re-framing one moves it across.

export type Frame = {
  /** Quarter turns clockwise: 0, 90, 180, 270. Phones produce all four. */
  rotate: number;
  /**
   * Scale, where 1 is the whole photograph fitted inside the tile. Above that
   * crops in; `coverZoom` is the value that exactly fills the tile.
   */
  zoom: number;
  /** Where the photo sits in the box, as a percentage of it. 0 is centred. */
  x: number;
  y: number;
  /**
   * The photo's own width ÷ height, as loaded. 0 means "not recorded" - a photo
   * framed before this was stored, which renders the old way.
   */
  aspect: number;
};

export const NO_FRAME: Frame = { rotate: 0, zoom: 1, x: 0, y: 0, aspect: 0 };

export const ZOOM_MIN = 1;
/** Room to fill a tile from an extreme aspect and then crop in on top of it. */
export const ZOOM_MAX = 8;
export const PAN_LIMIT = 100;   // percent, either way

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Bring any set of numbers into range, so a hand-edited value can't break a layout. */
export function normalizeFrame(f: Partial<Frame>): Frame {
  const rotate = ((Math.round((f.rotate ?? 0) / 90) * 90) % 360 + 360) % 360;
  return {
    rotate,
    zoom: round(clamp(Number(f.zoom ?? 1) || 1, ZOOM_MIN, ZOOM_MAX), 3),
    x: round(clamp(Number(f.x ?? 0) || 0, -PAN_LIMIT, PAN_LIMIT)),
    y: round(clamp(Number(f.y ?? 0) || 0, -PAN_LIMIT, PAN_LIMIT)),
    // Bounded rather than clamped to a default: a "photo" claiming to be 200:1
    // is a corrupt value, and rendering it as unframed is the honest answer.
    aspect: (() => {
      const a = Number(f.aspect ?? 0) || 0;
      return a >= 0.05 && a <= 20 ? round(a, 4) : 0;
    })(),
  };
}

/** "rot,zoom,x,y[,aspect]" -> a frame. Junk, blank and legacy rows read as unframed. */
export function parseFrame(raw: string | null | undefined): Frame {
  const parts = (raw ?? "").split(",");
  if (parts.length !== 4 && parts.length !== 5) return NO_FRAME;
  const [rotate, zoom, x, y, aspect] = parts.map(Number);
  if ([rotate, zoom, x, y].some((n) => !Number.isFinite(n))) return NO_FRAME;
  if (parts.length === 5 && !Number.isFinite(aspect)) return NO_FRAME;
  return normalizeFrame({ rotate, zoom, x, y, aspect: parts.length === 5 ? aspect : 0 });
}

/** A frame -> the string stored beside the file. Unframed stores as "", not "0,1,0,0". */
export function serializeFrame(f: Frame): string {
  const n = normalizeFrame(f);
  if (n.rotate === 0 && n.zoom === 1 && n.x === 0 && n.y === 0 && n.aspect === 0) return "";
  // Four numbers only when the shape is unknown, so a legacy frame that is
  // merely re-saved does not silently change how it renders.
  return n.aspect === 0
    ? [n.rotate, n.zoom, n.x, n.y].join(",")
    : [n.rotate, n.zoom, n.x, n.y, n.aspect].join(",");
}

/**
 * The zoom at which a photo of this shape exactly fills a box of that shape.
 *
 * Both shapes matter, and so does the rotation: turning a photo a quarter swaps
 * which of its edges has to span which of the box's. This is the number the
 * framer starts from and the one the "fill the tile" control snaps back to.
 */
export function coverZoom(imgAspect: number, boxAspect: number, rotate = 0): number {
  const a = imgAspect > 0 ? imgAspect : boxAspect;
  const r = boxAspect > 0 ? boxAspect : 4 / 3;
  // Where `contain` puts it, in box units: the box is r wide and 1 tall.
  const drawnW = a > r ? r : a;
  const drawnH = a > r ? r / a : 1;
  const quarter = rotate === 90 || rotate === 270;
  const [w, h] = quarter ? [drawnH, drawnW] : [drawnW, drawnH];
  return round(Math.max(r / w, 1 / h), 3);
}

export type FrameStyle = {
  transform: string;
  transformOrigin: string;
  /** How the image fills its element before the transform. The heart of the fix. */
  objectFit: "cover" | "contain";
};

/**
 * The CSS that puts a photo in its box.
 *
 * Order matters and is the fiddly part: translate first, then rotate, then
 * scale, so panning stays in the direction somebody dragged whatever the
 * rotation is.
 *
 * Two renderings, and which one applies is decided by whether the photo's shape
 * was recorded:
 *
 *  - shape known: `contain`, so the whole photograph is drawn and every part of
 *    it can be reached by panning. Zoom is absolute - 1 is the whole thing.
 *  - shape unknown (unframed, or framed before this): `cover`, with the old
 *    quarter-turn fill factor. Unchanged, because thousands of photos render
 *    this way and none of them should move.
 */
export function frameStyle(f: Partial<Frame>, coverAspect = 4 / 3): FrameStyle {
  const n = normalizeFrame(f);
  const origin = "center center";

  if (n.aspect === 0) {
    const quarter = n.rotate === 90 || n.rotate === 270;
    // Turning a landscape photo on its side means its short edge now has to span
    // the box's long one; the aspect ratio is exactly how much short it falls.
    const fill = quarter ? Math.max(coverAspect, 1 / coverAspect) : 1;
    return {
      transform: `translate(${n.x}%, ${n.y}%) rotate(${n.rotate}deg) scale(${round(n.zoom * fill, 3)})`,
      transformOrigin: origin,
      objectFit: "cover",
    };
  }

  return {
    transform: `translate(${n.x}%, ${n.y}%) rotate(${n.rotate}deg) scale(${n.zoom})`,
    transformOrigin: origin,
    objectFit: "contain",
  };
}

/** Turn a quarter clockwise, wrapping. The only rotation control worth having. */
export const turned = (f: Partial<Frame>): Frame => normalizeFrame({ ...f, rotate: (f.rotate ?? 0) + 90 });
