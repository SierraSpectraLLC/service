import Link from "next/link";
import FinanceRail, { PeriodPicker } from "@/components/FinanceRail";
import { PageHead } from "@/components/ui";
import { FINANCE_LABEL, type FinanceAmounts, type FinanceKey, type Period } from "@/lib/finance";

/**
 * The one shape every page in the financial section takes.
 *
 * Ten pages that were five nav entries and four page grammars now open the
 * same way: the section's rail down the left, the window in the top right, the
 * page's own work in the pane. Somebody who learns Invoices gets Purchasing
 * for free, which is the only reason to have a kit.
 *
 * The rail is optional and that is not a convenience. `/purchasing` and
 * `/payroll` are reachable by people who are not staff - a client contact sees
 * their own orders, and one with the payroll flag reads their own register.
 * Handing them a rail into Collections and Job costing would be handing them
 * nine links that redirect to the front page. They get the page, not the
 * section.
 */
export default function FinanceShell({
  rail, period, path, title, sub, actions, banner, children,
}: {
  /** Null for a reader who is not in the section. See above - this matters. */
  rail: { active: FinanceKey; amounts?: FinanceAmounts; seesPayroll: boolean } | null;
  period: Period;
  /** This page's own path, so the period picker returns to it. */
  path: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  /** Full width under the head, above the rail - the position line lives here. */
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (rail === null) {
    return (
      <div className="container wide">
        <PageHead title={title} sub={sub} actions={actions} />
        {banner}
        {children}
      </div>
    );
  }
  const label = FINANCE_LABEL[rail.active];
  return (
    <div className="container wide">
      <PageHead
        crumb={rail.active === "overview" ? undefined
          : <><Link href="/money">Financial</Link> › <b>{label}</b></>}
        title={title}
        sub={sub}
        actions={<>
          {actions}
          <PeriodPicker period={period} path={path} />
        </>}
      />
      {banner}
      <div className="rail-body">
        <FinanceRail active={rail.active} amounts={rail.amounts}
          seesPayroll={rail.seesPayroll} period={period} />
        <main className="rail-main">{children}</main>
      </div>
    </div>
  );
}
