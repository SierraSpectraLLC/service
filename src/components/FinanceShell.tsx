import Link from "next/link";
import FinanceRail, { PeriodPicker } from "@/components/FinanceRail";
import SectionShell from "@/components/SectionShell";
import { financeNavItems, FINANCE_LABEL, type FinanceAmounts, type FinanceKey, type Period } from "@/lib/finance";
import { LABEL, type NavSection } from "@/lib/nav";

/**
 * The financial section's shell - now a thin wrapper over SectionShell.
 *
 * The shape it proved (rail left, window top right, the page's own work in the
 * pane) became the shape of every section, so what is left here is the two
 * things that are only true of money: the rail carries a figure beside each
 * label, and every page in the section reads a reporting window.
 *
 * "Collections $9,800" tells you whether to click it; "Collections 2" does
 * not, which is why the money rail is passed in whole rather than built from
 * the nav tree's leaves like every other section's.
 */
export default function FinanceShell({
  rail, period, path, title, sub, actions, banner, children,
}: {
  /** Null for a reader who is not in the section - see SectionShell. */
  rail: { active: FinanceKey; amounts?: FinanceAmounts; seesBooks: boolean; seesPayroll: boolean } | null;
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
      <SectionShell section={null} title={title} sub={sub} actions={actions} banner={banner}>
        {children}
      </SectionShell>
    );
  }
  /* The money section, as the tree describes it - so the crumb here and the
     word in the header cannot drift. Its rooms come from lib/finance either
     way; this is the same call buildNav makes. */
  const section: NavSection = {
    key: "money", label: LABEL.money, href: "/money", homeLabel: "Financial home",
    items: financeNavItems({ seesBooks: rail.seesBooks, seesPayroll: rail.seesPayroll })
      .filter((i) => i.href !== "/money"),
  };
  const label = FINANCE_LABEL[rail.active];
  return (
    <SectionShell
      section={section}
      crumb={rail.active === "overview" ? undefined
        : <><Link href={section.href}>{section.label}</Link> › <b>{label}</b></>}
      title={title}
      sub={sub}
      actions={<>
        {actions}
        <PeriodPicker period={period} path={path} />
      </>}
      banner={banner}
      rail={<FinanceRail active={rail.active} amounts={rail.amounts}
        seesBooks={rail.seesBooks} seesPayroll={rail.seesPayroll} period={period} />}
    >
      {children}
    </SectionShell>
  );
}
