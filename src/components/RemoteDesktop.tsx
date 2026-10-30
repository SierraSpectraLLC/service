"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Dropdown from "@/components/Dropdown";
import { openRemoteTunnel } from "@/app/actions";
import type { ViewerCredentials } from "@/lib/remote";
import { loadEngine, RELAY_SAYS, type MeshRedirect } from "@/components/meshEngine";
import RemoteFiles from "@/components/RemoteFiles";
import { GestureRecognizer, HOLD_MS, type GestureAction } from "@/lib/remoteGestures";
import {
  domButton, keyEventOps, mouseButton, mouseMove, mouseWheel, tapKey, textChange, textOps, VK, vkForChar,
  withModifiers, type Button, type KeyOp, type Modifier,
} from "@/lib/remoteInput";
import {
  clamp, fitted, follow, isFitted, panBy, resize, toBox, toRemote, zoomAt, type Size, type View,
} from "@/lib/remoteView";

/**
 * The far machine's desktop, on our own canvas, with phone controls.
 *
 * The framed console (RemoteFrame) is the engine's page, built for a mouse and
 * a desk. On a phone it could be made to fit but not to work: no pinch, no pan,
 * taps landing wherever the scaled-down page put them, and typing only through
 * a dialog. This draws the same desktop stream itself, so the controls are ours:
 *
 *   - zoom and pan with two fingers, like a photo;
 *   - Touch mode - tap where you see it - or Trackpad mode, where a finger
 *     steers a cursor for precise work on small targets;
 *   - the phone's own keyboard, typed straight through, with a bar for the keys
 *     it lacks (Esc, Tab, Ctrl, Alt, Win, arrows);
 *   - expand to the whole screen.
 *
 * With a mouse it is an ordinary remote desktop: click, wheel, keyboard while
 * focused, and Ctrl+wheel (a laptop trackpad's pinch) zooms.
 *
 * How it works:
 *   1. Two scripts from the engine (vendored under public/vendor/meshcentral,
 *      Apache-2.0) decode the stream onto the canvas and carry it over the
 *      relay. Pictures and the transport stay theirs.
 *   2. Input does NOT go through their mouse code - it reads coordinates off
 *      the page and knows nothing of our zoom. lib/remoteView turns a finger
 *      into a remote pixel and lib/remoteInput writes the bytes.
 *   3. The page's connectRemoteDevice decided, audited and minted our end of
 *      the relay; openRemoteTunnel asks the machine to come to it. Both run on
 *      the server, and the engine's admin channel never reaches the browser.
 *
 * Keys go to the machine only while the desktop (or its keyboard) has focus.
 * Typing elsewhere on this page must never arrive on somebody's instrument PC.
 */

const SAYS = RELAY_SAYS;

type Mode = "touch" | "trackpad";
const MODE_KEY = "rdesk-mode";

/** Finger travel to wheel units: 30px of two-finger slide is one notch. */
const SCROLL_GAIN = 4;
/** Hold small scroll deltas back until they add up to this, to spare the wire. */
const SCROLL_STEP = 40;
/** How close the cursor may come to the edge before the view follows it. */
const FOLLOW_MARGIN = 48;
/**
 * What the phone's keyboard types into. Never empty: a backspace in an empty
 * box changes nothing, and nothing changing is invisible to textChange. Two
 * characters so a single backspace always has something to remove.
 */
const SENTINEL = "##";

/** The keys a phone keyboard lacks, in the order they're reached for. */
const BAR_KEYS: { label: string; key: string; aria?: string }[] = [
  { label: "Esc", key: "Escape" },
  { label: "Tab", key: "Tab" },
  { label: "←", key: "ArrowLeft", aria: "Left arrow" },
  { label: "↑", key: "ArrowUp", aria: "Up arrow" },
  { label: "↓", key: "ArrowDown", aria: "Down arrow" },
  { label: "→", key: "ArrowRight", aria: "Right arrow" },
  { label: "Del", key: "Delete" },
  { label: "Home", key: "Home" },
  { label: "End", key: "End" },
  { label: "PgUp", key: "PageUp" },
  { label: "PgDn", key: "PageDown" },
  { label: "F5", key: "F5" },
];
const BAR_MODS: { label: string; mod: Modifier }[] = [
  { label: "Ctrl", mod: "Control" },
  { label: "Alt", mod: "Alt" },
  { label: "Shift", mod: "Shift" },
  { label: "Win", mod: "Meta" },
];

