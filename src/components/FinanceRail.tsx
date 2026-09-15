import { Fragment } from "react";
import Link from "next/link";
import { formatDollars } from "@/lib/money";
import {
  financeRail, PERIOD_LABEL, PERIODS, withPeriod,
  type FinanceAmounts, type FinanceKey, type FinanceLabels, type FinanceTones, type Period,
} from "@/lib/finance";

/**
 * The financial section's navigation: seven rooms over one journal, with a
 * figure beside the rooms that have one. "Receivables $9,800" tells you
 * whether to click it; "Receivables 2" does not. Clients carries a count
 * instead - "2 on hold" - because that is the fact about clients.
 *
 * Same idiom as the system page's rail, down to the class names: below 960px
 * it becomes one row that scrolls sideways and never wraps.
 */
export default function FinanceRail({ active, amounts = {}, labels = {}, tones = {}, seesBooks, seesPayroll, period = "month" }: {
  active?: FinanceKey;
  /** Cents per room. A room with no figure shows no badge. */
  amounts?: FinanceAmounts;
  /** Words instead of a figure - "2 on hold". */
  labels?: FinanceLabels;
  /** Colour the badge when the figure is the problem. */
  tones?: FinanceTones;
  seesPayroll: boolean;
  /** False takes the rail away entirely, badges included - see lib/finance. */
  seesBooks: boolean;
  period?: Period;
}) {
  const groups = financeRail({ seesBooks, seesPayroll, period });
  if (!groups.length) return null;
  return (
    <nav className="rail" aria-label="Financial sections">
      {groups.map((g) => (
        <Fragment key={g.label}>
          <div className="railhead">{g.label}</div>
          <ul>
            {g.entries.map((e) => {
              const cents = amounts[e.key];
              const label = labels[e.key];
              const tone = tones[e.key];
              return (
                <li key={e.key}>
                  <Link href={e.href} aria-current={e.key === active ? "page" : undefined}>
                    <span className="lbl">{e.label}</span>
                    {label ? (
                      <span className={`amt${tone ? ` ${tone}` : ""}`}>{label}</span>
                    ) : cents !== undefined && cents !== 0 ? (
                      <span className={`amt${tone ? ` ${tone}` : ""}`}>{formatDollars(cents)}</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Fragment>
      ))}
    </nav>
  );
}

/**
 * The window every page in the section reads.
 *
 * Links rather than buttons so the choice is in the URL: a period is part of
 * what you are looking at, and a figure somebody quotes from this page should
 * be reachable again by whoever they send the link to.
 */
export function PeriodPicker({ period, path }: {
  period: Period;
  /** The page this sits on, so each choice returns to it. */
  path: string;
}) {
  return (
    <div className="seg" role="group" aria-label="Reporting period">
      {PERIODS.map((p) => (
        <Link key={p} href={withPeriod(path, p)}
          aria-current={p === period ? "true" : undefined}>
          {PERIOD_LABEL[p]}
        </Link>
      ))}
    </div>
  );
}
