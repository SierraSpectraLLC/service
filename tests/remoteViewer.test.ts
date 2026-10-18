import { describe, expect, it } from "vitest";
import {
  BUTTON, keyEventOps, mouseButton, mouseMove, mouseWheel, tapKey, textChange, textOps, withModifiers,
} from "@/lib/remoteInput";
import { clamp, fitScale, fitted, follow, isFitted, MAX_SCALE, panBy, resize, toBox, toRemote, zoomAt } from "@/lib/remoteView";
import { GestureRecognizer, HOLD_MS, type GestureAction } from "@/lib/remoteGestures";

// The phone viewer is three small machines - bytes for the wire, arithmetic for
// the view, and a recogniser for fingers - and none of them needs a screen to be
// wrong. A click that lands 40px off, or a drag that leaves the button down on a
// customer's PC, is found here or on a real machine; here is cheaper.

const codes = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe("wire encoding", () => {
  it("writes a move as the engine's 10-byte mouse message", () => {
    expect(codes(mouseMove(300, 1025))).toEqual([0, 2, 0, 10, 0, 0, 1, 44, 4, 1]);
  });

  it("sends a button's bit going down and twice it coming up", () => {
    expect(codes(mouseButton("down", "left", 1, 2))[5]).toBe(BUTTON.left);
    expect(codes(mouseButton("up", "left", 1, 2))[5]).toBe(BUTTON.left * 2);
    expect(codes(mouseButton("down", "right", 1, 2))[5]).toBe(BUTTON.right);
    expect(codes(mouseButton("up", "right", 1, 2))[5]).toBe(BUTTON.right * 2);
  });

  it("never sends a negative or fractional coordinate", () => {
    expect(codes(mouseMove(-5, 10.6)).slice(6)).toEqual([0, 0, 0, 11]);
  });

  it("encodes the wheel exactly as the engine does, sign quirk included", () => {
    // 360 = 0x0168 up; down is written as 255 minus each byte of the magnitude.
    expect(codes(mouseWheel(0, 0, 360)).slice(10)).toEqual([0x01, 0x68]);
    expect(codes(mouseWheel(0, 0, -360)).slice(10)).toEqual([255 - 0x01, 255 - 0x68]);
    expect(codes(mouseWheel(0, 0, 360))[3]).toBe(12);
  });
});

describe("keys", () => {
  it("types a plain character as itself, so the far layout doesn't matter", () => {
    expect(keyEventOps({ key: "é" }, "down")).toEqual([{ kind: "char", action: "down", code: 0xe9 }]);
  });

  it("sends a shortcut as the key, not the character", () => {
    expect(keyEventOps({ key: "c", ctrlKey: true }, "down")).toEqual([{ kind: "vk", action: "down", kc: 67, ext: false }]);
  });

  it("marks the arrows and the editing block as extended keys", () => {
    expect(keyEventOps({ key: "ArrowLeft" }, "down")[0]).toMatchObject({ kc: 37, ext: true });
    expect(keyEventOps({ key: "Delete" }, "down")[0]).toMatchObject({ kc: 46, ext: true });
    expect(keyEventOps({ key: "Control", code: "ControlRight" }, "down")[0]).toMatchObject({ kc: 17, ext: true });
    expect(keyEventOps({ key: "Control", code: "ControlLeft" }, "down")[0]).toMatchObject({ kc: 17, ext: false });
  });

  it("ignores what a phone keyboard reports while composing", () => {
    expect(keyEventOps({ key: "Unidentified", keyCode: 229 }, "down")).toEqual([]);
    expect(keyEventOps({ key: "a", keyCode: 229 }, "down")).toEqual([]);
    expect(keyEventOps({ key: "Dead" }, "down")).toEqual([]);
  });

  it("turns a new line into Enter and wraps latched modifiers around each key", () => {
    expect(textOps("\n")).toEqual(tapKey("Enter"));
    expect(textOps("c", ["Control"])).toEqual(withModifiers(["Control"], [
      { kind: "vk", action: "down", kc: 67, ext: false }, { kind: "vk", action: "up", kc: 67, ext: false },
    ]));
    // Released in reverse, so Ctrl+Alt comes off as Alt then Ctrl.
    const ops = withModifiers(["Control", "Alt"], []);
    expect(ops.map((o) => o.kind === "vk" && `${o.action}${o.kc}`)).toEqual(["down17", "down18", "up18", "up17"]);
  });

  it("reads autocorrect as backspaces and the replacement", () => {
    expect(textChange("> teh", "> the")).toEqual({ erase: 2, insert: "he" });
    expect(textChange("> ", ">")).toEqual({ erase: 1, insert: "" });
    expect(textChange("> ", "> hi")).toEqual({ erase: 0, insert: "hi" });
  });
});

