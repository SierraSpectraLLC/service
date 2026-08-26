import { Fragment } from "react";
import Link from "next/link";
import { formatDollars } from "@/lib/money";
import {
  financeRail, PERIOD_LABEL, PERIODS, withPeriod,
  type FinanceAmounts, type FinanceKey, type Period,
} from "@/lib/finance";

/**
 * The financial section's navigation: money in, money out, and the analysis
 * where the two meet.
 *
 * This replaces MoneyTabs, which was seven underline tabs across the top of
 * seven pages - and could only ever have been seven, because Purchasing,
 * Reimbursements and Payroll lived in a different part of the nav entirely. A
 * vertical rail has room for all ten and, more usefully, room for a figure
 * beside each label. "Collections $9,800" tells you whether to click it;
 * "Collections 2" does not.
 *
 * Same idiom as the system page's rail, down to the class names: below 960px
 * it becomes one row that scrolls sideways and never wraps. A person who has
 * learned one of the two record shapes should get this one for free.
 */
export default function FinanceRail({ active, amounts = {}, seesBooks, seesPayroll, period = "month" }: {
  active: FinanceKey;
  /** Cents per section. A section with no figure shows no badge. */
  amounts?: FinanceAmounts;
  /**
   * Whether this reader may read a payroll at all. False removes the entry
   * outright - see lib/finance, where the rule lives, for why a greyed-out
   * entry with a figure beside it would be worse than nothing.
   */
  seesPayroll: boolean;
  /**
   * Whether this reader may read the shop's position at all. False leaves the
   * two working rooms - Purchasing and Reimbursements - and takes the rest of
   * the section with it, badges included. See lib/books.
   */
  seesBooks: boolean;
  period?: Period;
}) {
  const groups = financeRail({ seesBooks, seesPayroll, period });
  return (
    /* Heading, list, heading, list - a flat sequence rather than a wrapper per
       group, because that is the shape the phone layout needs: the rail itself
       becomes the sideways scroller and every list inside it lines up in one
       row. A wrapper per group would put four scrollers side by side. */
    <nav className="rail" aria-label="Financial sections">
      {groups.map((g) => (
        <Fragment key={g.label}>
          <div className="railhead">{g.label}</div>
          <ul>
            {g.entries.map((e) => {
              const cents = amounts[e.key];
              return (
                <li key={e.key}>
                  <Link href={e.href} aria-current={e.key === active ? "page" : undefined}>
                    <span className="lbl">{e.label}</span>
                    {cents !== undefined && cents !== 0 && (
                      <span className={`amt${e.tone ? ` ${e.tone}` : ""}`}>
                        {formatDollars(cents)}
                      </span>
                    )}
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
