// Something a person noticed and said out loud.
//
// The trail (lib/trail) records what the MACHINE noticed - a page opened, an
// exception thrown. That is the smaller half. The failures that actually cost
// a shop money throw nothing: a total that adds up wrong, a button that looks
// pressable and is not, a filter that silently drops a row. No browser has an
// event for "this number is wrong", so the only instrument that finds those is
// a person, and the only thing that gets it out of their head is a box they
// can reach from wherever they are standing when they see it.
//
// WHAT MAKES A REPORT USEFUL is not the prose. It is the route, the build, the
// viewport and the last few pages - every one of which the app already knows
// and none of which anybody thinks to type. So the form asks for one sentence
// and captures the rest, and shows what it captured before it sends.
// Collection somebody can see is collection somebody consented to.
//
// Pure. Callers hand in the rows.

export const REPORT_KINDS = ["bug", "idea"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const KIND_LABEL: Record<ReportKind, string> = {
  bug: "Something is wrong",
  idea: "Something could be better",
};

/**
 * new    - filed, nobody has looked
 * open   - somebody has, and it is real
 * fixed  - it was wrong and now it is not
 * closed - not a bug, not going to change, or already gone
 *
 * Four, because three could not tell "we are on it" from "we agree it is
 * broken and are not doing it", and those are the two answers a reporter most
 * needs to be able to tell apart. Somebody who cannot tell them apart stops
 * filing, which is the only way this feature really fails.
 */
export const REPORT_STATES = ["new", "open", "fixed", "closed"] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export const STATE_LABEL: Record<ReportState, string> = {
  new: "New",
  open: "Looking at it",
  fixed: "Fixed",
  closed: "Closed",
};

export const STATE_TONE: Record<ReportState, "warn" | "info" | "good" | "faint"> = {
  new: "warn", open: "info", fixed: "good", closed: "faint",
};

/** Still somebody's to answer. */
export const reportOpen = (status: string): boolean =>
  status === "new" || status === "open";

/** Ending one needs a word about why; picking it up does not. */
export const needsResolution = (status: string): boolean =>
  status === "fixed" || status === "closed";

export type Breadcrumb = { at: string; kind: string; route: string; message: string };

/** The most of somebody's own recent minutes worth freezing onto a report. */
export const MAX_BREADCRUMBS = 12;
export const BREADCRUMB_MINUTES = 60;

export function serializeCrumbs(rows: Breadcrumb[]): string {
  return rows.length ? JSON.stringify(rows.slice(0, MAX_BREADCRUMBS)) : "";
}

/**
 * Read them back, tolerantly.
 *
 * This column is rendered on every row of the list. A stray character in one
 * report must not take the rest of the queue down with it, so anything
 * unreadable is no breadcrumbs rather than a thrown page.
 */
export function parseCrumbs(raw: string): Breadcrumb[] {
  if (!raw.trim()) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      .map((x) => ({
        at: String(x.at ?? ""),
        kind: String(x.kind ?? ""),
        route: String(x.route ?? ""),
        message: String(x.message ?? "").slice(0, 300),
      }))
      .slice(0, MAX_BREADCRUMBS);
  } catch {
    return [];
  }
}

/** "/money/invoices/12 · 1400x900 · build 9f2c1ab" - where they were, one line. */
export function whereLine(r: {
  route: string; query: string; viewport: string; buildSha: string;
}): string {
  return [
    r.route + (r.query ? `?${r.query}` : ""),
    r.viewport,
    r.buildSha ? `build ${r.buildSha.slice(0, 7)}` : "",
  ].filter(Boolean).join(" · ");
}

/**
 * The browser, in the two words that decide whether a bug is reproducible.
 *
 * A full user-agent string is unreadable and mostly lies about itself; what
 * somebody chasing a layout bug needs is which engine and whether it was a
 * phone. Anything unrecognized comes back as the raw string rather than as a
 * confident guess.
 */
export function browserLine(ua: string): string {
  const s = ua.trim();
  if (!s) return "";
  const mobile = /Mobile|Android|iPhone|iPad/i.test(s);
  const engine = /Edg\//.test(s) ? "Edge"
    : /OPR\//.test(s) ? "Opera"
      : /Chrome\//.test(s) ? "Chrome"
        : /Firefox\//.test(s) ? "Firefox"
          : /Safari\//.test(s) ? "Safari"
            : "";
  if (!engine) return s.slice(0, 60);
  return `${engine}${mobile ? " on a phone" : ""}`;
}

/** Everything wrong with a report somebody is filing. Empty means it can go. */
export function reportProblems(r: { title: string; kind: string }): string[] {
  const out: string[] = [];
  if (r.title.trim().length < 4) out.push("Say what happened, in a line");
  if (!(REPORT_KINDS as readonly string[]).includes(r.kind)) out.push("Pick what kind of thing this is");
  return out;
}

/**
 * Blocking and open first, then newest.
 *
 * "Somebody cannot work" outranks "somebody is annoyed", and both outrank
 * anything already settled - a list that buried the blocker under thirty
 * closed rows would be a list nobody opens twice.
 */
export function rankReports<T extends { status: string; blocking: boolean; id: number }>(rows: T[]): T[] {
  const weight = (r: T) => (reportOpen(r.status) ? (r.blocking ? 0 : 1) : 2);
  return [...rows].sort((a, b) => weight(a) - weight(b) || b.id - a.id);
}
