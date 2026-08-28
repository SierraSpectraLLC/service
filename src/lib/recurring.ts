/**
 * Recurring billing, as arithmetic on dates.
 *
 * A retainer is the one kind of money in this app with no job behind it: a
 * client on $20,000/month is not billed because somebody drove out and logged
 * hours, they are billed because the month happened. There is nothing to draft
 * FROM, so the agreement has to say it on its own.
 *
 * Everything here is pure and every date is a YYYY-MM-DD string, because the
 * whole point of the module is to be checkable against a calendar somebody
 * disagrees with. `Date` only appears inside the day arithmetic, anchored at
 * UTC noon so a timezone can never shift a cycle onto the day before.
 */

export type RecurringTerms = {
  billEveryMonths: number;
  billAmountCents: number;
  billDescription: string;
  billDayOfMonth: number;
  billLeadDays: number;
  billNextOn: string;
  billLastOn: string;
  /** The contract's own window - a cycle outside it is not billed. */
  startsOn: string;
  endsOn: string;
  status: string;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: string): boolean => ISO.test(s.trim());

/** Days in a month, 1-indexed month, so February knows about leap years. */
export const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The cycle date in a given month.
 *
 * A contract billed on the 31st has no 31st in February. It clamps to the
 * last day rather than skipping the month or rolling into March: a month that
 * happened is a month that gets billed, and a retainer that silently missed
 * every February would be found by the client, not by us.
 */
