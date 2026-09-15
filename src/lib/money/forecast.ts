// The eight-week cash forecast, from commitments only.
//
// The one place in the section that projects; everything else is a sum. And
// it projects only what is COMMITTED: invoices by due date (a past-due one
// assumed to land in two weeks), the next agreement installment at due plus
// terms, bills on their day, payroll on its run day, received orders at
// receipt plus thirty, orders on their way at expected plus thirty, claims on
// the desk this week, sales tax on its due date. No quotes, no unbilled work,
// no hopes. Pure: the loader hands in rows.

import { plusDays, daysFrom } from "@/lib/finance";
import { FORECAST_WEEKS, PAST_DUE_ASSUMED_DAYS, PO_TERMS_DAYS } from "@/lib/money/constants";

export type Commitment = {
  /** The day the money is expected to move. */
  on: string;
  cents: number;
  /** In or out. */
  direction: "in" | "out";
  label: string;
};

export type ForecastInput = {
  today: string;
  cashCents: number;
  invoices: { number: string; balanceCents: number; dueOn: string }[];
  installments: { label: string; cents: number; dueOn: string; termsDays: number }[];
  bills: { payee: string; cents: number; on: string }[];
  payroll: { ym: string; grossCents: number; runOn: string }[];
  posReceived: { number: string; vendor: string; cents: number; receivedOn: string }[];
  posOnOrder: { number: string; vendor: string; cents: number; expectedOn: string }[];
  reports: { person: string; cents: number }[];
  tax: { cents: number; dueOn: string } | null;
};

export type ForecastWeek = {
  from: string;
  to: string;
  ins: Commitment[];
  outs: Commitment[];
  inCents: number;
  outCents: number;
  endingCents: number;
};

export type Forecast = { weeks: ForecastWeek[]; lowCents: number; lowWeek: number };

/** Every commitment, dated, before it is bucketed. */
export function commitments(i: ForecastInput): Commitment[] {
  const out: Commitment[] = [];
  const t = i.today;
  for (const inv of i.invoices) {
    if (inv.balanceCents <= 0) continue;
    const past = !inv.dueOn || inv.dueOn < t;
    out.push({ on: past ? plusDays(t, PAST_DUE_ASSUMED_DAYS) : inv.dueOn, cents: inv.balanceCents, direction: "in",
      label: `${inv.number}${past ? " (past due, assumed 2 wks)" : ""}` });
  }
  for (const a of i.installments) {
    if (a.cents <= 0 || !a.dueOn) continue;
    out.push({ on: plusDays(a.dueOn, a.termsDays), cents: a.cents, direction: "in", label: `${a.label} installment` });
  }
  for (const b of i.bills) if (b.cents > 0 && b.on >= t) out.push({ on: b.on, cents: b.cents, direction: "out", label: b.payee });
  for (const p of i.payroll) if (p.grossCents > 0 && p.runOn >= t) out.push({ on: p.runOn, cents: p.grossCents, direction: "out", label: `Payroll ${p.ym}` });
  for (const p of i.posReceived) if (p.cents > 0) out.push({ on: later(plusDays(p.receivedOn, PO_TERMS_DAYS), t), cents: p.cents, direction: "out", label: `${p.number} ${p.vendor}` });
  for (const p of i.posOnOrder) if (p.cents > 0 && p.expectedOn) out.push({ on: later(plusDays(p.expectedOn, PO_TERMS_DAYS), t), cents: p.cents, direction: "out", label: `${p.number} ${p.vendor}` });
  for (const r of i.reports) if (r.cents > 0) out.push({ on: t, cents: r.cents, direction: "out", label: `${r.person}'s claim` });
  if (i.tax && i.tax.cents > 0 && i.tax.dueOn) out.push({ on: later(i.tax.dueOn, t), cents: i.tax.cents, direction: "out", label: "Sales tax" });
  return out.sort((a, b) => a.on.localeCompare(b.on));
}

const later = (a: string, b: string) => (a < b ? b : a);

export function forecast(i: ForecastInput, weeks = FORECAST_WEEKS): Forecast {
  const all = commitments(i);
  const out: ForecastWeek[] = [];
  let bal = i.cashCents;
  for (let w = 0; w < weeks; w++) {
    const from = plusDays(i.today, w * 7), to = plusDays(i.today, w * 7 + 6);
    const here = all.filter((c) => c.on >= from && c.on <= to);
    const ins = here.filter((c) => c.direction === "in"), outs = here.filter((c) => c.direction === "out");
    const inCents = ins.reduce((n, c) => n + c.cents, 0), outCents = outs.reduce((n, c) => n + c.cents, 0);
    bal += inCents - outCents;
    out.push({ from, to, ins, outs, inCents, outCents, endingCents: bal });
  }
  let lowWeek = 0;
  for (let w = 1; w < out.length; w++) if (out[w].endingCents < out[lowWeek].endingCents) lowWeek = w;
  return { weeks: out, lowCents: out[lowWeek]?.endingCents ?? i.cashCents, lowWeek };
}

/** Beyond the horizon and unlikely to matter; kept so a caller can say so. */
export const beyondHorizon = (c: Commitment, today: string, weeks = FORECAST_WEEKS): boolean =>
  daysFrom(today, c.on) >= weeks * 7;
