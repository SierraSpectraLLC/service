// The viewfinder's lock - the judgement that turns the outline green.
//
// Two ways to be quietly wrong, both fenced here: a lock that never engages on
// a hand-held phone (the feature reads as broken and nobody says why), and a
// lock that bridges a dropped detection (the paper left the frame, and what
// locked next was the laptop behind it wearing similar corners).
import { describe, expect, it } from "vitest";
import { LOCK_DRIFT, LOCK_FRAMES, quadDrift, steadyLock } from "@/lib/scanLive";
import type { Quad } from "@/lib/scanDoc";

const W = 480, H = 360;
const quad = (dx = 0, dy = 0): Quad => [
  { x: 60 + dx, y: 50 + dy }, { x: 420 + dx, y: 60 + dy },
  { x: 410 + dx, y: 310 + dy }, { x: 70 + dx, y: 300 + dy },
];

/** A hand's worth of shake: well inside the per-frame allowance. */
const shake = Math.min(W, H) * LOCK_DRIFT * 0.4;

describe("drift", () => {
  it("is the worst corner, not the average", () => {
    // Three corners still and one sliding is a detection changing its mind
    // about where an edge is - the average would hide it.
    const moved: Quad = [quad()[0], quad()[1], quad()[2], { x: 70 + 40, y: 300 }];
    expect(quadDrift(quad(), moved)).toBeCloseTo(40);
  });
});

describe("the lock", () => {
  it("engages on a hand-held phone", () => {
    const history = Array.from({ length: LOCK_FRAMES }, (_, i) => quad(i * shake, -i * shake * 0.5));
    const lock = steadyLock(history, W, H);
    expect(lock).not.toBeNull();
    // The NEWEST quad - the one the shutter is about to capture.
    expect(lock).toEqual(history[history.length - 1]);
  });

  it("does not engage while the phone is still moving to the subject", () => {
    const sweep = Math.min(W, H) * LOCK_DRIFT * 3;
    const history = Array.from({ length: LOCK_FRAMES }, (_, i) => quad(i * sweep, 0));
    expect(steadyLock(history, W, H)).toBeNull();
  });

  it("breaks on a single missed detection", () => {
    const history: (Quad | null)[] = [quad(), quad(), null, quad(), quad()];
    expect(steadyLock(history, W, H)).toBeNull();
  });

  it("needs a full run of frames, not a lucky pair", () => {
    expect(steadyLock([quad(), quad()], W, H)).toBeNull();
  });

  it("judges only the recent past - an old miss is forgiven", () => {
    const history: (Quad | null)[] = [null, null, ...Array.from({ length: LOCK_FRAMES }, () => quad())];
    expect(steadyLock(history, W, H)).not.toBeNull();
  });
});
