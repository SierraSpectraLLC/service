import Link from "next/link";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { houseMembers, orgSites, payroll, stipends } from "@/db/schema";
import { navSection } from "@/lib/navData";
import { seesPayrollFor } from "@/lib/hr";
import { payrollForMonth, type PayRow } from "@/lib/payroll";
import { monthlyEquivalentCents } from "@/lib/stipends";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { siteLabel } from "@/lib/sites";
import { requireOrgAdmin } from "@/lib/orgAdmin";
import SectionShell from "@/components/SectionShell";
import { HubCard, HubGrid, Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The organization hub: the company itself, for the people who run it.
 *
 * Reached from the account menu under the company's own name, and from the
 * Account hub on a phone. It answers the two questions an owner or the office
 * manager opens it with - where are we, and who works here - with the numbers
 * first and the rooms under them. The rooms come from the nav tree (lib/nav),
 * so this page and the menu cannot list different ones.
 */
const BLURB: Record<string, string> = {
  "/organization/sites": "The shop, the offices, everywhere an employee can be stationed",
  "/people": "Pay, title and privileges, home and staffed location, contract, stipends, phone and email",
  "/settings/admin": "Who may sign in, temporary passwords, the root owner",
};

export default async function OrganizationPage() {
  const { user, org } = await requireOrgAdmin();
  const section = await navSection("org");
  const today = shopToday();

  const [members, sites, seesPay] = await Promise.all([
    db.select({ email: houseMembers.email, role: houseMembers.role, canAdminPeople: houseMembers.canAdminPeople })
      .from(houseMembers).where(and(eq(houseMembers.orgId, org.id), ne(houseMembers.role, "none"))),
    db.select().from(orgSites).where(and(eq(orgSites.orgId, org.id), eq(orgSites.archived, false)))
      .orderBy(asc(orgSites.name), asc(orgSites.id)),
    seesPayrollFor(user),
  ]);
  /* Payroll only for a reader who may read the register - the same gate the
     roster page applies, so the figure here and the one there agree or are
     both absent. Stipends are reimbursements, not pay, and every reader of
     this section may see them: HR runs the payout. */
  const payRows = seesPay
    ? (await db.select().from(payroll).where(eq(payroll.orgId, org.id))) as PayRow[]
    : [];
  const month = payrollForMonth(payRows, today.slice(0, 7));
  const standing = await db.select().from(stipends)
    .where(and(eq(stipends.tenantOrgId, org.id), eq(stipends.active, true)));
  const stipendsMonth = standing.reduce((n, s) => n + monthlyEquivalentCents(s), 0);

  const owners = members.filter((m) => m.role === "owner").length;
  const hr = members.filter((m) => m.canAdminPeople).length;

  const signal = (href: string) =>
    href === "/organization/sites"
      ? sites.length === 0
        ? { text: "No sites yet", tone: "warn" as const }
        : { text: `${sites.length} site${sites.length === 1 ? "" : "s"}`, tone: "info" as const }
      : href === "/people"
        ? { text: `${members.length} on staff`, tone: "info" as const }
        : undefined;

  return (
    <SectionShell section={section} active={section?.href}
      title={org.name}
      sub="Where the company is, who works here, and what the office holds about each of them.">
      <Panel title="At a glance"
        actions={<Link className="btn sm" href="/people">Employees</Link>}>
        <div className="lanes">
          <div className="ledger">
            <div className="mut t-small">On staff</div>
            <div className="t-figure">{members.length}</div>
            <div className="mut t-small">
              {owners} owner{owners === 1 ? "" : "s"}{hr ? ` · ${hr} HR` : ""}
            </div>
          </div>
          <div className="ledger">
            <div className="mut t-small">Site locations</div>
            <div className="t-figure">{sites.length}</div>
            <div className="mut t-small">
              {sites.length ? sites.slice(0, 3).map(siteLabel).join(" · ") : "None on file"}
              {sites.length > 3 ? ` · +${sites.length - 3}` : ""}
            </div>
          </div>
          {seesPay && (
            <div className="ledger">
              <div className="mut t-small">Payroll, per month</div>
              <div className="t-figure">{formatCents(month.totalCents)}</div>
              <div className="mut t-small">
                {month.headcount ? `${Math.round(month.headcount * 10) / 10} FTE · ` : ""}
                <Link href="/money/payroll">the register</Link>
              </div>
            </div>
          )}
          <div className="ledger">
            <div className="mut t-small">Standing reimbursements, per month</div>
            <div className="t-figure">{formatCents(stipendsMonth)}</div>
            <div className="mut t-small">
              {standing.length
                ? `${standing.length} arrangement${standing.length === 1 ? "" : "s"} - internet, phone, tools`
                : "None set up"}
            </div>
          </div>
        </div>
      </Panel>

      <HubGrid>
        {(section?.items ?? []).map((i) => {
          const sig = signal(i.href);
          return (
            <HubCard key={i.href} href={i.href} title={i.label}
              sub={BLURB[i.href] ?? "The company's own name, logo and billing address"}
              signal={sig?.text} tone={sig?.tone} />
          );
        })}
      </HubGrid>
    </SectionShell>
  );
}
