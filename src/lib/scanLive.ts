// The live viewfinder's judgement: when is the camera looking at the paper,
// steadily enough to say so?
//
// The viewfinder runs detection on every few frames and draws what it found
// over the video. Drawing EVERY hit would make the outline flicker between the
// receipt, the laptop behind it and a shadow - detection is right most of the
// time and jittery always - so the UI wants a second, calmer signal: "the same
// quad, several frames running". That is a LOCK, and it is what turns the
// outline green and tells a person the shot is worth taking.
//
// Pure, because this is the part that can be wrong quietly. A lock that
// tolerates too much drift locks onto two different detections and calls them
// one; a lock that tolerates none never locks on a hand-held phone, and the
// feature reads as broken. The camera calls live in DocScanner.

import type { Quad } from "@/lib/scanDoc";

/** How many consecutive detections have to agree before the outline settles. */
export const LOCK_FRAMES = 4;

/**
 * Per-frame movement allowance, as a fraction of the frame's short side.
 * 2% is a hand holding a phone; more is the phone moving to a new subject.
 */
export const LOCK_DRIFT = 0.02;

/** The farthest any corner moved between two detections of "the same" quad. */
export function quadDrift(a: Quad, b: Quad): number {
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    worst = Math.max(worst, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  }
  return worst;
}

/**
 * The lock: the last LOCK_FRAMES detections, each within drift of the one
 * before it, with no misses in between. A single dropped frame breaks it -
 * harsh on purpose, because a miss usually means the paper left the frame and
 * whatever is detected next is something else wearing similar corners.
 *
 * Returns the NEWEST quad when locked - the one closest to what the shutter
 * will actually capture - or null.
 */
export function steadyLock(
  history: (Quad | null)[], width: number, height: number,
): Quad | null {
  if (history.length < LOCK_FRAMES) return null;
  const tail = history.slice(-LOCK_FRAMES);
  const tolerance = Math.min(width, height) * LOCK_DRIFT;
  for (let i = 0; i < tail.length; i++) {
    const q = tail[i];
    if (!q) return null;
    if (i > 0 && quadDrift(tail[i - 1] as Quad, q) > tolerance) return null;
  }
  return tail[tail.length - 1];
}