describe("view", () => {
  const screen = { w: 1920, h: 1080 };
  const phone = { w: 400, h: 600 };

  it("fits the whole screen and centres it", () => {
    const v = fitted(screen, phone);
    expect(v.s).toBeCloseTo(400 / 1920);
    expect(v.tx).toBe(0);
    expect(v.ty).toBeCloseTo((600 - 1080 * v.s) / 2);
  });

  it("keeps the pixel under the fingers still while zooming", () => {
    const v0 = fitted(screen, phone);
    const before = toRemote(v0, 200, 300, screen);
    const v1 = zoomAt(v0, 2, 200, 300, screen, phone);
    expect(v1.s).toBeCloseTo(v0.s * 2);
    const after = toRemote(v1, 200, 300, screen);
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  });

  it("won't zoom out past fitting, or in past the limit", () => {
    const v0 = fitted(screen, phone);
    expect(zoomAt(v0, 0.1, 0, 0, screen, phone).s).toBeCloseTo(fitScale(screen, phone));
    expect(zoomAt(v0, 1000, 0, 0, screen, phone).s).toBe(MAX_SCALE);
  });

  it("stops panning at the desktop's edge", () => {
    const v = clamp({ s: 1, tx: 0, ty: 0 }, screen, phone);
    expect(panBy(v, 500, 500, screen, phone)).toMatchObject({ tx: 0, ty: 0 });
    expect(panBy(v, -5000, -5000, screen, phone)).toMatchObject({ tx: 400 - 1920, ty: 600 - 1080 });
  });

  it("maps a point back to the remote pixel it is drawn over", () => {
    const v = { s: 2, tx: -100, ty: -50 };
    const p = toBox(v, 640, 360);
    expect(toRemote(v, p.x, p.y, screen)).toEqual({ x: 640, y: 360 });
    expect(toRemote(v, -9999, 9999, screen)).toEqual({ x: 0, y: 1079 });
  });

  it("slides the view along when the cursor is pushed at an edge", () => {
    const v = clamp({ s: 1, tx: 0, ty: 0 }, screen, phone);
    const moved = follow(v, 395, 100, 40, screen, phone);
    expect(toBox(moved, 395, 100).x).toBeLessThanOrEqual(400 - 40 + 0.5);
    expect(follow(v, 200, 200, 40, screen, phone)).toBe(v);
  });

  it("stays fitted when the phone turns, and keeps the centre when zoomed", () => {
    const land = { w: 800, h: 360 };
    expect(isFitted(resize(fitted(screen, phone), screen, phone, land), screen, land)).toBe(true);
    const z = zoomAt(fitted(screen, phone), 4, 200, 300, screen, phone);
    const centre = toRemote(z, 200, 300, screen);
    const r = resize(z, screen, phone, land);
    const after = toRemote(r, 400, 180, screen);
    expect(Math.abs(after.x - centre.x)).toBeLessThanOrEqual(1);
  });
});

