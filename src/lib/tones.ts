/**
 * The status vocabulary. Seven meanings; globals.css owns what each looks
 * like (--t-{tone}-bg/-fg, .pill.{tone}, .dot.{tone}). Code that used to
 * export {bg, fg} hex pairs now exports one of these names instead, so the
 * same status looks the same on every page - and changing what "warn" looks
 * like is a one-line CSS edit.
 *
 * Two things are deliberately NOT tones: stage colors (per-tenant rows in
 * stage_defs, arbitrary hex by design) and email templates (lib/digest,
 * lib/eodEmail) - mail clients read inline hex, not our stylesheet. Both
 * keep their own colors.
 */
export type Tone = "neutral" | "faint" | "info" | "good" | "warn" | "accent" | "bad";

/**
 * The same pairs globals.css declares as --t-{tone}-bg/-fg, for the one
 * surface CSS can't reach: email. A record that is a tone in the UI (a gas
 * status pill) resolves back to hex here when the digest renders it.
 * tests/tones.test.ts parses globals.css and fails if the two drift.
 */
export const TONE_HEX: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: "#EEF1F5", fg: "#475569" },
  faint: { bg: "#F4F6F9", fg: "#94A3B8" },
  info: { bg: "#E7F2FA", fg: "#1D6396" },
  good: { bg: "#E5F3E5", fg: "#2E6B2E" },
  warn: { bg: "#FAF0DC", fg: "#8A5410" },
  accent: { bg: "#EDEBFA", fg: "#4F45A3" },
  bad: { bg: "#FBE9E9", fg: "#A32D2D" },
};
