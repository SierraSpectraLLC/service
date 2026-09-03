// Reading the ticks off a flattened photo of a sheet. Deterministic, no model.
//
// A tri-state box on a printed sheet is a known rectangle; a pen mark inside
// it is dark pixels where the paper was white. That is a fill ratio, and a
// fill ratio is a number a test can pin. What this cannot read is handwriting
// - a reading in a comb cell, a sentence in the findings box - and it does not
// try: the technician types those on confirm, looking at their own sheet ten
// minutes after writing it. A wrong tick costs a correction on a screen; a
// wrong digit read off a "7" that was a "1" would land on a machine's
// permanent chain.
//
// Pure. Runs in the browser on the dewarped canvas (lib/scanDoc already puts
// the page there) and in tests on a synthetic buffer.

import type { Box, SheetLayout } from "@/lib/custody/sheetLayout";

export type Fill = { done: number; skip: number; na: number };
export type Mark = {
  key: string;
  state: "done" | "skip" | "na" | null;
  /** 0..1. How far the winning box stood clear of the next and of the floor. */
  confidence: number;
  fill: Fill;
};

/** Pixels darker than this (0..255 grey) count as ink. Paper after dewarp+flatten sits near 230+. */
export const INK_THRESHOLD = 140;
/** A box with less ink than this is empty, whatever the others say. */
export const FILL_FLOOR = 0.08;
/** The winner must beat the runner-up by this much to be called at all. */
export const MARGIN_MIN = 0.06;
/** How far inside the printed border the reader looks, as a fraction of the box. */
export const INSET = 0.22;

/** Grey value of one RGBA pixel. */
const grey = (rgba: ArrayLike<number>, i: number): number =>
  (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;

/**
 * Ink fraction inside a box, ignoring the printed border. RGBA input, the
 * shape a canvas getImageData returns.
 */
export function fillRatio(rgba: ArrayLike<number>, width: number, height: number, box: Box): number {
  const x0 = Math.round((box.x + box.w * INSET) * width), x1 = Math.round((box.x + box.w * (1 - INSET)) * width);
  const y0 = Math.round((box.y + box.h * INSET) * height), y1 = Math.round((box.y + box.h * (1 - INSET)) * height);
  let ink = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
      n++;
      if (grey(rgba, (y * width + x) * 4) < INK_THRESHOLD) ink++;
    }
  }
  return n ? ink / n : 0;
}

export function callState(fill: Fill): { state: Mark["state"]; confidence: number } {
  const ranked = (Object.entries(fill) as [keyof Fill, number][]).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (top[1] < FILL_FLOOR) return { state: null, confidence: 1 - top[1] / FILL_FLOOR };
  const margin = top[1] - second[1];
  if (margin < MARGIN_MIN) return { state: null, confidence: 0 };
  // Clear of the runner-up and clear of the floor, each on its own scale.
  const confidence = Math.min(1, Math.min(margin / 0.3, (top[1] - FILL_FLOOR) / 0.3));
  return { state: top[0], confidence };
}

export function readMarks(rgba: ArrayLike<number>, width: number, height: number, layout: SheetLayout): Mark[] {
  return layout.rows.map((r) => {
    const fill: Fill = {
      done: fillRatio(rgba, width, height, r.done),
      skip: fillRatio(rgba, width, height, r.skip),
      na: fillRatio(rgba, width, height, r.na),
    };
    return { key: r.key, ...callState(fill), fill };
  });
}

/** Whether a comb has anything written in it - a hint for the confirm screen, never a value. */
export function combHasInk(rgba: ArrayLike<number>, width: number, height: number, comb: Box[]): boolean {
  return comb.some((c) => fillRatio(rgba, width, height, c) > FILL_FLOOR);
}

/** Uncertain first, as the confirm screen shows them. Stable for equal confidence. */
export const byUncertainty = (marks: Mark[]): Mark[] =>
  marks.map((m, i) => ({ m, i })).sort((a, b) => a.m.confidence - b.m.confidence || a.i - b.i).map((x) => x.m);
