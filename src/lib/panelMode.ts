// Which shape a record page takes, and who decides.
//
// Two layouts, one set of panels. BANDS lay every panel down a single scroll
// under labelled headings with a jump bar - nothing hidden, and flipping to
// check a part number never loses sight of the task it was for. The RAIL shows
// one working context at a time with the others a click away down the side.
//
// Bands won the first argument and the page grew past them: sixteen panels is
// three screens of scroll whichever way they are labelled, and on a phone the
// jump bar wraps to three sticky rows that eat a third of the viewport. The
// rail answers that, and costs the thing bands were protecting - so it is a
// preference, per person, not a migration.
//
// Pure, because the default is a rule rather than a value and both the server
// page and the client layout have to reach the same answer or the page flips
// shape one frame after it arrives.

export const PANEL_MODES = ["rail", "bands"] as const;
export type PanelMode = (typeof PANEL_MODES)[number];

export const isPanelMode = (v: unknown): v is PanelMode =>
  typeof v === "string" && (PANEL_MODES as readonly string[]).includes(v);

/**
 * The shape this view takes when nobody has said otherwise.
 *
 * The system page is the one that outgrew bands, so it is the one that changes.
 * An asset and a work order carry a third of the panels and read perfectly as
 * bands today; changing them would be change for its own sake, and every one of
 * their readers would have to discover a new page they did not ask for.
 */
export const defaultMode = (viewKey: string): PanelMode =>
  viewKey === "system" ? "rail" : "bands";

/** What this person gets, saved choice first. */
export const modeFor = (viewKey: string, saved: { mode?: unknown } | null): PanelMode =>
  isPanelMode(saved?.mode) ? saved.mode : defaultMode(viewKey);

/**
 * The record's standing, as a tone.
 *
 * Pure and shared because two things read it and they must agree: the standing
 * line's own colours, and the `data-standing` attribute on the page root that
 * publishes --spine down to the working pane's rack rail. Custom properties
 * inherit downward, not sideways - so the attribute has to sit on an ancestor
 * of BOTH, which means the page sets it and this is the one rule it sets it by.
 *
 * Ours and nothing late is the ordinary state of a working system and reads
 * calm. Somebody else's is amber from the first day: it is not wrong, it is
 * just not moving, and staying visible is the entire point. Either becomes red
 * once something behind the wait is already past a date somebody committed to.
 */
export const standingTone = (
  s: { isMine: boolean; overdue: boolean },
): "good" | "warn" | "bad" =>
  s.overdue ? "bad" : s.isMine ? "good" : "warn";
