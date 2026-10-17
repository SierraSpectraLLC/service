/**
 * Fingers on the remote desktop, turned into what they mean.
 *
 * The vocabulary is the one phone remote-control apps settled on, so somebody
 * who has used one is not relearning anything:
 *
 *   one finger, tap            click
 *   one finger, hold and lift  right-click
 *   one finger, hold then move drag (left button held)
 *   one finger, move           pan the view (touch mode) or move the cursor
 *                              (trackpad mode)
 *   two fingers, tap           right-click
 *   two fingers, pinch         zoom, and pan by moving both
 *   two fingers, move together scroll the far machine
 *
 * This file only recognises; it never touches the screen or the wire. Points
 * come in as box coordinates with a timestamp, actions go out through a
 * callback, and the component decides what a "tap" does in the current mode.
 * That is what lets every one of these rules be tested by replaying touches.
 *
 * The thresholds are the conventional ones: a finger has to travel 10px before
 * it counts as moving (a fingertip wobbles), and a hold is 500ms - Android's
 * long-press and close to iOS's.
 */

export type GestureAction =
  /** One finger, down and up without moving. */
  | { type: "tap"; x: number; y: number }
  /** A finger has been held long enough to mean something; feedback only. */
  | { type: "hold"; x: number; y: number }
  /** Right-click: a hold lifted in place, or a two-finger tap. */
  | { type: "secondary"; x: number; y: number }
  /** One finger moving freely: a view pan, or the cursor in trackpad mode. */
  | { type: "move"; x: number; y: number; dx: number; dy: number }
  /** Held, then moved: the left button goes down and follows the finger. */
  | { type: "dragStart"; x: number; y: number }
  | { type: "dragMove"; x: number; y: number; dx: number; dy: number }
  | { type: "dragEnd"; x: number; y: number }
  /** Two fingers spreading or closing: zoom by `factor` about (x, y), then pan. */
  | { type: "pinch"; x: number; y: number; factor: number; dx: number; dy: number }
  /** Two fingers moving together: scroll by the distance moved, at (x, y). */
  | { type: "scroll"; x: number; y: number; dx: number; dy: number };

export const SLOP = 10;
export const HOLD_MS = 500;
/** A two-finger tap has to be quick; a slow one was a pinch that didn't start. */
export const TWO_TAP_MS = 300;
/** How much two fingers must spread or close, in px, before it is a pinch. */
export const PINCH_SLOP = 24;

type Pt = { x: number; y: number };

