// Perks: the compensation that is not wages.
//
// A phone stipend, a vehicle allowance, a bonus. The arithmetic is small and
// the reason it is here rather than inline is the same as payroll's: three
// surfaces show what a person costs (the person file, the roster line, the
// monthly total on /people), and they have to agree to the cent.
//
// Pure. Callers hand in the rows.

export const PERK_CADENCES = ["monthly", "annual", "one_off"] as const;
export type PerkCadence = (typeof PERK_CADENCES)[number];

export const CADENCE_LABEL: Record<PerkCadence, string> = {
  monthly: "a month",
  annual: "a year",
  one_off: "one-off",
};

export type PerkRow = {
  id: number;
  personEmail: string;
  name: string;
  title: string;
  amountCents: number;
  cadence: string;
  startsOn: string;
  endsOn: string;
  note: string;
};

const isoDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Is this perk in force on `day`?
 *
 * A one-off is in force only in the month it was granted - it is a payment,
 * not a rate, and a bonus from March must not read as "running" in August.
 */
export function perkActiveOn(p: PerkRow, day: string): boolean {
  // A one-off belongs to its month whole - asking on the 1st and the 31st
  // must give one answer, or the month's list changes shape mid-month.
  if (p.cadence === "one_off") return p.startsOn.slice(0, 7) === day.slice(0, 7);
  if (p.startsOn && p.startsOn > day) return false;
  if (p.endsOn && p.endsOn < day) return false;
  return true;
}

/**
 * What a perk adds to a month.
 *
 * A one-off adds nothing to the RUN RATE - it is real money, but calling a
 * March bonus part of "per month" would overstate every month after it. It is
 * shown on the person and counted in the month it landed, nowhere else.
 */
export function perkMonthlyCents(p: PerkRow): number {
  if (p.cadence === "annual") return Math.round(Math.max(0, p.amountCents) / 12);
  if (p.cadence === "monthly") return Math.max(0, p.amountCents);
  return 0;
}

/** The run rate of everything in force on `day`. */
export function perksMonthlyTotal(rows: PerkRow[], day: string): number {
  return rows.filter((p) => perkActiveOn(p, day)).reduce((n, p) => n + perkMonthlyCents(p), 0);
}

/** "Phone stipend · $85 a month" - the row as the person file prints it. */
export function perkLine(p: PerkRow, money: (c: number) => string): string {
  const cadence = CADENCE_LABEL[(p.cadence as PerkCadence)] ?? p.cadence;
  return `${p.title || "Perk"} · ${money(p.amountCents)}${p.cadence === "one_off" ? ` ${cadence}` : ` ${cadence}`}`;
}

/** Everything wrong with a perk somebody is granting. Empty = it can be saved. */
export function perkProblems(p: {
  title: string; amountCents: number; cadence: string; startsOn: string; endsOn: string;
}): string[] {
  const out: string[] = [];
  if (!p.title.trim()) out.push("Say what the perk is");
  if (!Number.isFinite(p.amountCents) || p.amountCents <= 0) out.push("Say what it is worth");
  if (!(PERK_CADENCES as readonly string[]).includes(p.cadence)) out.push("Pick how often");
  if (!isoDay(p.startsOn)) out.push("Pick the day it starts");
  if (p.endsOn && (!isoDay(p.endsOn) || p.endsOn < p.startsOn)) out.push("The end is before the start");
  return out;
}
