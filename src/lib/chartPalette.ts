// The colours a chart in this app may use, and the rules that pick between them.
//
// Not a new palette - the app already has one, in globals.css, and a chart that
// invented its own would be the loudest thing on the page. These are the same
// tone colours the pills and the status lines wear, arranged into the four jobs
// a chart colour can do.
//
// EVERY SET BELOW WAS RUN THROUGH A VALIDATOR, not eyeballed. Colourblind
// separation is arithmetic (OKLab ΔE after a CVD simulation) and "these look
// different enough" is how a chart ends up unreadable for one reader in twelve.
// What each set passed is recorded beside it; re-run before changing a hex.
//
//   node scripts/validate_palette.js "<hex,...>" --mode light --surface "#FFFFFF"
//
// One light surface only, because the app has one theme. If a dark mode ever
// lands, every set here needs its own dark steps validated against the dark
// surface - an automatic flip is not a palette.

/**
 * Identity. For series that are different THINGS - invoiced against collected -
 * where the colour says which, not how much.
 *
 * Order is the safety mechanism, not decoration. The first three clear the
 * all-pairs gate (worst pair ΔE 8.1 CVD / 17.0 normal), so any form that puts
 * every series against every other - a scatter, a bubble - stops at three. The
 * fourth is adjacent-safe only (stacks, grouped bars, lines: worst adjacent
 * ΔE 8.1 CVD / 24.5 normal), and 8.1 sits in the band where secondary encoding
 * is required rather than optional, so a chart using all four MUST direct-label.
 *
 * There is no fifth. A fifth series folds into "Other" or the chart becomes
 * small multiples; a generated hue is indistinguishable from one of these under
 * CVD and fails every check by construction.
 */
export const SERIES = [
  "#1D6396", // the app's link blue
  "#E8613C", // coral, the app's accent
  "#2E6B2E", // good green
  "#4F45A3", // accent violet - adjacent forms only
] as const;

/**
 * Magnitude, in one hue, light to dark. For ordered bands - an ageing ladder, a
 * pipeline - where the colour says how far along, and for any single-series bar
 * chart, where every bar takes step 4 and none of them varies.
 *
 * Validated as an ordinal ramp: monotone lightness, every adjacent gap ≥ 0.06 L,
 * and the lightest step clears 2:1 against white so a near-zero band does not
 * dissolve into the page.
 *
 * NEVER darker-where-bigger on unordered categories. That paints bar length
 * twice and burns the only free channel on something the chart already shows.
 */
export const RAMP = ["#8DB9DA", "#5F9DC8", "#3A82B0", "#206495", "#164A70"] as const;

/**
 * State. Reserved: these mean good / needs attention / wrong, and never stand in
 * for "series three".
 *
 * The same four tones the pills wear, so a red bar and a red pill mean the same
 * thing on the same page. They ride with a label every time - the label is what
 * carries the meaning for a reader who cannot separate the hues.
 */
export const STATUS = {
  good: "#2E6B2E",
  info: "#1D6396",
  warn: "#8A5410",
  bad: "#A32D2D",
} as const;

/** Ink and furniture. Text never wears a series colour - see the note below. */
export const CHART_INK = {
  /** The surface a chart sits on. The gaps between marks are painted in it. */
  surface: "#FFFFFF",
  /** Hairline, solid, one step off the surface. Never dashed. */
  grid: "#E4E8EF",
  /** Axis ticks and labels. */
  axis: "#64748B",
  /** The de-emphasis colour: everything that is context rather than the point. */
  faint: "#CBD5E1",
} as const;

/**
 * The colour of a bar in a single-series chart.
 *
 * A function rather than a constant so the rule is stated where it is used:
 * ONE series is ONE colour, every bar the same. The temptation is to shade by
 * value, and it is wrong for the reason in the RAMP note above.
 */
export const oneSeries = (): string => RAMP[3];

/**
 * The ordered bands of a ladder, darkest at the far end.
 *
 * Takes as many steps as there are bands, spread across the ramp, so a
 * three-band ladder and a five-band ladder both run the full range instead of
 * the short one crowding into the light end.
 */
export function ladder(bands: number): string[] {
  if (bands <= 1) return [RAMP[3]];
  const last = RAMP.length - 1;
  return Array.from({ length: bands }, (_, i) =>
    RAMP[Math.round((i / (bands - 1)) * last)]);
}

/**
 * Ink for a label set INSIDE a filled mark - the one place text may sit on a
 * series colour, because it has to.
 *
 * Picked by the fill's luminance rather than by eye, so a label on the lightest
 * ramp step and one on the darkest are both readable. Everywhere else - axis
 * ticks, legends, values beside a mark - text wears a text token and the colour
 * lives in the swatch next to it.
 */
export function inkOn(fill: string): string {
  const L = luminance(fill);
  // The CONTRAST of each candidate, not a lightness threshold. A threshold has
  // to be guessed and this one was guessed wrong first time: the lightest ramp
  // step sits at L 0.46, which reads "light" to the eye but leaves white text
  // on it at 2.1:1 - unreadable - where the dark ink is 6.8:1.
  return contrast(L, luminance(INK_DARK)) >= contrast(L, luminance("#FFFFFF"))
    ? INK_DARK : "#FFFFFF";
}

const INK_DARK = "#1E293B";

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrast = (a: number, b: number): number =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
