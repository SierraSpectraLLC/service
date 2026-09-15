import Link from "next/link";
import FinanceRail, { PeriodPicker } from "@/components/FinanceRail";
import SectionShell from "@/components/SectionShell";
import { financeNavItems, FINANCE_LABEL, type FinanceKey, type Period } from "@/lib/finance";
import type { RailContext } from "@/lib/financeData";
import { LABEL, type NavSection } from "@/lib/nav";

/**
 * The financial section's shell - a thin wrapper over SectionShell.
 *
 * What is only true of money: the rail carries a figure beside each label,
 * and every page in the section reads a reporting window. Pages that are in
 * the section but are not rooms - an invoice, a quote, a purchase order, a
 * claim, the register - pass no `active`, and get the rail (for a books
 * reader) with nothing filled and the crumb they name themselves.
 */
export default function FinanceShell({
  rail, active, period, path, title, sub, actions, banner, crumb, children,
}: {
  /** From railContext or booksContext. Null for a reader who is not in the section. */
  rail: RailContext | null;
  /** The room this page is, when it is one. */
  active?: FinanceKey;
  period: Period;
  /** This page's own path, so the period picker returns to it. */
  path: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  /** Full width under the head, above the rail. */
  banner?: React.ReactNode;
  /** For a page that is not a room: "Financial › INV-0092". */
  crumb?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (rail === null || !rail.seesBooks) {
    return (
      <SectionShell section={null} title={title} sub={sub} actions={actions} banner={banner} crumb={crumb}>
        {children}
      </SectionShell>
    );
  }
  /* The money section, as the tree describes it - so the crumb here and the
     word in the header cannot drift. */
  const section: NavSection = {
    key: "money", label: LABEL.money, href: "/money", homeLabel: "Financial home",
    items: financeNavItems({ seesBooks: rail.seesBooks, seesPayroll: rail.seesPayroll })
      .filter((i) => i.href !== "/money"),
  };
  const label = active ? FINANCE_LABEL[active] : null;
  return (
    <SectionShell
      section={section}
      crumb={crumb ?? (active === "overview" || !label ? undefined
        : <><Link href={section.href}>{section.label}</Link> › <b>{label}</b></>)}
      title={title}
      sub={sub}
      actions={<>
        {actions}
        <PeriodPicker period={period} path={path} />
      </>}
      banner={banner}
      rail={<FinanceRail active={active} amounts={rail.amounts} labels={rail.labels} tones={rail.tones}
        seesBooks={rail.seesBooks} seesPayroll={rail.seesPayroll} period={period} />}
    >
      {children}
    </SectionShell>
  );
}