export default function RemoteDesktop({ deviceId, creds, machineName }: {
  deviceId: number; creds: ViewerCredentials; machineName: string;
}) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const markRef = useRef<HTMLDivElement | null>(null);
  const imeRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionRef = useRef<{ redirect: MeshRedirect } | null>(null);

  const [state, setState] = useState(0);
  const [everLive, setEverLive] = useState(false);
  const [started, setStarted] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>("touch");
  const [zoomPct, setZoomPct] = useState(0);
  const [fittedNow, setFittedNow] = useState(true);
  const [kbOpen, setKbOpen] = useState(false);
  const [mods, setMods] = useState<Modifier[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  // The view, the remote cursor and the sizes change at touch rate - 60 times a
  // second during a pinch - so they live in refs and are written to the DOM
  // directly. React state only carries what the toolbar shows.
  const view = useRef<View>({ s: 1, tx: 0, ty: 0 });
  const screen = useRef<Size>({ w: 0, h: 0 });
  const box = useRef<Size>({ w: 0, h: 0 });
  const cursor = useRef({ x: 0, y: 0 });
  const modeRef = useRef<Mode>("touch");
  const modsRef = useRef<Modifier[]>([]);
  const live = state === 3;

  // ---------------- The session ----------------

  const stop = useCallback(() => {
    const s = sessionRef.current;
    sessionRef.current = null;
    if (!s) return;
    try { s.redirect.Stop(); } catch { /* already down */ }
    setState(0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(""); setNote(""); setEverLive(false); setStarted(false);

    (async () => {
      let w;
      try {
        w = await loadEngine();
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
        return;
      }
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const module = w.CreateAgentRemoteDesktop(canvas, null);
      // The transport asks "a server" to bring the machine to the relay, by
      // calling send() with a tunnel request. Ours goes to openRemoteTunnel,
      // which checks again, writes it down and asks the host from the server
      // side - the host won't take that request from a browser on another site,
      // and the agent's half of the credential never comes here.
      const server = {
        send: (o: unknown) => {
          const msg = o as { type?: string; value?: string };
          const id = msg.type === "tunnel" && typeof msg.value === "string"
            ? new URLSearchParams(msg.value.split("?")[1] ?? "").get("id") : null;
          if (!id) return;
          openRemoteTunnel(deviceId, id).then(
            (r) => { if (!cancelled && r.error) { setError(r.error); stop(); } },
            () => { if (!cancelled) { setError("Couldn't reach the portal to start the session."); stop(); } },
          );
        },
      };
      const redirect = w.CreateAgentRedirect(server, module, null, creds.relayAuth, null, "/");
      // Ours is not the engine's page, so the relay address is told, not
      // inferred from the address bar. See the vendor NOTICE.
      redirect.relayBase = creds.relayBase;
      redirect.attemptWebRTC = false;
      redirect.onStateChanged = (_s, st) => {
        if (cancelled) return;
        setState(st);
        if (st === 3) setEverLive(true);
      };
      redirect.onConsoleMessageChange = () => { if (!cancelled) setNote(redirect.consoleMessage ?? ""); };
      module.onScreenSizeChange = () => {
        if (cancelled) return;
        const next = { w: module.ScreenWidth, h: module.ScreenHeight };
        if (next.w === screen.current.w && next.h === screen.current.h) return;
        screen.current = next;
        cursor.current = { x: Math.floor(next.w / 2), y: Math.floor(next.h / 2) };
        view.current = fitted(next, box.current);
        paint();
      };
      sessionRef.current = { redirect };
      setStarted(true);
      redirect.Start(creds.nodeId);
    })();

    return () => { cancelled = true; stop(); };
    // paint is stable (refs only); listing it would restart the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds, deviceId, stop]);

  const send = useCallback((bytes: string) => {
    const r = sessionRef.current?.redirect;
    if (r && r.State === 3) r.m.send(bytes);
  }, []);

  const sendKeys = useCallback((ops: KeyOp[]) => {
    const m = sessionRef.current?.redirect;
    if (!m || m.State !== 3) return;
    for (const op of ops) {
      const action = op.action === "down" ? 1 : 2;
      if (op.kind === "char") m.m.SendKeyUnicode(action, op.code);
      else m.m.SendKeyMsgKC(action, op.kc, op.ext);
    }
  }, []);

  // ---------------- Painting ----------------

  /** Write the view and the overlays to the DOM. Cheap; called per frame. */
  const paint = useCallback(() => {
    const c = canvasRef.current;
    const v = view.current;
    if (c && screen.current.w > 0) {
      c.style.width = `${screen.current.w}px`;
      c.style.height = `${screen.current.h}px`;
      c.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`;
    }
    const cur = cursorRef.current;
    if (cur) {
      const p = toBox(v, cursor.current.x, cursor.current.y);
      // The arrow's tip is its top-left corner; put the tip on the pixel.
      cur.style.transform = `translate(${p.x - 0.5 * v.s}px, ${p.y - 0.5 * v.s}px)`;
    }
    const pct = Math.round(v.s * 100);
    setZoomPct((was) => (was === pct ? was : pct));
    const f = isFitted(v, screen.current, box.current);
    setFittedNow((was) => (was === f ? was : f));
  }, []);

  const setView = useCallback((v: View) => { view.current = v; paint(); }, [paint]);

  // The trackpad cursor mounts with the mode; put it where the cursor is.
  useEffect(() => { paint(); }, [mode, live, paint]);

  // The stage's size is the box. A phone turned sideways, the viewer expanded,
  // the keyboard coming up - all arrive here.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      const was = box.current;
      if (next.w === was.w && next.h === was.h) return;
      box.current = next;
      if (screen.current.w === 0) return;
      view.current = was.w === 0 ? fitted(screen.current, next) : resize(view.current, screen.current, was, next);
      paint();
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [paint]);

  /** A brief ring where a tap landed, or a steady one while a hold is armed. */
  const mark = useCallback((x: number, y: number, kind: "tap" | "hold" | "off") => {
    const el = markRef.current;
    if (!el) return;
    // "off" takes down a hold ring and nothing else: a tap's ripple has to be
    // left to finish, and it starts in the same lift that clears the hold.
    if (kind === "off") { if (el.classList.contains("hold")) el.className = "rdesk-mark"; return; }
    el.className = "rdesk-mark";
    el.style.transform = `translate(${x}px, ${y}px)`;
    // Re-adding the class restarts the animation for a second tap in place.
    void el.offsetWidth;
    el.className = `rdesk-mark ${kind}`;
  }, []);

  // ---------------- Pointer output ----------------

  // Moves are coalesced to one per frame. A phone reports touches at 120Hz on
  // some screens, and the far end has no use for more moves than it can draw.
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const moveFrame = useRef(0);
  const flushMove = useCallback(() => {
    if (moveFrame.current) { cancelAnimationFrame(moveFrame.current); moveFrame.current = 0; }
    const p = pendingMove.current;
    pendingMove.current = null;
    if (p) send(mouseMove(p.x, p.y));
  }, [send]);
  const queueMove = useCallback((x: number, y: number) => {
    pendingMove.current = { x, y };
    if (!moveFrame.current) moveFrame.current = requestAnimationFrame(() => { moveFrame.current = 0; flushMove(); });
  }, [flushMove]);

  /** Button events always go after any move still waiting, never before it. */
  const press = useCallback((kind: "down" | "up", button: Button, x: number, y: number) => {
    flushMove();
    send(mouseButton(kind, button, x, y));
  }, [flushMove, send]);

  const click = useCallback((button: Button, x: number, y: number) => {
    flushMove();
    send(mouseMove(x, y));
    send(mouseButton("down", button, x, y));
    send(mouseButton("up", button, x, y));
  }, [flushMove, send]);

  const scrollAcc = useRef(0);
  const wheel = useCallback((x: number, y: number, delta: number) => {
    flushMove();
    send(mouseWheel(x, y, delta));
  }, [flushMove, send]);

  /** Trackpad mode: nudge the cursor, faster the faster the finger moves. */
  const moveCursorBy = useCallback((dx: number, dy: number) => {
    const s = screen.current;
    if (s.w === 0) return;
    const accel = 1 + Math.min(Math.hypot(dx, dy) / 12, 1.5);
    const v = view.current;
    const x = Math.max(0, Math.min(s.w - 1, cursor.current.x + (dx * accel) / v.s));
    const y = Math.max(0, Math.min(s.h - 1, cursor.current.y + (dy * accel) / v.s));
    cursor.current = { x, y };
    queueMove(x, y);
    view.current = follow(v, x, y, FOLLOW_MARGIN, s, box.current);
    paint();
  }, [paint, queueMove]);

  // ---------------- Gestures ----------------

  const onGesture = useCallback((a: GestureAction) => {
    const s = screen.current, b = box.current;
    if (s.w === 0) return;
    const touch = modeRef.current === "touch";
    // In touch mode the finger is the pointer; in trackpad mode the cursor is.
    const at = (x: number, y: number) => {
      if (!touch) return cursor.current;
      const r = toRemote(view.current, x, y, s);
      cursor.current = r;
      return r;
    };
    const here = () => toBox(view.current, cursor.current.x, cursor.current.y);

    switch (a.type) {
      case "tap": {
        const r = at(a.x, a.y);
        click("left", r.x, r.y);
        const p = touch ? a : here();
        mark(p.x, p.y, "tap");
        break;
      }
      case "hold": {
        const p = touch ? a : here();
        mark(p.x, p.y, "hold");
        try { navigator.vibrate?.(12); } catch { /* not on this phone */ }
        break;
      }
      case "secondary": {
        const r = at(a.x, a.y);
        click("right", r.x, r.y);
        const p = touch ? a : here();
        mark(p.x, p.y, "tap");
        break;
      }
      case "move":
        if (touch) setView(panBy(view.current, a.dx, a.dy, s, b));
        else moveCursorBy(a.dx, a.dy);
        break;
      case "dragStart": {
        mark(0, 0, "off");
        const r = at(a.x, a.y);
        flushMove();
        send(mouseMove(r.x, r.y));
        press("down", "left", r.x, r.y);
        break;
      }
      case "dragMove":
        if (touch) {
          // Dragging into the edge of a zoomed view carries the view along, so
          // a window can be dragged further than the part that is on screen.
          const edge = 32, step = 10;
          const dx = a.x < edge ? step : a.x > b.w - edge ? -step : 0;
          const dy = a.y < edge ? step : a.y > b.h - edge ? -step : 0;
          if (dx || dy) view.current = panBy(view.current, dx, dy, s, b);
          const r = at(a.x, a.y);
          queueMove(r.x, r.y);
          paint();
        } else moveCursorBy(a.dx, a.dy);
        break;
      case "dragEnd":
        press("up", "left", cursor.current.x, cursor.current.y);
        break;
      case "pinch": {
        const z = zoomAt(view.current, a.factor, a.x, a.y, s, b);
        setView(panBy(z, a.dx, a.dy, s, b));
        break;
      }
      case "scroll": {
        // Natural direction, as on the phone itself: fingers up, page up the
        // screen, which on the far machine is the wheel turning towards you.
        scrollAcc.current += a.dy * SCROLL_GAIN;
        if (Math.abs(scrollAcc.current) < SCROLL_STEP) break;
        const delta = Math.trunc(scrollAcc.current);
        scrollAcc.current -= delta;
        const r = touch ? toRemote(view.current, a.x, a.y, s) : cursor.current;
        wheel(r.x, r.y, delta);
        break;
      }
    }
  }, [click, flushMove, mark, moveCursorBy, paint, press, queueMove, send, setView, wheel]);

  const recognizer = useRef<GestureRecognizer | null>(null);
  const onGestureRef = useRef(onGesture);
  onGestureRef.current = onGesture;
  if (!recognizer.current) recognizer.current = new GestureRecognizer((a) => onGestureRef.current(a));
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------- Pointer input ----------------

  const local = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Which mouse buttons we have told the far end are down, so a release that
  // happens off the stage (or a lost focus) can still be sent.
  const mouseDown = useRef(new Set<Button>());

  /** Controls drawn over the desktop (Reconnect, the help card) are not the desktop. */
  const onControl = (t: EventTarget | null) => t instanceof Element && t.closest("button, a, .rdesk-help") !== null;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (screen.current.w === 0 || onControl(e.target)) return;
    const p = local(e);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* fine */ }
    if (e.pointerType === "mouse") {
      // Focus is what lets the keyboard through; a click on the desktop is the
      // natural way to say "I'm typing into that now".
      stageRef.current?.focus({ preventScroll: true });
      const r = toRemote(view.current, p.x, p.y, screen.current);
      cursor.current = r;
      const b = domButton(e.button);
      mouseDown.current.add(b);
      flushMove();
      send(mouseMove(r.x, r.y));
      press("down", b, r.x, r.y);
      e.preventDefault();
      return;
    }
    setHelpOpen(false);
    recognizer.current!.pointerDown(e.pointerId, p.x, p.y, performance.now());
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => recognizer.current!.timeCheck(performance.now()), HOLD_MS + 10);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (screen.current.w === 0) return;
    const p = local(e);
    if (e.pointerType === "mouse") {
      const r = toRemote(view.current, p.x, p.y, screen.current);
      cursor.current = r;
      queueMove(r.x, r.y);
      return;
    }
    recognizer.current!.pointerMove(e.pointerId, p.x, p.y, performance.now());
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = local(e);
    if (e.pointerType === "mouse") {
      const b = domButton(e.button);
      if (!mouseDown.current.delete(b)) return;
      const r = screen.current.w ? toRemote(view.current, p.x, p.y, screen.current) : cursor.current;
      press("up", b, r.x, r.y);
      return;
    }
    recognizer.current!.pointerUp(e.pointerId, p.x, p.y, performance.now());
    if (!recognizer.current!.active && holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    mark(0, 0, "off");
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") return;
    recognizer.current!.pointerCancel(e.pointerId);
    mark(0, 0, "off");
  };

  // Listeners React can't attach the way they're needed: non-passive, so they
  // can refuse the browser's own handling.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // The wheel scrolls the far machine; Ctrl+wheel - which is also what a
    // laptop trackpad's pinch sends - zooms the view.
    const onWheel = (e: WheelEvent) => {
      if (screen.current.w === 0) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const px = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? r.height : 1);
      if (e.ctrlKey) {
        setView(zoomAt(view.current, Math.exp(-px * 0.01), x, y, screen.current, box.current));
        return;
      }
      const at = toRemote(view.current, x, y, screen.current);
      // A wheel notch arrives as 100px in Chromium; the engine sends it as 360.
      wheel(at.x, at.y, -px * 3.6);
    };
    // Cancelling the touch itself keeps iOS from blurring the keyboard's text
    // box when the desktop is tapped, and from raising its own text-selection
    // and magnifier over a long press. Pointer events still arrive.
    const onTouch = (e: TouchEvent) => { if (!onControl(e.target)) e.preventDefault(); };
    // Safari's pinch-to-zoom-the-page, which touch-action alone doesn't stop.
    const onGestureStart = (e: Event) => { e.preventDefault(); };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouch, { passive: false });
    el.addEventListener("touchmove", onTouch, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouch);
      el.removeEventListener("touchmove", onTouch);
      el.removeEventListener("gesturestart", onGestureStart);
    };
  }, [setView, wheel]);

  // ---------------- Keyboard: a physical one ----------------

  // Virtual keys we've sent down, so a focus lost mid-chord lets them all go.
  const keysDown = useRef(new Map<number, boolean>());
  const trackKeys = (ops: KeyOp[]) => {
    for (const op of ops) {
      if (op.kind !== "vk") continue;
      if (op.action === "down") keysDown.current.set(op.kc, op.ext); else keysDown.current.delete(op.kc);
    }
  };
  const releaseAll = useCallback(() => {
    const ops: KeyOp[] = [...keysDown.current].map(([kc, ext]) => ({ kind: "vk", action: "up", kc, ext }));
    keysDown.current.clear();
    sendKeys(ops);
    for (const b of mouseDown.current) press("up", b, cursor.current.x, cursor.current.y);
    mouseDown.current.clear();
  }, [press, sendKeys]);

  const onStageKey = (e: React.KeyboardEvent<HTMLDivElement>, action: "down" | "up") => {
    // The phone keyboard's text box lives inside the stage and does its own
    // sending; its keys bubbling up here would type everything twice.
    if (!live || e.target !== e.currentTarget) return;
    const ops = keyEventOps(e.nativeEvent, action);
    if (ops.length === 0) return;
    e.preventDefault();
    trackKeys(ops);
    sendKeys(ops);
  };

  // ---------------- Keyboard: the phone's ----------------

  const lastText = useRef(SENTINEL);
  const composing = useRef(false);

  const resetIme = () => {
    const ta = imeRef.current;
    if (!ta) return;
    ta.value = SENTINEL;
    lastText.current = SENTINEL;
    try { ta.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch { /* not focused */ }
  };

  /** Spend the latched modifiers: they apply to exactly one key. */
  const takeMods = () => {
    const m = modsRef.current;
    if (m.length) { modsRef.current = []; setMods([]); }
    return m;
  };

  const typeChange = () => {
    const ta = imeRef.current;
    if (!ta) return;
    const { erase, insert } = textChange(lastText.current, ta.value);
    lastText.current = ta.value;
    const ops: KeyOp[] = [];
    for (let i = 0; i < erase; i++) ops.push(...tapKey("Backspace"));
    if (insert) ops.push(...textOps(insert, takeMods()));
    sendKeys(ops);
    // Mid-composition the keyboard is still working on this text; resetting
    // it now would throw the word away under the user's thumb.
    if (!composing.current || !ta.value.startsWith(SENTINEL)) resetIme();
  };

  const onImeKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const n = e.nativeEvent;
    if (n.isComposing || n.keyCode === 229) return;
    const chord = n.ctrlKey || n.altKey || n.metaKey;
    const named = VK[n.key] !== undefined && n.key.length > 1;
    // Plain characters arrive through the text instead, which is the only
    // route a phone keyboard reliably takes. Named keys and shortcuts (an iPad
    // with a keyboard case) are sent as keys.
    if (!named && !(chord && n.key.length === 1)) return;
    e.preventDefault();
    const held: Modifier[] = [
      ...(n.ctrlKey ? ["Control" as const] : []), ...(n.altKey ? ["Alt" as const] : []),
      ...(n.shiftKey && named ? ["Shift" as const] : []), ...(n.metaKey ? ["Meta" as const] : []),
    ];
    if (["Control", "Alt", "Shift", "Meta"].includes(n.key)) return;
    const kc = named ? VK[n.key] : vkForChar(n.key);
    if (kc === null || kc === undefined) return;
    const inner = named ? tapKey(n.key) : [
      { kind: "vk", action: "down", kc, ext: false }, { kind: "vk", action: "up", kc, ext: false },
    ] as KeyOp[];
    const all = [...new Set([...takeMods(), ...held])];
    sendKeys(all.length ? withModifiers(all, inner) : inner);
  };

  const barKey = (key: string) => {
    const m = takeMods();
    sendKeys(m.length ? withModifiers(m, tapKey(key)) : tapKey(key));
  };
  const toggleMod = (mod: Modifier) => {
    const next = modsRef.current.includes(mod) ? modsRef.current.filter((m) => m !== mod) : [...modsRef.current, mod];
    modsRef.current = next;
    setMods(next);
  };

  // Whether the keyboard was up when the button was pressed. Read at the press,
  // because by the click the press itself may already have taken focus away.
  const kbWasOpen = useRef(false);

  // Called straight from the button's own tap: iOS only raises the keyboard
  // for a focus that happens inside a user gesture.
  const toggleKeyboard = () => {
    const ta = imeRef.current;
    if (!ta) return;
    if (kbWasOpen.current) { ta.blur(); return; }
    resetIme();
    ta.focus({ preventScroll: true });
  };

  // ---------------- Modes, expanding, everything else ----------------

  useEffect(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved === "touch" || saved === "trackpad") { modeRef.current = saved; setMode(saved); }
    } catch { /* storage blocked; touch it is */ }
  }, []);

  const chooseMode = (m: Mode) => {
    modeRef.current = m;
    setMode(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* fine */ }
  };

  // Expanded, the viewer is the height of what is actually visible. With a
  // phone keyboard up that is well short of the window, and 100dvh would put
  // the bottom of the desktop - and the key bar - behind the keyboard.
  useEffect(() => {
    const root = rootRef.current;
    if (!expanded || !root) return;
    const vv = window.visualViewport;
    const fit = () => { if (vv) root.style.setProperty("--rdesk-vh", `${vv.height}px`); };
    fit();
    vv?.addEventListener("resize", fit);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      vv?.removeEventListener("resize", fit);
      root.style.removeProperty("--rdesk-vh");
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    // Real full screen where the browser has it (Android, desktop); iPhone
    // Safari doesn't, and the fixed layout above stands in.
    try {
      if (next && document.fullscreenEnabled && !document.fullscreenElement) {
        void rootRef.current?.requestFullscreen?.().catch(() => { /* the fixed layout still applies */ });
      } else if (!next && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    } catch { /* fine */ }
  };
  useEffect(() => {
    // Leaving full screen with the system's own gesture should collapse too.
    const onFs = () => { if (!document.fullscreenElement) setExpanded(false); };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const dotClass = error ? "bad" : live ? "live" : state === 0 ? "" : "wait";
  // Back to "not connected" after trying: either a session that ran and
  // finished, or a machine that never came to the relay.
  const ended = started && state === 0 && !error;
  const status = error
    || (ended ? (everLive ? "Session ended" : "The machine didn't answer") : SAYS[state] ?? "Connecting…");

  return (
    <div ref={rootRef} className={`rdesk${expanded ? " expanded" : ""}`}>
      <div className="rdesk-bar">
        {/* Connected is the dot alone: a phone's width is better spent on the
            controls, and every other state is spelled out over the desktop. */}
        <span className="rdesk-status" role="status" title={status}>
          <span className={`rdesk-dot ${dotClass}`} aria-hidden />
          <span className={live ? "sr-only" : undefined}>{status}</span>
        </span>
        <span className="rdesk-tools">
          <button type="button" className="btn sm" disabled={!live} aria-pressed={kbOpen}
            aria-label={kbOpen ? "Hide keyboard" : "Keyboard"} title={kbOpen ? "Hide keyboard" : "Keyboard"}
            onPointerDown={(e) => { kbWasOpen.current = document.activeElement === imeRef.current; e.preventDefault(); }}
            onClick={toggleKeyboard}>
            <span aria-hidden>⌨</span>
          </button>
          {/* On a phone's width the bar has room for one row, and Files is the
              control people look for; the mode is chosen once and lives in
              More there (below). */}
          <span className="seg rdesk-wide-only" role="group" aria-label="Pointer mode">
            <button type="button" aria-pressed={mode === "touch"} onClick={() => chooseMode("touch")}>Touch</button>
            <button type="button" aria-pressed={mode === "trackpad"} onClick={() => chooseMode("trackpad")}>Trackpad</button>
          </span>
          {/* On the bar, not in More: somebody who can't find file transfer
              opens another remote tool to do it, and keeps using that one. */}
          <button type="button" className="btn sm" aria-pressed={filesOpen}
            aria-label={filesOpen ? "Hide files" : "Files"} title="Copy files to and from this machine"
            onClick={() => setFilesOpen((o) => !o)}>
            <span aria-hidden>📁</span> Files
          </button>
          <button type="button" className="btn sm" onClick={toggleExpanded}
            aria-label={expanded ? "Exit full screen" : "Full screen"} title={expanded ? "Exit full screen" : "Full screen"}>
            <span aria-hidden>{expanded ? "⤡" : "⤢"}</span>
          </button>
          <Dropdown label="More">
            <button type="button" className="rdesk-narrow-only" aria-pressed={mode === "touch"} onClick={() => chooseMode("touch")}>
              {mode === "touch" ? "✓ " : ""}Touch mode - tap where you see it
            </button>
            <button type="button" className="rdesk-narrow-only" aria-pressed={mode === "trackpad"} onClick={() => chooseMode("trackpad")}>
              {mode === "trackpad" ? "✓ " : ""}Trackpad mode - move a cursor
            </button>
            <button type="button" disabled={!live} onClick={() => sessionRef.current?.redirect.m.SendCtrlAltDelMsg()}>
              Send Ctrl+Alt+Del
            </button>
            <button type="button" disabled={!live} onClick={() => sessionRef.current?.redirect.m.SendRefresh()}>
              Redraw the screen
            </button>
            <button type="button" onClick={() => setHelpOpen((o) => !o)}>
              {helpOpen ? "Hide" : "Show"} touch controls
            </button>
            {live && <button type="button" onClick={stop}>Disconnect</button>}
          </Dropdown>
        </span>
      </div>

      <div className={`rdesk-body${filesOpen ? " files-open" : ""}`}>
      <div
        ref={stageRef}
        className="rdesk-stage"
        // Focusable so a physical keyboard can be pointed at the desktop.
        tabIndex={0}
        aria-label={`Remote desktop for ${machineName}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => onStageKey(e, "down")}
        onKeyUp={(e) => onStageKey(e, "up")}
        onBlur={releaseAll}
      >
        <canvas ref={canvasRef} className="rdesk-canvas" width={0} height={0} />
        <div ref={markRef} className="rdesk-mark" />
        {live && mode === "trackpad" && (
          <div ref={cursorRef} className="rdesk-cursor" aria-hidden>
            <svg viewBox="0 0 20 20" width="20" height="20"><path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" /></svg>
          </div>
        )}
        {/* Zoomed in, the way back out is right where the zoom level is. */}
        {live && !fittedNow && (
          <button type="button" className="pill neutral rdesk-zoom" aria-label={`${zoomPct}%, fit to screen`}
            onClick={() => setView(fitted(screen.current, box.current))}>
            {zoomPct}% · Fit
          </button>
        )}

        {!live && (
          <div className="rdesk-cover">
            <span>{status}</span>
            {note && <span className="t-small">{note}</span>}
            {state !== 0 && !error && (
              <span className="t-small">
                If this stays here, the machine is off, asleep, or hasn&apos;t checked in since it was last on.
              </span>
            )}
            {(ended || error) && (
              <button type="button" className="btn sm" onClick={() => router.refresh()}>Reconnect</button>
            )}
          </div>
        )}
        {live && note && <span className="pill warn rdesk-note">{note}</span>}

        {helpOpen && (
          <div className="card rdesk-help" onPointerDown={(e) => e.stopPropagation()}>
            <div className="card-title t-body">{mode === "touch" ? "Touch mode" : "Trackpad mode"}</div>
            <dl>
              {mode === "touch" ? <>
                <dt>Tap</dt><dd>Click where you tap</dd>
                <dt>Hold, lift</dt><dd>Right-click</dd>
                <dt>Hold, move</dt><dd>Drag (select text, move a window)</dd>
                <dt>Drag</dt><dd>Move around the screen</dd>
              </> : <>
                <dt>Drag</dt><dd>Move the cursor</dd>
                <dt>Tap</dt><dd>Click at the cursor</dd>
                <dt>Hold, lift</dt><dd>Right-click at the cursor</dd>
                <dt>Hold, move</dt><dd>Drag from the cursor</dd>
              </>}
              <dt>Two-finger tap</dt><dd>Right-click</dd>
              <dt>Two fingers</dt><dd>Scroll</dd>
              <dt>Pinch</dt><dd>Zoom in and out</dd>
            </dl>
            <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setHelpOpen(false)}>Got it</button>
          </div>
        )}

        {/* What the phone's keyboard types into. Inside the stage, so iOS
            scrolls the desktop - not the page header - into view above it. */}
        <textarea
          ref={imeRef}
          className="rdesk-ime"
          aria-label="Type on the remote machine"
          autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
          defaultValue={SENTINEL}
          onFocus={() => { setKbOpen(true); resetIme(); }}
          onBlur={() => { setKbOpen(false); releaseAll(); }}
          onKeyDown={onImeKeyDown}
          onInput={typeChange}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; typeChange(); }}
        />
      </div>

      {filesOpen && <RemoteFiles deviceId={deviceId} machineName={machineName} onClose={() => setFilesOpen(false)} />}
      </div>

      {kbOpen && (
        <div className="rdesk-keys" role="toolbar" aria-label="Special keys"
          // Pressing a key here must not take focus from the text box, or the
          // phone's keyboard drops the moment a key on this bar is touched.
          onPointerDown={(e) => e.preventDefault()}>
          {BAR_MODS.map((m) => (
            <button key={m.mod} type="button" className="btn sm" aria-pressed={mods.includes(m.mod)}
              onClick={() => toggleMod(m.mod)}>{m.label}</button>
          ))}
          {BAR_KEYS.map((k) => (
            <button key={k.key} type="button" className="btn sm" aria-label={k.aria}
              onClick={() => barKey(k.key)}>{k.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
