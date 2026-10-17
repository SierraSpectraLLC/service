/**
 * What the far machine is sent when somebody points, clicks, scrolls or types.
 *
 * The engine's decoder (public/vendor/meshcentral) has its own mouse encoder,
 * but it works out coordinates from the page: `pageX` minus the canvas's offset,
 * times the canvas's width over its client width. That arithmetic knows nothing
 * of a CSS transform, and the viewer zooms by transforming the canvas - so every
 * click would land somewhere else the moment anybody pinched. These encoders
 * take the remote pixel directly and leave the mapping to the view, which is the
 * one place that knows where the picture is.
 *
 * The bytes are the engine's own (agent-desktop-0.0.2.js, SendMouseMsg and
 * SendKeyMsgKC in 1.2.4): a 2-byte command, a 2-byte length, then the payload.
 * Messages are binary strings, one char per byte, because that is what the
 * transport's `send` takes.
 */

const MOUSE = 2;

/** The engine's button bits. Down sends the bit, up sends it doubled. */
export const BUTTON = { left: 0x02, right: 0x08, middle: 0x20 } as const;
export type Button = keyof typeof BUTTON;

/** DOM `MouseEvent.button` to ours. Anything past the middle is a right click. */
export function domButton(b: number): Button {
  return b === 0 ? "left" : b === 1 ? "middle" : "right";
}

const bytes = (...b: number[]) => String.fromCharCode(...b.map((x) => x & 0xff));
const u16 = (x: number) => bytes(x >> 8, x);

/** A remote coordinate on the wire: whole pixels, never negative. */
const coord = (x: number) => Math.max(0, Math.min(0xffff, Math.round(x)));

export function mouseMove(x: number, y: number): string {
  return bytes(0, MOUSE, 0, 10, 0, 0) + u16(coord(x)) + u16(coord(y));
}

export function mouseButton(kind: "down" | "up", button: Button, x: number, y: number): string {
  const bit = BUTTON[button];
  return bytes(0, MOUSE, 0, 10, 0, kind === "down" ? bit : bit * 2) + u16(coord(x)) + u16(coord(y));
}

/**
 * One wheel movement. Positive scrolls up (away from the user), as on Windows,
 * where 120 is one notch. The engine writes a negative delta as 255 minus each
 * byte of its magnitude, so that is what is written here - matching its quirk
 * rather than "fixing" it is the point.
 */
export const WHEEL_NOTCH = 120;
const WHEEL_MAX = 30000;

export function mouseWheel(x: number, y: number, delta: number): string {
  const d = Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, Math.round(delta)));
  const abs = Math.abs(d);
  const hi = d < 0 ? 255 - (abs >> 8) : d >> 8;
  const lo = d < 0 ? 255 - (abs & 0xff) : d & 0xff;
  return bytes(0, MOUSE, 0, 12, 0, 0) + u16(coord(x)) + u16(coord(y)) + bytes(hi, lo);
}

// ---------------- Keys ----------------

/**
 * One thing to tell the far keyboard. `vk` is a Windows virtual-key code, which
 * the agent maps for whatever it runs on; `char` is typed as itself, which is
 * what makes a phone's keyboard work regardless of either side's layout.
 */
export type KeyOp =
  | { kind: "vk"; action: "down" | "up"; kc: number; ext: boolean }
  | { kind: "char"; action: "down" | "up"; code: number };

/** Keys named by `KeyboardEvent.key`, as Windows virtual-key codes. */
export const VK: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19,
  CapsLock: 20, Escape: 27, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 44,
  Insert: 45, Delete: 46, Meta: 91, ContextMenu: 93, NumLock: 144, ScrollLock: 145,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

/**
 * Keys that live on the extended half of a PC keyboard. Sent without the flag,
 * Windows reads the arrows as the number pad's 2/4/6/8 whenever Num Lock is off.
 * The engine's own list, plus the Windows key, which its Start button sends
 * extended too.
 */
const EXTENDED_KEYS = new Set([
  "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "Insert",
  "Delete", "PageUp", "PageDown", "NumLock", "Pause", "Meta",
]);
const EXTENDED_CODES = new Set(["ShiftRight", "AltRight", "ControlRight", "NumpadDivide", "NumpadEnter"]);

export const isExtended = (key: string, code = "") => EXTENDED_KEYS.has(key) || EXTENDED_CODES.has(code);

export type KeyLike = {
  key: string; code?: string; keyCode?: number;
  ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean;
};

/**
 * The virtual key for a printable character, when one exists. Needed only when a
 * modifier is down: Ctrl+C typed as the character "c" is just a c, so a shortcut
 * has to go as the key.
 */
