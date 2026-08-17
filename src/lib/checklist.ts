// A checklist written once on a procedure, stamped onto every task it makes.
//
// The steps of a PM were already writable - in the notes box, as prose. Prose
// is not tickable, so a fourteen-step teardown either became one checkbox
// somebody ticked at the end, or fourteen items retyped by hand on every unit,
// every visit. This is the template that ends both.
//
// Stored as lines rather than as JSON. A checklist IS a list of lines, people
// paste them in from an SOP, and a textarea that round-trips what you typed is
// worth more here than a structure with an editor around it.

export type ChecklistLine = { text: string; heading: boolean };

/**
 * Bullets people paste in from a document or a chat message.
 *
 * A number needs whitespace after its dot to count as a bullet; a dash or a box
 * does not. Without that asymmetry "1.5 mm shim" loses its "1." and becomes a
 * different measurement, which is the kind of silent edit that ends up on a
 * bench.
 */
const BULLET = /^(?:(?:[-*•]|\[\s*[xX]?\s*\])\s*|\d+[.)]\s+)/;

/** Strip the bullet off a pasted line. Trims first: "  - foo" is bulleted too. */
const bare = (line: string) => line.trim().replace(BULLET, "").trim();

export const MAX_CHECKLIST_ITEMS = 60;
export const MAX_ITEM_TEXT = 200;

/**
 * Read a typed checklist into items and section headings.
 *
 * A line ending in a colon is a HEADING - "Remove & Sonicate:" labels the two
 * boxes under it rather than being a box itself. That convention is not
 * invented here; it is how people already write a checklist, so the rule is
 * that what you type is what you meant. Everything else is an item, with any
 * bullet or empty [ ] it was pasted with stripped off.
 *
 * Tolerant by design: blank lines vanish, whitespace goes, and nothing in here
 * can fail. A checklist that refused to save because of a stray character
 * would be retyped into the notes box, which is the thing this replaces.
 */
export function parseChecklist(raw: string): ChecklistLine[] {
  return raw
    .split("\n")
    .map(bare)
    .filter(Boolean)
    .slice(0, MAX_CHECKLIST_ITEMS)
    .map((l) => ({ text: l.slice(0, MAX_ITEM_TEXT), heading: l.endsWith(":") }))
    // A heading with nothing under it is a label for nothing. Dropping it here
    // means the colon convention can't leave a stray title on a task.
    .filter((l, i, all) => !l.heading || all.slice(i + 1).some((x) => !x.heading));
}

/** Back to the text somebody typed, for the editor. */
export const serializeChecklist = (lines: ChecklistLine[]): string =>
  lines.map((l) => l.text).join("\n");

/**
 * How many boxes there are and how many are ticked.
 *
 * Headings are not boxes. Counting them would report a finished job as 12/14
 * forever, and nobody would ever find the two steps they had apparently
 * missed.
 */
export function checklistProgress(
  items: { done: boolean; heading?: boolean }[],
): { done: number; total: number; complete: boolean } {
  const boxes = items.filter((i) => !i.heading);
  const done = boxes.filter((i) => i.done).length;
  return { done, total: boxes.length, complete: boxes.length > 0 && done === boxes.length };
}

/** One line typed into the "add an item" box, or nothing worth adding. */
export function cleanItem(raw: string): ChecklistLine | null {
  const text = bare(raw).slice(0, MAX_ITEM_TEXT);
  return text ? { text, heading: text.endsWith(":") } : null;
}
