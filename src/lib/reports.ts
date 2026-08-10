// Report math for /metrics: plain rows in, numbers out. No DB imports, same
// discipline as stageAges - the queries live in the page, the arithmetic lives
// here where it can be pinned down by tests, because a wrong report quietly
// misinforms every decision made off it.

export type PmTaskRow = {
  origin: string;
  dueDate: string;            // YYYY-MM-DD, "" = none
  completedAt: Date | null;   // nulled on reopen - a reopened task counts as open again
  state: string;
};

export type PmComplianceOut = { onTime: number; late: number; openOverdue: number; openNotDue: number };

/**
 * PM work with a due date in the window, bucketed. "On time" means completed
 * on or before the due day, in shop-day terms. A task reopened after being
 * done counts as open - honest, since the work is not done.
 */
export function pmCompliance(
  rows: PmTaskRow[],
  windowStartIso: string,
  todayIso: string,
  dayOf: (d: Date) => string,
): PmComplianceOut {
  const out: PmComplianceOut = { onTime: 0, late: 0, openOverdue: 0, openNotDue: 0 };
  for (const t of rows) {
    if (t.origin !== "pm" || !t.dueDate) continue;
    if (t.dueDate < windowStartIso || t.dueDate > todayIso) continue;
    if (t.state === "Done" && t.completedAt) {
      if (dayOf(t.completedAt) <= t.dueDate) out.onTime++;
      else out.late++;
    } else {
      if (t.dueDate < todayIso) out.openOverdue++;
      else out.openNotDue++;
    }
  }
  return out;
}

export type ShipEvent = { instrumentId: number; stage: string; kind: string; at: Date };

/**
 * Days from a system's creation to its FIRST "Shipped", for systems shipped
 * inside the window. Creation → shipped is the whole-engagement turnaround;
 * per-stage detail stays with completedDurations.
 */
export function shippedTurnaround(
  insts: { id: number; createdAt: Date }[],
  events: ShipEvent[],
  windowStart: Date,
): number[] {
  const firstShip = new Map<number, Date>();
  for (const e of events) {
    if (e.stage !== "Shipped" || e.kind !== "add") continue;
    const seen = firstShip.get(e.instrumentId);
    if (!seen || e.at < seen) firstShip.set(e.instrumentId, e.at);
  }
  const out: number[] = [];
  for (const i of insts) {
    const shipped = firstShip.get(i.id);
    if (!shipped || shipped < windowStart) continue;
    out.push(Math.max(0, Math.round((shipped.getTime() - i.createdAt.getTime()) / 86400000)));
  }
  return out;
}

/** Sum minutes per key (system label, client, person...) inside the window. */
export function minutesBy<K>(
  entries: { minutes: number; date: string; key: K }[],
  windowStartIso: string,
): Map<K, number> {
  const out = new Map<K, number>();
  for (const e of entries) {
    if (e.date < windowStartIso || e.minutes <= 0) continue;
    out.set(e.key, (out.get(e.key) ?? 0) + e.minutes);
  }
  return out;
}

/**
 * Sum cents per key for parts recorded in the window. Windowed by record
 * creation - order dates are free text and unparseable - and only rows whose
 * cost parsed cleanly count, so this is "spend recorded", a floor not a total.
 */
export function spendBy<K>(
  parts: { costCents: number | null; createdAt: Date; key: K }[],
  windowStart: Date,
): Map<K, { cents: number; counted: number; unpriced: number }> {
  const out = new Map<K, { cents: number; counted: number; unpriced: number }>();
  for (const p of parts) {
    if (p.createdAt < windowStart) continue;
    const cur = out.get(p.key) ?? { cents: 0, counted: 0, unpriced: 0 };
    if (p.costCents === null) cur.unpriced++;
    else { cur.cents += p.costCents; cur.counted++; }
    out.set(p.key, cur);
  }
  return out;
}