export function vkForChar(ch: string): number | null {
  if (/^[a-z]$/i.test(ch)) return ch.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(ch)) return ch.charCodeAt(0);
  if (ch === " ") return 32;
  return null;
}

/**
 * A physical key going down or up, as the ops to send - or none, for the keys
 * a browser reports while it is busy composing (`Dead`, `Process`, and the 229
 * that phone keyboards send for everything).
 *
 * A plain printable key goes as its character. That is what the engine's own
 * console does, and it is what keeps a French keyboard typing French on an
 * English machine. Anything with Ctrl, Alt or the Windows key held goes as the
 * key itself, because a shortcut is a key, not a character.
 */
export function keyEventOps(e: KeyLike, action: "down" | "up"): KeyOp[] {
  if (e.keyCode === 229 || e.key === "Dead" || e.key === "Process" || e.key === "Unidentified") return [];
  const chorded = e.ctrlKey || e.altKey || e.metaKey;
  if (e.key.length === 1 && !chorded) return [{ kind: "char", action, code: e.key.charCodeAt(0) }];
  const named = VK[e.key];
  if (named !== undefined) return [{ kind: "vk", action, kc: named, ext: isExtended(e.key, e.code) }];
  if (e.key.length === 1) {
    const kc = vkForChar(e.key) ?? (e.keyCode && e.keyCode > 0 ? e.keyCode : null);
    return kc === null ? [] : [{ kind: "vk", action, kc, ext: false }];
  }
  return [];
}

/** Press and release one named key. */
export function tapKey(key: string): KeyOp[] {
  const kc = VK[key];
  if (kc === undefined) return [];
  const ext = isExtended(key);
  return [{ kind: "vk", action: "down", kc, ext }, { kind: "vk", action: "up", kc, ext }];
}

export type Modifier = "Control" | "Alt" | "Shift" | "Meta";

/**
 * Wrap some key presses in held modifiers: down in order, the keys, then up in
 * reverse. This is how the on-screen Ctrl, Alt and Win work - a phone keyboard
 * has none of them, so they are latched on the bar and spent on the next key.
 */
export function withModifiers(mods: Modifier[], inner: KeyOp[]): KeyOp[] {
  const press = (m: Modifier, action: "down" | "up"): KeyOp =>
    ({ kind: "vk", action, kc: VK[m], ext: isExtended(m) });
  return [...mods.map((m) => press(m, "down")), ...inner, ...[...mods].reverse().map((m) => press(m, "up"))];
}

/**
 * Typed text, as key presses. A new line is the Enter key rather than a
 * character, since that is what every program on the far side listens for.
 * With a modifier latched, letters and digits go as keys so that Ctrl and a
 * typed "c" make Ctrl+C.
 *
 * Text is walked in UTF-16 units, which is what Windows's own Unicode input
 * takes: a character outside the basic plane arrives as its two halves.
 */
export function textOps(text: string, mods: Modifier[] = []): KeyOp[] {
  const out: KeyOp[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let inner: KeyOp[];
    if (ch === "\n" || ch === "\r") inner = tapKey("Enter");
    else if (ch === "\t") inner = tapKey("Tab");
    else {
      const kc = mods.length > 0 ? vkForChar(ch) : null;
      inner = kc !== null
        ? [{ kind: "vk", action: "down", kc, ext: false }, { kind: "vk", action: "up", kc, ext: false }]
        : [{ kind: "char", action: "down", code: text.charCodeAt(i) }, { kind: "char", action: "up", code: text.charCodeAt(i) }];
    }
    out.push(...(mods.length > 0 ? withModifiers(mods, inner) : inner));
  }
  return out;
}

/**
 * What changed in a text box between two readings: how many characters came off
 * the end, and what went on instead.
 *
 * A phone keyboard is driven through a hidden text box, and a phone keyboard
 * does not reliably say which key was pressed - Android reports nearly all of
 * them as 229, and a predictive keyboard replaces whole words at once. What it
 * does reliably do is change the text. So the box is read before and after, and
 * the difference is typed on the far machine: backspaces for what was removed,
 * then the new characters. Autocorrect replacing "teh" with "the" therefore
 * arrives as three backspaces and "the", exactly as it looked on the phone.
 */
export function textChange(before: string, after: string): { erase: number; insert: string } {
  let same = 0;
  const max = Math.min(before.length, after.length);
  while (same < max && before.charCodeAt(same) === after.charCodeAt(same)) same++;
  return { erase: before.length - same, insert: after.slice(same) };
}
