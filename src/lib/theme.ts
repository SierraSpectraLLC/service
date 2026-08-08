// Workspace appearance rules. An organization may paint its header any hex it
// likes; these helpers keep the result readable regardless of the pick - the
// header text flips between white and the house navy by luminance, and the
// page background is the same hue washed nearly to white. Pure functions, so
// they're unit-tested rather than eyeballed.

const NAVY = "#172A4A";

export function isValidHex(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s.trim());
}

function channels(hex: string): [number, number, number] {
  const h = hex.trim().slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG-ish relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White text on dark headers, navy on light ones. */
export function readableTextOn(hex: string): string {
  return luminance(hex) > 0.45 ? NAVY : "#FFFFFF";
}

/** Blend toward white: pct=0 is the color itself, pct=1 is pure white. */
export function tint(hex: string, pct: number): string {
  const p = Math.min(1, Math.max(0, pct));
  const mixed = channels(hex).map((c) => Math.round(c + (255 - c) * p));
  return "#" + mixed.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
}
