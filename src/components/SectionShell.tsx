import Link from "next/link";
import SectionRail, { type RailGroup } from "@/components/SectionRail";
import { PageHead } from "@/components/ui";
import type { NavSection } from "@/lib/nav";

/**
 * The one shape every page inside a section takes.
 *
 * Generalized from FinanceShell, which proved it on ten money pages: the
 * section's rail down the left, the page's own work in the pane, one head at
 * the top. Financial, Operations, Library, Settings and a person's own account
 * were four secondary-navigation patterns; they are this one now, fed by the
 * same tree the header and the drawer read, so a room added to lib/nav appears
 * in the rail the same day it appears in the menu.
 *
 * The rail is optional and that is not a convenience. /money/purchasing and
 * /money/payroll are reachable by people who are not in the section at all - a
 * client contact sees their own orders, and one with the payroll flag reads
 * their own register. Handing them a rail into Collections and Job costing
 * would be handing them nine links that redirect to the front page. They get
 * the page, not the section.
 */
export default function SectionShell({
  section, active, groups, rail, title, sub, crumb, actions, banner, children,
}: {
  /** Null for a reader who is not in the section. See above - this matters. */
  section: NavSection | null;
  /** The current room's href, for the rail's filled state and the crumb. */
  active?: string;
  /**
   * A grouped rail, where the section has an order worth naming (finance:
   * Position / Money in / Money out / Analysis). Omitted, the section's own
   * items are the rail, hub first.
   */
  groups?: RailGroup[];
  /** A rail that carries more than links - the money rail's figures. */
  rail?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  /** Overrides the "[Section] › [Room]" crumb this builds by default. */
  crumb?: React.ReactNode;
  actions?: React.ReactNode;
  /** Full width under the head, above the rail - a position line lives here. */
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (section === null) {
    return (
      <div className="container wide">
        <PageHead title={title} sub={sub} crumb={crumb} actions={actions} />
        {banner}
        {children}
      </div>
    );
  }
  /* "Financial › Invoices", from the tree rather than from a string each page
     writes for itself. The hub carries no crumb: it IS the section, and
     "Financial › Financial home" is a trail to where you already are. */
  const room = section.items.find((i) => i.href === active);
  const trail = crumb ?? (room
    ? <><Link href={section.href}>{section.label}</Link> › <b>{room.label}</b></>
    : undefined);

  return (
    <div className="container wide">
      <PageHead crumb={trail} title={title} sub={sub} actions={actions} />
      {banner}
      <div className="rail-body">
        {rail ?? (
          <SectionRail label={`${section.label} sections`} groups={groups ?? [{
            entries: [
              // The hub leads, exactly as it leads the drawer's fold and the
              // header's menu. One order, three surfaces.
              { href: section.href, label: section.homeLabel, active: active === section.href },
              ...section.items.map((i) => ({ ...i, active: i.href === active })),
            ],
          }]} />
        )}
        <main className="rail-main">{children}</main>
      </div>
    </div>
  );
}
