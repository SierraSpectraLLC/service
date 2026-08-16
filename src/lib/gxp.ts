// The compliance half of a regulated (GxP) system.
//
// Everything here hangs off one switch, instruments.gxp: off, none of it
// renders and a loaner UV-Vis never sees the word "IQ". On, three questions
// get answers the auditor's way:
//
//   - which qualification does this work belong to (IQ/OQ/PQ, a tag on the
//     procedures that already exist - not a parallel object to maintain)
//   - which documents are about to stop being current (a validity date on the
//     files that already exist)
//   - is this system qualified RIGHT NOW (derived, never stored - the same
//     rule as agreement balances: a stored status is a status that drifts)
//
// Pure. Pages hand in rows; this decides what they mean.

/** The order they run in, which is also the order the binder prints them. */
export const QUALIFICATIONS = ["IQ", "OQ", "PQ"] as const;

export const QUAL_LABEL: Record<string, string> = {
  IQ: "Installation Qualification",
  OQ: "Operational Qualification",
  PQ: "Performance Qualification",
};

// ---------------------------------------------------------------------------
// Expiring documents

export type Dated = { expiresOn: string };

/** Days from `today` (shop-day string) to the date; negative = already past. */
export function daysUntil(date: string, today: string): number {
  const d = new Date(`${date}T00:00:00Z`).getTime();
  const t = new Date(`${today}T00:00:00Z`).getTime();
  return Math.round((d - t) / 86_400_000);
}

/**
 * Split dated documents into expired and expiring-soon.
 *
 * 60 days of warning, because a replacement cert is usually somebody else's
 * calendar - a vendor visit, a calibration service - and 2 weeks of notice is
 * how a lapse happens anyway with extra steps. Undated documents never nag.
 */
export function expiryAttention<T extends Dated>(
  docs: T[], today: string, horizonDays = 60,
): { expired: T[]; soon: T[] } {
  const expired: T[] = [];
  const soon: T[] = [];
  for (const d of docs) {
    if (!d.expiresOn) continue;
    const days = daysUntil(d.expiresOn, today);
    if (days < 0) expired.push(d);
    else if (days <= horizonDays) soon.push(d);
  }
  return { expired, soon };
}

/** "expired 12d ago" / "expires in 30d" / "expires today" - the chip text. */
export function expiryLabel(date: string, today: string): string {
  const days = daysUntil(date, today);
  if (days < 0) return `expired ${-days}d ago`;
  if (days === 0) return "expires today";
  return `expires in ${days}d`;
}

// ---------------------------------------------------------------------------
// Qualification standing

export type StandingInput = {
  /**
   * Per qualification that applies to this system: whether every piece of its
   * generated work is Done. A qualification with no procedures declared simply
   * doesn't appear - absence of evidence is "not qualified" only for the quals
   * the catalog actually asks of this equipment.
   */
  quals: { qualification: string; open: number; done: number }[];
  /** Expired dated documents on the record. */
  expired: number;
  /** Dated documents inside the warning horizon. */
  expiringSoon: number;
  /**
   * Validation-package completeness, when the doc manager is in play. Null
   * means no package is declared for this equipment, which is not a failure -
   * a shop can run the qualification tags without the document manager.
   */
  packageComplete: boolean | null;
};

export type Standing = {
  label: "Qualified" | "Not qualified" | "Attention";
  tone: "ok" | "bad" | "warn";
  /** Why, one line each, in the order a reviewer would want them. */
  reasons: string[];
};

/**
 * A regulated system's standing, derived from the record.
 *
 * "Not qualified" is reserved for the hard gaps - qualification work never
 * completed, or a declared package with holes. Expiries and requal work in
 * flight are "Attention": the system WAS qualified and something is lapsing,
 * which is a different conversation than never having been qualified at all.
 */
export function qualStanding(s: StandingInput): Standing {
  const reasons: string[] = [];
  let notQualified = false;

  for (const q of s.quals) {
    if (q.done === 0 && q.open > 0) {
      notQualified = true;
      reasons.push(`${q.qualification} has never been completed (${q.open} open)`);
    } else if (q.open > 0) {
      reasons.push(`${q.qualification} rework open (${q.open} task${q.open === 1 ? "" : "s"})`);
    }
  }
  if (s.packageComplete === false) {
    notQualified = true;
    reasons.push("validation package incomplete");
  }
  if (s.expired > 0) reasons.push(`${s.expired} document${s.expired === 1 ? "" : "s"} expired`);
  if (s.expiringSoon > 0) reasons.push(`${s.expiringSoon} expiring soon`);

  if (notQualified) return { label: "Not qualified", tone: "bad", reasons };
  if (reasons.length) return { label: "Attention", tone: "warn", reasons };
  return { label: "Qualified", tone: "ok", reasons };
}

/** Group a system's qualification-tagged tasks into StandingInput.quals. */
export function qualsOf(tasks: { qualification: string; state: string }[]): StandingInput["quals"] {
  return QUALIFICATIONS.flatMap((q) => {
    const mine = tasks.filter((t) => t.qualification === q);
    if (!mine.length) return [];
    const done = mine.filter((t) => t.state === "Done").length;
    return [{ qualification: q, open: mine.length - done, done }];
  });
}

export const STANDING_COLOR: Record<Standing["tone"], { bg: string; fg: string }> = {
  ok: { bg: "#E5F3E5", fg: "#2E6B2E" },
  warn: { bg: "#FAF0DC", fg: "#8A5410" },
  bad: { bg: "#FBE9E9", fg: "#A32D2D" },
};
