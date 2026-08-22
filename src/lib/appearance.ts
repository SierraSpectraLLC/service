// How the platform looks, as data rather than as CSS somebody has to redeploy.
//
// Two things are adjustable and they are deliberately separate. The HEADER
// COLOR is the bar behind the wordmark, and it follows exactly the rule an
// organization's own themeColor already follows: it paints the header and
// tints the page behind it, and leaves buttons, titles and tabs on the house
// navy. Recolouring a header is a brand decision; recolouring every accent in
// the app is a redesign, and conflating them is how one hex turns a working
// interface into an unreadable one.
//
// The SPECTRUM is the thin gradient above it - the one piece of the design
// that is purely identity. Its thickness and its stops are editable, including
// down to nothing for anyone who wants the bar gone.
//
// Everything here is pure, and validating is the whole job: these values end
// up inside a style attribute, so a colour that is not a colour is not merely
// ugly, it is a way to write arbitrary CSS onto every page of the app. Nothing
// reaches the DOM that has not been through cleanStops/clampHeight.
import { isValidHex } from "@/lib/theme";

/** One band edge: a colour, and how far along the bar it sits (0-100%). */
export type Stop = { c: string; at: number };

/** The look the app ships with - and what a blank setting means. */
export const DEFAULT_HEADER = "#172A4A";
export const DEFAULT_SPECTRUM_HEIGHT = 3;
export const DEFAULT_STOPS: Stop[] = [
  { c: "#172A4A", at: 0 },
  { c: "#2B5F8F", at: 25 },
  { c: "#5BA8D9", at: 50 },
  { c: "#1D9E75", at: 72 },
  { c: "#E8613C", at: 100 },
];

export const MIN_STOPS = 2;
export const MAX_STOPS = 8;
export const MAX_SPECTRUM_HEIGHT = 16;

/** Whole pixels, 0 (no bar at all) to MAX. Anything unreadable becomes the default. */
export function clampHeight(n: unknown): number {
  const h = typeof n === "number" ? n : parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(h)) return DEFAULT_SPECTRUM_HEIGHT;
  return Math.min(MAX_SPECTRUM_HEIGHT, Math.max(0, Math.round(h)));
}

/**
 * The stops as they may actually be drawn: hex only, positions clamped and
 * ordered, capped in number. Returns null when nothing usable survives, which
 * callers read as "use the default" rather than rendering an empty bar.
 */
export function cleanStops(raw: unknown): Stop[] | null {
  if (!Array.isArray(raw)) return null;
  const kept: Stop[] = [];
  for (const s of raw) {
    const c = typeof (s as Stop)?.c === "string" ? (s as Stop).c.trim().toUpperCase() : "";
    if (!isValidHex(c)) continue;
    const n = Number((s as Stop)?.at);
    kept.push({ c, at: Math.min(100, Math.max(0, Number.isFinite(n) ? Math.round(n) : 0)) });
    if (kept.length >= MAX_STOPS) break;
  }
  if (!kept.length) return null;
  // Sorted so a gradient reads left to right whatever order they were typed in.
  return kept.sort((a, b) => a.at - b.at);
}

/** Stops from what the column holds. Blank, broken or empty = the default. */
export function parseStops(stored: string): Stop[] {
  if (!stored.trim()) return DEFAULT_STOPS;
  try {
    return cleanStops(JSON.parse(stored)) ?? DEFAULT_STOPS;
  } catch {
    return DEFAULT_STOPS;
  }
}

/** For the column. Blank when it is the stock look, so a default can move later. */
export function serializeStops(stops: Stop[]): string {
  const clean = cleanStops(stops);
  if (!clean) return "";
  return JSON.stringify(clean.map((s) => ({ c: s.c, at: s.at })));
}

/**
 * The CSS for the bar. Safe to inline: every colour has passed isValidHex and
 * every position is a clamped integer, so nothing here can carry a semicolon
 * out of the property it belongs to.
 *
 * One stop is a solid bar rather than an error - CSS needs two colour stops to
 * make a gradient, so the single colour is simply used for both ends.
 */
export function gradientCss(stops: Stop[]): string {
  const clean = cleanStops(stops) ?? DEFAULT_STOPS;
  const parts = clean.length >= MIN_STOPS
    ? clean
    : [{ c: clean[0].c, at: 0 }, { c: clean[0].c, at: 100 }];
  return `linear-gradient(90deg,${parts.map((s) => `${s.c} ${s.at}%`).join(",")})`;
}

/** The header colour to paint, given what the settings hold. */
export function headerColor(stored: string): string {
  const c = stored.trim();
  return isValidHex(c) ? c.toUpperCase() : DEFAULT_HEADER;
}