type State =
  | { kind: "idle" }
  | { kind: "one"; id: number; start: Pt; at: Pt; t0: number; held: boolean; moving: boolean }
  | { kind: "drag"; id: number; at: Pt }
  | { kind: "two"; ids: [number, number]; t0: number; d0: number; m0: Pt; d: number; m: Pt; lock: "none" | "pinch" | "scroll" }
  /** Done with this gesture; ignore everything until the last finger lifts. */
  | { kind: "lifting" };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class GestureRecognizer {
  private state: State = { kind: "idle" };
  private down = new Map<number, Pt>();

  constructor(private emit: (a: GestureAction) => void) {}

  /** True while any finger is on the glass. */
  get active() { return this.down.size > 0; }

  pointerDown(id: number, x: number, y: number, t: number) {
    this.down.set(id, { x, y });
    const st = this.state;
    if (st.kind === "idle" && this.down.size === 1) {
      this.state = { kind: "one", id, start: { x, y }, at: { x, y }, t0: t, held: false, moving: false };
    } else if (st.kind === "one" && this.down.size === 2) {
      // A second finger turns whatever the first was doing into a two-finger
      // gesture - unless the first already became a drag, which owns the hand.
      const other = this.down.get(st.id)!;
      const d = dist(other, { x, y }), m = mid(other, { x, y });
      this.state = { kind: "two", ids: [st.id, id], t0: t, d0: d, m0: m, d, m, lock: "none" };
    } else if (st.kind === "two" || (st.kind === "one" && this.down.size > 2)) {
      // A third finger is not a gesture this knows. Stop rather than guess.
      this.state = { kind: "lifting" };
    }
  }

  pointerMove(id: number, x: number, y: number, t: number) {
    if (!this.down.has(id)) return;
    this.down.set(id, { x, y });
    const st = this.state;

    if (st.kind === "one" && st.id === id) {
      this.timeCheck(t);
      const dx = x - st.at.x, dy = y - st.at.y;
      if (!st.moving && dist(st.start, { x, y }) < SLOP) return;
      if (!st.moving) {
        st.moving = true;
        if (st.held) {
          this.state = { kind: "drag", id, at: { x, y } };
          this.emit({ type: "dragStart", x: st.start.x, y: st.start.y });
          this.emit({ type: "dragMove", x, y, dx: x - st.start.x, dy: y - st.start.y });
          return;
        }
        // The first move carries the slop too, so the view does not jump 10px
        // late and then lag the finger for the rest of the gesture.
        this.emit({ type: "move", x, y, dx: x - st.start.x, dy: y - st.start.y });
        st.at = { x, y };
        return;
      }
      this.emit({ type: "move", x, y, dx, dy });
      st.at = { x, y };
      return;
    }

    if (st.kind === "drag" && st.id === id) {
      this.emit({ type: "dragMove", x, y, dx: x - st.at.x, dy: y - st.at.y });
      st.at = { x, y };
      return;
    }

    if (st.kind === "two" && st.ids.includes(id)) {
      const a = this.down.get(st.ids[0]), b = this.down.get(st.ids[1]);
      if (!a || !b) return;
      const d = dist(a, b), m = mid(a, b);
      if (st.lock === "none") {
        // Decide once per gesture. Spreading wins over sliding, because a pinch
        // nearly always drifts a little and a scroll almost never spreads.
        if (Math.abs(d - st.d0) >= PINCH_SLOP) st.lock = "pinch";
        else if (dist(m, st.m0) >= SLOP) st.lock = "scroll";
        else return;
        // Start from where the gesture began, so the slop is not lost.
        st.d = st.d0; st.m = st.m0;
      }
      if (st.lock === "pinch") {
        this.emit({ type: "pinch", x: m.x, y: m.y, factor: st.d > 0 ? d / st.d : 1, dx: m.x - st.m.x, dy: m.y - st.m.y });
      } else {
        this.emit({ type: "scroll", x: m.x, y: m.y, dx: m.x - st.m.x, dy: m.y - st.m.y });
      }
      st.d = d; st.m = m;
    }
  }

  pointerUp(id: number, x: number, y: number, t: number) {
    if (!this.down.has(id)) return;
    this.down.delete(id);
    const st = this.state;

    if (st.kind === "one" && st.id === id) {
      this.timeCheck(t);
      if (!st.moving) {
        this.emit(st.held ? { type: "secondary", x: st.start.x, y: st.start.y } : { type: "tap", x: st.start.x, y: st.start.y });
      }
    } else if (st.kind === "drag" && st.id === id) {
      this.emit({ type: "dragEnd", x, y });
    } else if (st.kind === "two") {
      if (st.lock === "none" && t - st.t0 <= TWO_TAP_MS) this.emit({ type: "secondary", x: st.m0.x, y: st.m0.y });
      // Lifting one of two fingers ends the gesture. Picking up again with the
      // one left behind would pan or click wherever it happens to be resting.
      if (this.down.size > 0) { this.state = { kind: "lifting" }; return; }
    }
    if (this.down.size === 0) this.state = { kind: "idle" };
    else if (this.state.kind !== "idle") this.state = { kind: "lifting" };
  }

  /** The browser took the touch away (a system gesture, a call coming in). */
  pointerCancel(id: number) {
    if (!this.down.has(id)) return;
    this.down.delete(id);
    const st = this.state;
    // A button left down on the far machine is the one outcome worth preventing.
    if (st.kind === "drag" && st.id === id) this.emit({ type: "dragEnd", x: st.at.x, y: st.at.y });
    this.state = this.down.size === 0 ? { kind: "idle" } : { kind: "lifting" };
  }

  /**
   * Called on a timer while a finger rests, so the hold registers - and its
   * feedback shows - at the moment it happens rather than when the finger next
   * moves or lifts.
   */
  timeCheck(t: number) {
    const st = this.state;
    if (st.kind === "one" && !st.held && !st.moving && t - st.t0 >= HOLD_MS) {
      st.held = true;
      this.emit({ type: "hold", x: st.start.x, y: st.start.y });
    }
  }
}