export function cycleDay(year: number, month: number, dayOfMonth: number): string {
  const d = Math.min(Math.max(1, Math.round(dayOfMonth)), daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Move a cycle date forward n months, re-clamping the day each time. */
export function addMonths(iso: string, n: number, dayOfMonth: number): string {
  if (!isDay(iso)) return "";
  const [y, m] = iso.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + Math.round(n);
  return cycleDay(Math.floor(total / 12), (total % 12) + 1, dayOfMonth);
}

/** Shift a plain day by n days. Used only for the lead time. */
export function addDays(iso: string, n: number): string {
  if (!isDay(iso)) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(n));
  return d.toISOString().slice(0, 10);
}

/** Is this agreement actually set up to bill on its own? */
export const recurring = (a: Pick<RecurringTerms, "billEveryMonths" | "billAmountCents" | "status">): boolean =>
  a.billEveryMonths > 0 && a.billAmountCents > 0 && a.status === "active";

/**
 * The first cycle a contract bills.
 *
 * Its own start day is not the cycle day - a contract signed on the 9th and
 * billed on the 1st bills on the 1st - so this walks to the first cycle day
 * that is not before the start.
 */
export function firstCycle(startsOn: string, dayOfMonth: number): string {
  if (!isDay(startsOn)) return "";
  const [y, m] = startsOn.split("-").map(Number);
  const inMonth = cycleDay(y, m, dayOfMonth);
  return inMonth >= startsOn ? inMonth : addMonths(inMonth, 1, dayOfMonth);
}

/**
 * Where the cursor should start when somebody first turns recurring on.
 *
 * A contract that started long ago does not get eleven months raised the
 * moment somebody ticks the box - history is backfilled deliberately, not by a
 * checkbox - so the cursor opens at the next cycle that has not happened yet.
 *
 * "NEXT CYCLE" MEANS THE NEXT ONE ON THE CADENCE, walked forward from the
 * contract's own first cycle. It used to mean the next occurrence of the
 * day-of-month, which is the same thing on a monthly retainer and nonsense on
 * anything else: an annual contract running 2025-10-01 to 2026-09-30, switched
 * on in August, opened at 2026-09-01 - not an anniversary of anything, four
 * weeks before the term ended, and a full year's fee ready to raise against
 * the twenty-nine days that were left. The cadence was not even passed in.
 *
 * On the corrected walk that contract opens at 2026-10-01, which is past its
 * end date, so nothing is due and the card says so. That is the honest answer:
 * the annual fee for the term fell due last October, and a bill for a period
 * already served is a decision somebody makes on purpose, not one a checkbox
 * makes for them.
 */
export const openingCursor = (
  a: Pick<RecurringTerms, "startsOn" | "billDayOfMonth" | "billEveryMonths">,
  today: string,
): string => {
  const first = firstCycle(a.startsOn || today, a.billDayOfMonth);
  if (!first || first >= today) return first;
  const every = Math.max(1, Math.round(a.billEveryMonths));
  let cursor = first;
  // Bounded: sixty years of monthly cycles is far past any real contract, and
  // an unbounded walk on a corrupt start date is a hung request.
  for (let i = 0; i < 720 && cursor < today; i++) {
    const next = addMonths(cursor, every, a.billDayOfMonth);
    if (!next || next <= cursor) break;
    cursor = next;
  }
  // A walk that ran out without catching up has not found a cursor - it has a
  // date decades in the past. Blank is what "no schedule" looks like
  // everywhere else here, and dueCycles reads it as nothing to raise; a stale
  // date would read as a cycle that is due, which is the opposite.
  return cursor >= today ? cursor : "";
};

/**
 * Cycles the contract SHOULD have billed and never did.
 *
 * dueCycles looks forward from the cursor and deliberately refuses to
 * backfill: switching a schedule on must not raise eight drafts because
 * somebody ticked a box. That rule is right, and it leaves a hole - a contract
 * billed annually at its start, entered into the app eleven months later, has
 * a real invoice nobody can raise. Two of those was forty-eight thousand
 * dollars of service already delivered and never billed.
 *
 * So this is the other direction: from the contract's own first cycle up to
 * today, every cycle inside the term that has not been raised. It cannot
 * invent a date - each one is a cycle the contract's own terms produce - and
 * it is bounded by the cursor, so the two lists are disjoint by construction
 * and no cycle is ever offered twice.
 *
 * Raising one is a deliberate act, which is the whole reason it is separate
 * from the cron's list rather than folded into it.
 */
export function missedCycles(a: RecurringTerms, today: string, cap = 24): string[] {
  if (!recurring(a) || !isDay(today) || !isDay(a.startsOn)) return [];
  const out: string[] = [];
  let cursor = firstCycle(a.startsOn, a.billDayOfMonth);
  if (!cursor) return [];
  for (let i = 0; i < cap * 4 + 48 && out.length < cap; i++) {
    if (cursor > today) break;
    if (isDay(a.endsOn) && cursor > a.endsOn) break;
    // Anything from the cursor onward is dueCycles' business. Offering it here
    // too would be the same invoice on two buttons.
    if (isDay(a.billNextOn) && cursor >= a.billNextOn) break;
    // Already raised. billLastOn is the marker raiseRetainerCycle writes.
    if (!(isDay(a.billLastOn) && cursor <= a.billLastOn)) out.push(cursor);
    const next = addMonths(cursor, a.billEveryMonths, a.billDayOfMonth);
    if (!next || next <= cursor) break;
    cursor = next;
  }
  return out;
}

/**
 * Which cycles are ready to raise as of `today`, oldest first.
 *
 * Ready means the cycle is within its lead time - a 7-day lead on a cycle
 * dated the 1st raises the draft on the 25th of the month before. It returns a
 * LIST because a cron that did not run for a week has to catch up, and it is
 * capped because the alternative to a cap is a misconfigured contract raising
 * two hundred drafts at three in the morning.
 */
export function dueCycles(a: RecurringTerms, today: string, cap = 12): string[] {
  if (!recurring(a) || !isDay(today)) return [];
  const out: string[] = [];
  let cursor = isDay(a.billNextOn) ? a.billNextOn : "";
  if (!cursor) return [];
  // The output cap and the walk are two different budgets. Spending the cap on
  // cycles that are only being SKIPPED - a cursor stranded years before the
  // contract's own start, a run of months already recorded as billed - meant a
  // contract could walk its whole allowance without reaching a live cycle and
  // return nothing at all, which reads exactly like "nothing is due".
  const walk = cap * 4 + 48;
  for (let i = 0; i < walk && out.length < cap; i++) {
    const next = addMonths(cursor, a.billEveryMonths, a.billDayOfMonth);
    if (!next) break;
    // Nothing after the contract ends, and nothing past the lead time: both
    // are the end of the walk, not a skip.
    if (isDay(a.endsOn) && cursor > a.endsOn) break;
    if (addDays(cursor, -Math.max(0, a.billLeadDays)) > today) break;
    // Nothing before the contract starts, and nothing already recorded as
    // raised - the cursor is the guard against a double-bill, and this is the
    // second one for when the cursor itself is wrong.
    const tooEarly = isDay(a.startsOn) && cursor < a.startsOn;
    const alreadyRaised = Boolean(a.billLastOn) && cursor <= a.billLastOn;
    if (!tooEarly && !alreadyRaised) out.push(cursor);
    cursor = next;
  }
  return out;
}

/**
 * What is coming, whether or not it is ready to raise - the answer to "what
 * does next quarter look like".
 *
 * Unlike dueCycles this ignores the lead time and the cursor's history: it is
 * a forecast, not an instruction, and a forecast that hid the cycle you are
 * standing on would be no use for planning.
 */
export function anticipated(a: RecurringTerms, from: string, to: string, cap = 24):
  { on: string; amountCents: number }[] {
  if (!recurring(a) || !isDay(from) || !isDay(to)) return [];
  const out: { on: string; amountCents: number }[] = [];
  let cursor = isDay(a.billNextOn) ? a.billNextOn : firstCycle(a.startsOn || from, a.billDayOfMonth);
  for (let i = 0; i < cap && cursor && cursor <= to; i++) {
    if (isDay(a.endsOn) && cursor > a.endsOn) break;
    if (cursor >= from) out.push({ on: cursor, amountCents: a.billAmountCents });
    cursor = addMonths(cursor, a.billEveryMonths, a.billDayOfMonth);
  }
  return out;
}

/**
 * "monthly", "quarterly" - how a billing term reads in a row.
 *
 * Named for BILLING on purpose: lib/pm has a cadenceLabel of its own for
 * maintenance intervals ("every 90 days"), and the two are different
 * vocabularies that would read as the same word at a call site.
 */
export function billCadenceLabel(everyMonths: number): string {
  const n = Math.round(everyMonths);
  if (n <= 0) return "not recurring";
  if (n === 1) return "monthly";
  if (n === 3) return "quarterly";
  if (n === 6) return "twice a year";
  if (n === 12) return "annually";
  return `every ${n} months`;
}
