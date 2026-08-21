// How a maintenance list reads.
//
// Looking at one asks two questions: is anything owed now, and when is the next
// thing. A flat list of every schedule answers neither at a glance - forty rows
// of "next 3/15" bury the one row that says overdue, and a system whose upkeep is
// all done still shows a screenful of work.
//
// So the list splits: anything owed now stays in full, everything else folds into
// the month it falls in, and the month and year of the soonest one is the
// headline. When every cycle has been completed there is nothing owed, and the
// whole list is one line - "next due September 2026".
//
// A period here is a calendar month. It's the unit a shop plans PM in, and it's
// what makes the fold worth having: a quarterly and a yearly job landing in the
// same September are one line, not two.

export type PmLike = {
  id: number;
  nextDue: string;   // YYYY-MM-DD in shop time
  paused: boolean;
  /** An open generated task is the schedule in flight - owed now, whatever its date. */
  openTaskId?: number | null;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09-01" -> "2026-09". The period a schedule falls in. */
export const pmMonthKey = (iso: string) => iso.slice(0, 7);

/** "2026-09-01" -> "September 2026". Built from the string, never from a Date. */
export function pmMonthLabel(iso: string): string {
  const [y, m] = iso.split("-");
  return `${MONTHS[parseInt(m) - 1] ?? m} ${y}`;
}

/**
 * Is this schedule owed now? Due-or-overdue counts, and so does an open task:
 * work that has started is outstanding even when its date is next week.
 */
export function pmActive(s: PmLike, today: string): boolean {
  if (s.paused) return false;
  return (s.openTaskId ?? null) !== null || s.nextDue <= today;
}

export type PmGrouped<T> = {
  /** Owed now. Never folded away. */
  active: T[];
  /** Everything else, by the month it falls in, soonest month first. */
  months: { key: string; label: string; rows: T[] }[];
  /** Not going to happen on its own; folded away with the rest. */
  paused: T[];
  /** The month and year of the soonest thing still to come, if there is one. */
  next: { key: string; label: string } | null;
  /** Nothing is owed - every cycle in flight has been completed. */
  allClear: boolean;
};

export function pmGroups<T extends PmLike>(rows: T[], today: string): PmGrouped<T> {
  const order = (a: T, b: T) => a.nextDue.localeCompare(b.nextDue) || a.id - b.id;
  const active: T[] = [], later: T[] = [], paused: T[] = [];
  for (const r of rows) (r.paused ? paused : pmActive(r, today) ? active : later).push(r);
  active.sort(order); later.sort(order); paused.sort(order);

  const months: PmGrouped<T>["months"] = [];
  for (const r of later) {
    const key = pmMonthKey(r.nextDue);
    const last = months[months.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else months.push({ key, label: pmMonthLabel(r.nextDue), rows: [r] });
  }

  return {
    active, months, paused,
    next: months.length ? { key: months[0].key, label: months[0].label } : null,
    allClear: active.length === 0,
  };
}

// ---------------------------------------------------------------------------
// The asset dimension.
//
// A stacked system carries upkeep on every module - the pump has its seals,
// the autosampler its needle, the MS its ion source - and when a visit brings
// them all due at once, forty ACTIVE rows are as unreadable as forty future
// ones. The month fold cannot help there; the asset can. Rows group under the
// unit they belong to, the system's own work first, and each group folds to a
// header that keeps the two answers visible: how much is owed here, and when
// the next thing is. Collapsing hides rows, never the signal.
// ---------------------------------------------------------------------------

export type PmAssetLike = PmLike & {
  /** Which unit the schedule lives on. Null/absent = the system itself. */
  assetId?: number | null;
  /** What to call that unit. */
  onAsset?: string;
};

export type PmAssetGroup<T> = {
  /** "sys", or "a<id>". Stable, so a collapse survives a re-render. */
  key: string;
  /** "System" for the system's own work; the unit's label otherwise. */
  label: string;
  rows: T[];
  /** Owed now (pmActive) - what the folded header must still say. */
  due: number;
  /** Soonest unpaused due date in the group, for the header when nothing is owed. */
  nextDue: string | null;
};

/**
 * Rows by the unit they belong to: the system's own schedules first, then each
 * asset in the order it first appears. One group (or none) means the asset
 * dimension has nothing to add - callers keep the flat list.
 */
export function pmAssetGroups<T extends PmAssetLike>(rows: T[], today: string): PmAssetGroup<T>[] {
  const groups: PmAssetGroup<T>[] = [];
  const byKey = new Map<string, PmAssetGroup<T>>();
  for (const r of rows) {
    const key = r.assetId != null ? `a${r.assetId}` : "sys";
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: r.assetId != null ? (r.onAsset || "Unnamed unit") : "System", rows: [], due: 0, nextDue: null };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(r);
    if (pmActive(r, today)) g.due++;
    if (!r.paused && (g.nextDue === null || r.nextDue < g.nextDue)) g.nextDue = r.nextDue;
  }
  // The system's own work reads first, wherever its rows sat in the input.
  groups.sort((a, b) => (a.key === "sys" ? -1 : b.key === "sys" ? 1 : 0));
  return groups;
}
