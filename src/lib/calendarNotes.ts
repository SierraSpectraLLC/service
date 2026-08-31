// Notes people write onto the calendar themselves.
//
// The one thing on the calendar that is not derived from a row somewhere else,
// and the rules for it are here so the form and the action refuse the same
// things in the same words - see db/schema.calendarNotes for why it exists at
// all.

/** How far a single note may span. */
export const NOTE_MAX_DAYS = 60;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A day that actually exists.
 *
 * The round trip is the whole check and it is not pedantry: Date.parse takes
 * "2026-02-31" happily and rolls it to March 3rd, so shape-and-parse alone
 * calls a nonexistent day valid. Stored, that note would be drawn on a date no
 * month grid has a cell for - saved, confirmed, and invisible ever after.
 */
export const isDay = (s: string): boolean => {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export type NoteInput = { onDate: string; endsOn?: string; title: string; note?: string };

/**
 * What is wrong with this note, or null.
 *
 * A TITLE is required and a date is required; everything else is optional. The
 * bound on the span is not fussiness - a note is drawn on every day it covers,
 * so a typo'd year would paint three hundred and sixty-five cells and bury the
 * work underneath it.
 *
 * A note about the PAST is allowed on purpose. People write these up after the
 * fact - "the site was shut this week, that is why nobody got in" - and a
 * calendar that refuses the explanation is a calendar that keeps the mystery.
 */
export function checkNote(input: NoteInput): string | null {
  if (!input.title.trim()) return "Give it a title - a date with no words is not a note";
  if (!isDay(input.onDate)) return "Pick the day it starts";
  const ends = (input.endsOn ?? "").trim();
  if (ends) {
    if (!isDay(ends)) return "That end date is not a date";
    if (ends < input.onDate) return "It cannot end before it starts";
    if (daysBetween(input.onDate, ends) > NOTE_MAX_DAYS) {
      return `A note can cover at most ${NOTE_MAX_DAYS} days - split a longer one up`;
    }
  }
  return null;
}

/** Whole days from a to b, both ISO. Negative when b is before a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * Every day one note covers, in range.
 *
 * A note is one row and the calendar is per-day, so a shutdown week has to
 * become five cells somewhere; here, rather than in the component, so the
 * agenda and the grid cannot disagree about which days it covers. Clipped to
 * the window being drawn, so a note that starts in the previous month still
 * shows on the days of this one that it reaches.
 */
export function noteDays(
  note: { onDate: string; endsOn: string }, from: string, to: string,
): string[] {
  if (!isDay(note.onDate)) return [];
  const last = isDay(note.endsOn) && note.endsOn > note.onDate ? note.endsOn : note.onDate;
  const start = note.onDate > from ? note.onDate : from;
  const end = last < to ? last : to;
  if (start > end) return [];
  const out: string[] = [];
  const cur = new Date(`${start}T00:00:00Z`);
  // Bounded by the span rule above, and by the window either way.
  for (let i = 0; i <= NOTE_MAX_DAYS + 40; i++) {
    const iso = cur.toISOString().slice(0, 10);
    if (iso > end) break;
    out.push(iso);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * What a note says on a day it covers.
 *
 * The span is spelled out on every cell rather than only the first, because
 * the calendar is read a week at a time: landing on the Wednesday of a
 * shutdown and seeing an unqualified "Site closed" tells you nothing about
 * whether Thursday is clear.
 */
export function noteLabel(
  note: { onDate: string; endsOn: string; title: string }, day: string,
): string {
  const spans = isDay(note.endsOn) && note.endsOn > note.onDate;
  if (!spans) return note.title;
  const n = daysBetween(note.onDate, note.endsOn) + 1;
  const at = daysBetween(note.onDate, day) + 1;
  return `${note.title} (${at}/${n})`;
}
