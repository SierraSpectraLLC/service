// What a client is owed in preventive maintenance, and whether they got it.
//
// The promise is a count per year, per class of system - "two PMs a year on
// every MS, one on every LC" - and this turns that into the two answers a
// service manager actually needs: by when is the next one owed, and are we
// behind. Pure, no database, because both answers are arguments somebody will
// have with a client in a review meeting and neither should depend on which
// page asked.
//
// THE UNIT OF DELIVERY IS A DAY, NOT A TASK. A system with three schedules on
// it - pump seals, detector lamp, annual service - generates three PM tasks,
// and an engineer who does all three on one visit has performed one PM, not
// three. Counting tasks would have every such client reading "complete" in
// March. This is also the definition the app already uses everywhere else: see
// service_visits, whose whole comment is that a visit IS a calendar day with
// finished work on it.
//
// Dates are YYYY-MM-DD in shop time throughout, and the arithmetic goes through
// UTC epoch days - same convention as lib/pm, for the same reason.

/** A plan row, as the rules need it. */
export type PlanRow = {
  id: number;
  orgId: number;
  /** instruments.category, or '' for the client's catch-all. */
  category: string;
  perYear: number;
  note: string;
};

/** Nobody runs more than one PM a day, and ten a year is already unusual. */
export const PLAN_MAX_PER_YEAR = 52;

/**
 * Which plan row governs a system.
 *
 * Most specific first: a row naming the system's own category, else the
 * client's catch-all, else nothing. Nothing means no plan - which is different
 * from a plan of zero, and the difference matters. "We do not PM those" is a
 * decision somebody made and can be shown; "nobody has said" is a gap.
 *
 * Category matching is case- and space-insensitive because the vocabulary is
 * typed by hand into two different forms - the system form and this one - and
 * "LC-MS" against "lc-ms " must not silently become an unplanned system.
 */
export function planFor(plans: PlanRow[], category: string): PlanRow | null {
  const want = category.trim().toLowerCase();
  const exact = want && plans.find((p) => p.category.trim().toLowerCase() === want);
  return exact || plans.find((p) => p.category.trim() === "") || null;
}

/** The last day of a month, leap years included. */
export const lastDayOfMonth = (year: number, month: number): string =>
  new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