describe("gestures", () => {
  const run = () => {
    const out: GestureAction[] = [];
    return { g: new GestureRecognizer((a) => out.push(a)), out, types: () => out.map((a) => a.type) };
  };

  it("reads a quick touch as a tap where it landed", () => {
    const { g, out } = run();
    g.pointerDown(1, 50, 60, 0);
    g.pointerMove(1, 53, 62, 40);   // inside the slop - a wobble, not a move
    g.pointerUp(1, 53, 62, 90);
    expect(out).toEqual([{ type: "tap", x: 50, y: 60 }]);
  });

  it("reads a hold lifted in place as a right-click, with feedback at the hold", () => {
    const { g, types } = run();
    g.pointerDown(1, 50, 60, 0);
    g.timeCheck(HOLD_MS);
    g.pointerUp(1, 50, 60, HOLD_MS + 100);
    expect(types()).toEqual(["hold", "secondary"]);
  });

  it("reads a hold then a move as a drag, starting where the finger went down", () => {
    const { g, out, types } = run();
    g.pointerDown(1, 50, 60, 0);
    g.timeCheck(HOLD_MS);
    g.pointerMove(1, 80, 60, HOLD_MS + 50);
    g.pointerMove(1, 120, 60, HOLD_MS + 80);
    g.pointerUp(1, 120, 60, HOLD_MS + 100);
    expect(types()).toEqual(["hold", "dragStart", "dragMove", "dragMove", "dragEnd"]);
    expect(out[1]).toEqual({ type: "dragStart", x: 50, y: 60 });
  });

  it("reads a move before the hold as a pan or cursor move, never a click", () => {
    const { g, out, types } = run();
    g.pointerDown(1, 50, 60, 0);
    g.pointerMove(1, 70, 60, 50);
    g.pointerMove(1, 90, 60, 80);
    g.timeCheck(HOLD_MS + 10);      // a long move is still a move
    g.pointerUp(1, 90, 60, HOLD_MS + 20);
    expect(types()).toEqual(["move", "move"]);
    // The first move includes the slop, so nothing is lost.
    expect(out.reduce((s, a) => s + (a.type === "move" ? a.dx : 0), 0)).toBe(40);
  });

  it("reads two quick fingers as a right-click between them", () => {
    const { g, out } = run();
    g.pointerDown(1, 100, 100, 0);
    g.pointerDown(2, 140, 100, 20);
    g.pointerUp(1, 100, 100, 120);
    g.pointerUp(2, 140, 100, 130);
    expect(out).toEqual([{ type: "secondary", x: 120, y: 100 }]);
  });

  it("reads spreading fingers as a zoom", () => {
    const { g, out } = run();
    g.pointerDown(1, 100, 100, 0);
    g.pointerDown(2, 200, 100, 10);
    g.pointerMove(2, 300, 100, 50);
    const pinches = out.filter((a) => a.type === "pinch");
    expect(pinches.length).toBe(1);
    expect(pinches[0].type === "pinch" && pinches[0].factor).toBeCloseTo(2);
  });

  it("reads two fingers moving together as a scroll", () => {
    const { g, out } = run();
    g.pointerDown(1, 100, 300, 0);
    g.pointerDown(2, 150, 300, 10);
    g.pointerMove(1, 100, 260, 40);
    g.pointerMove(2, 150, 260, 41);
    const scrolls = out.filter((a) => a.type === "scroll");
    expect(scrolls.length).toBeGreaterThan(0);
    expect(scrolls.reduce((s, a) => s + (a.type === "scroll" ? a.dy : 0), 0)).toBeCloseTo(-40);
  });

  it("does nothing with the finger left behind after a two-finger gesture", () => {
    const { g, types } = run();
    g.pointerDown(1, 100, 100, 0);
    g.pointerDown(2, 200, 100, 10);
    g.pointerMove(2, 300, 100, 50);
    g.pointerUp(2, 300, 100, 60);
    g.pointerMove(1, 10, 10, 70);
    g.pointerUp(1, 10, 10, 80);
    expect(types()).toEqual(["pinch"]);
  });

  it("lets go of the button if the browser takes the touch mid-drag", () => {
    const { g, types } = run();
    g.pointerDown(1, 50, 60, 0);
    g.timeCheck(HOLD_MS);
    g.pointerMove(1, 90, 60, HOLD_MS + 50);
    g.pointerCancel(1);
    expect(types()).toEqual(["hold", "dragStart", "dragMove", "dragEnd"]);
  });
});
