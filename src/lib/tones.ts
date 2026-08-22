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