const daysInYear = (year: number) =>
  (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;

/**
 * The day each of the year's PMs is owed by.
 *
 * The year is cut into `perYear` equal stretches and the Nth PM is owed by the
 * end of the Nth stretch. Two a year means one by June 30 and one by December
 * 31 - which is how a contract is read out loud, and it is why "behind" can be
 * said in August instead of only on New Year's Eve.
 *
 * Months when the count divides the year evenly, which is every cadence anybody
 * actually writes into a contract (1, 2, 3, 4, 6, 12). "By the end of June"
 * belongs on a page; "by July 2", which is what 365/2 gives, reads as a
 * rounding artefact and invites an argument about the wrong thing. Odd counts
 * fall back to day arithmetic, where an artefact is unavoidable and honest.
 */
export function slotEnds(year: number, perYear: number): string[] {
  const n = Math.floor(perYear);
  if (!Number.isFinite(n) || n < 1) return [];
  const capped = Math.min(PLAN_MAX_PER_YEAR, n);
  if (12 % capped === 0) {
    const step = 12 / capped;
    return Array.from({ length: capped }, (_, i) => lastDayOfMonth(year, (i + 1) * step));
  }
  const total = daysInYear(year);
  return Array.from({ length: capped }, (_, i) => {
    const day = Math.round(((i + 1) * total) / capped);
    return new Date(Date.UTC(year, 0, day)).toISOString().slice(0, 10);
  });
}

export type CoverageState =
  /** No plan row governs this system - nobody has said what it is owed. */
  | "unplanned"
  /** A plan that says zero. A decision, not a gap. */
  | "excluded"
  /** Every PM the year owes has been delivered. */
  | "complete"
  /** On pace: as many done as the year has asked for so far. */
  | "on_track"
  /** Fewer done than the year has asked for by today. */
  | "behind";

export type Coverage = {
  state: CoverageState;
  perYear: number;
  /** Distinct days PM work was completed on this system, inside the year. */
  done: number;
  /** How many the year has asked for by today. */
  owedByNow: number;
  /** How many are past their day and not done. Zero unless behind. */
  overdue: number;
  /** The day the next one is owed by. "" once the year is satisfied. */
  nextOwedBy: string;
  /** The most recent PM day inside the year, or "" for none. */
  lastDoneOn: string;
};

/**
 * Where a system stands against its plan, for one year.
 *
 * `doneDays` is every day PM work was completed on it - duplicates and days
 * outside the year are the caller's to pass or not, and both are handled here
 * rather than trusted, because the two callers assemble them from different
 * queries and only one of them can filter in SQL.
 */
export function pmCoverage(input: {
  plan: PlanRow | null;
  doneDays: string[];
  today: string;
}): Coverage {
  const year = Number(input.today.slice(0, 4));
  const inYear = [...new Set(input.doneDays.filter((d) => d.slice(0, 4) === String(year)))].sort();
  const done = inYear.length;
  const lastDoneOn = inYear[inYear.length - 1] ?? "";

  if (input.plan === null) {
    return { state: "unplanned", perYear: 0, done, owedByNow: 0, overdue: 0, nextOwedBy: "", lastDoneOn };
  }
  const perYear = Math.max(0, Math.floor(input.plan.perYear));
  if (perYear === 0) {
    return { state: "excluded", perYear: 0, done, owedByNow: 0, overdue: 0, nextOwedBy: "", lastDoneOn };
  }

  const ends = slotEnds(year, perYear);
  const owedByNow = ends.filter((d) => d <= input.today).length;
  // The deadline for the NEXT one is the end of the stretch after the ones
  // already delivered - so a client who took their second PM in February is
  // not told a third is owed in June. Being ahead is not a debt.
  const nextOwedBy = done < ends.length ? ends[done] : "";
  const overdue = Math.max(0, owedByNow - done);

  return {
    state: done >= perYear ? "complete" : overdue > 0 ? "behind" : "on_track",
    perYear, done, owedByNow, overdue, nextOwedBy, lastDoneOn,
  };
}

export const COVERAGE_LABEL: Record<CoverageState, string> = {
  unplanned: "No plan",
  excluded: "Not covered",
  complete: "Done for the year",
  on_track: "On track",
  behind: "Behind",
};

export const COVERAGE_TONE: Record<CoverageState, "neutral" | "faint" | "good" | "warn" | "bad"> = {
  unplanned: "faint",
  excluded: "faint",
  complete: "good",
  on_track: "neutral",
  behind: "bad",
};

/** "2 a year", said the way somebody would say it. */
export const perYearLabel = (n: number): string =>
  n <= 0 ? "not covered"
    : n === 1 ? "once a year"
      : n === 2 ? "twice a year"
        : n === 4 ? "quarterly"
          : n === 12 ? "monthly"
            : `${n}× a year`;

/**
 * The sentence under a system's standing: what is owed, what has landed, and
 * by when. One line, because this is a table cell and the point of the whole
 * feature is that the answer fits on one.
 */
export function coverageLine(c: Coverage): string {
  if (c.state === "unplanned") return "Nobody has said what this system is owed.";
  if (c.state === "excluded") return "This class is not on a maintenance plan.";
  const got = `${c.done} of ${c.perYear} done this year`;
  if (c.state === "complete") {
    return `${got}${c.lastDoneOn ? `, last on ${c.lastDoneOn}` : ""}.`;
  }
  const by = c.nextOwedBy ? ` Next owed by ${c.nextOwedBy}.` : "";
  if (c.state === "behind") {
    return `${got} - ${c.overdue} past ${c.overdue === 1 ? "its day" : "their days"}.${by}`;
  }
  return `${got}.${by}`;
}

/**
 * The client-level roll-up: how many of their systems are behind, and how many
 * PMs the year still owes them in total.
 *
 * `owed` counts what is left to deliver across every planned system, which is
 * the number that plans a quarter - "UCSF has nine PMs left in the year" is a
 * staffing fact, and "three systems behind" is a phone call.
 */
export function coverageRollup(rows: Coverage[]): {
  systems: number; planned: number; behind: number; complete: number; owed: number; delivered: number;
} {
  const planned = rows.filter((c) => c.state !== "unplanned" && c.state !== "excluded");
  return {
    systems: rows.length,
    planned: planned.length,
    behind: rows.filter((c) => c.state === "behind").length,
    complete: rows.filter((c) => c.state === "complete").length,
    owed: planned.reduce((n, c) => n + Math.max(0, c.perYear - c.done), 0),
    delivered: planned.reduce((n, c) => n + c.done, 0),
  };
}
