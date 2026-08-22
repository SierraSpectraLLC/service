import { frameStyle, parseFrame } from "@/lib/photoFrame";

/**
 * A photo in a box of a size the page chose.
 *
 * Every picture on a record goes through here, and the box is always given a
 * width and a height, because the alternative is what this replaced: a phone
 * photo rendered at its natural size, three thousand pixels tall, pushing the
 * record it illustrates off the screen.
 *
 * The stored file is never touched. How the photo sits in the box - turned
 * upright, zoomed in, nudged over - is the `framing` string that travels beside
 * it (lib/photoFrame), so the same numbers apply here, in the strip below, on
 * the assets list and in the gallery. Frame a photo once and it is framed
 * everywhere.
 *
 * The source is always an authorized route, never a blob URL: a photo of a
 * client's lab is not public just because it happens to be an image. Two routes
 * exist because there are two kinds of photograph - a file on this record
 * (/api/files) and a stock photo of this kind of kit (/api/catalog/photo).
 */
export default function PhotoThumb({
  src, framing, alt, width, height, aspect, radius = 10, className, style,
}: {
  /** Built by fileSrc() or stockSrc() - the only two doors a photo comes through. */
  src: string;
  /** "rot,zoom,x,y", or "" for a photo nobody has framed. */
  framing: string;
  alt: string;
  width: number | string;
  /** A fixed height in pixels. Omit it and pass `aspect` for a tile that flexes. */
  height?: number;
  /** Width ÷ height. Required when the box's width is fluid, because the shape of
   *  the box is what decides how far a quarter turn has to scale to keep covering
   *  it - guess it and a sideways photo shows bars down both sides. */
  aspect?: number;
  radius?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const shape = aspect ?? (typeof width === "number" && height ? width / height : 4 / 3);
  const frame = frameStyle(parseFrame(framing), shape);
  return (
    <span className={className}
      style={{
        display: "block", width, flexShrink: 0, overflow: "hidden",
        ...(height === undefined ? { aspectRatio: String(shape) } : { height }),
        borderRadius: radius, border: "1px solid var(--line)", background: "var(--t-neutral-bg)", ...style,
      }}>
      {/* objectFit comes from the frame: a photo somebody framed is drawn whole
          and scaled, so every part of it was reachable in the editor. See
          lib/photoFrame. */}
      <img src={src} alt={alt} loading="lazy"
        style={{ width: "100%", height: "100%", display: "block", ...frame }} />
    </span>
  );
}
