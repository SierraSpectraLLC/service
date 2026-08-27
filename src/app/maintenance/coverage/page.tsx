import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/authz";
import { readTenant, visibleOrgs } from "@/lib/tenancy";
import { shopToday } from "@/lib/shopday";
import { coverageBoard } from "@/lib/pmPlanData";
import {
  COVERAGE_LABEL, COVERAGE_TONE, coverageLine, coverageRollup, perYearLabel,
} from "@/lib/pmPlan";
import {
  DataTable, EmptyState, FacetStrip, Id, PageHead, Panel, Pill, Toolbar,
} from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Is the year's maintenance promise being kept?
 *
 * The calendar next door answers a different question - what is due next -
 * and answers it per schedule. This one is per CLIENT and per year: they were
 * promised two PMs on every mass spec, it is August, and three of their systems
 * have had none. A schedule can be perfectly on cadence while that is true, and
 * a client with no schedules at all can still be owed a visit, so neither page
 * can be derived from the other.
 *
 * Staff, not clients. A client sees their own plan and their own coverage on
 * their organization page; this is every client at once, which is the shop's
 * view of its own obligations.
 */
export default async function CoveragePage({ searchParams }: {
  searchParams: Promise<{ show?: string }>;
}) {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const { show = "" } = await searchParams;
  const today = shopToday();
  const year = Number(today.slice(0, 4));
  const tenant = readTenant(user);

  // visibleOrgs is the tenant wall: this workspace's organizations, and on a
  // platform-staff session the instance. Clients only - a plan is what a
  // service company promises somebody, and another operator is not somebody it
  // promises anything to.
  const orgs = (await visibleOrgs(user))
    .filter((o) => o.kind === "client" && !o.isOperator)
    .map((o) => ({ id: o.id, name: o.name }));
  const board = await coverageBoard({ tenantOrgId: tenant, today, orgs });

  const all = board.flatMap((c) => c.rows.map((r) => r.coverage));
  const total = coverageRollup(all);

  const view = show === "unplanned" ? "unplanned" : show === "all" ? "all" : "behind";
  const shown = board
    .map((c) => ({
      ...c,
      rows: c.rows.filter((r) =>
        view === "all" ? true
          : view === "unplanned" ? r.coverage.state === "unplanned"
            : r.coverage.state === "behind"),
    }))
    .filter((c) => c.rows.length > 0);

  const unplanned = all.filter((c) => c.state === "unplanned").length;

  return (
    <div className="container wide">
      <PageHead
        crumb={<><Link href="/maintenance">Maintenance</Link> › <b>Coverage</b></>}
        title={`Coverage in ${year}`}
        sub={
          <>
            What each client was promised in preventive maintenance, and what has
            actually landed. A visit counts once per day it was worked - three
            schedules closed on one trip is one visit. The plan itself is set on
            each client&apos;s <b>Maintenance</b> tab.
          </>
        }
      />

      <Panel title="The year so far" hint="Across every client with a plan.">
        <div className="lanes">
          <div className="ledger">
            <div className="mut t-small">Systems behind</div>
            <div className="t-figure">{total.behind}</div>
            <div className="mut t-small">of {total.planned} on a plan</div>
          </div>
          <div className="ledger">
            <div className="mut t-small">Visits still owed</div>
            <div className="t-figure">{total.owed}</div>
            <div className="mut t-small">before {year} is out</div>
          </div>
          <div className="ledger">
            <div className="mut t-small">Delivered</div>
            <div className="t-figure">{total.delivered}</div>
            <div className="mut t-small">{total.complete} systems done for the year</div>
          </div>
          {unplanned > 0 && (
            <div className="ledger">
              <div className="mut t-small">No plan</div>
              <div className="t-figure">{unplanned}</div>
              <div className="mut t-small">nobody has said what they are owed</div>
            </div>
          )}
        </div>
      </Panel>

      <Toolbar
        facets={
          <FacetStrip facets={[
            { key: "behind", label: "Behind", count: total.behind || undefined, on: view === "behind", href: "/maintenance/coverage" },
            { key: "unplanned", label: "No plan", count: unplanned || undefined, on: view === "unplanned", href: "/maintenance/coverage?show=unplanned" },
            { key: "all", label: "All systems", count: total.systems || undefined, on: view === "all", href: "/maintenance/coverage?show=all" },
          ]} />
        }
      />

      {shown.length === 0 && (
        <EmptyState
          title={
            view === "behind" ? "Nobody is behind"
              : view === "unplanned" ? "Every system has a plan"
                : "No client systems yet"
          }
          body={
            view === "behind"
              ? `Every system on a plan has had as many visits as ${year} has asked for so far.`
              : view === "unplanned"
                ? "Every system a client owns is covered by a plan row."
                : "A maintenance plan is set on a client's organization page, under Maintenance."
          }
        />
      )}

      {shown.map((c) => (
        <Panel
          key={c.orgId}
          title={c.orgName}
          count={c.rows.length}
          hint={c.plans.length
            ? c.plans
                .map((p) => `${p.category || "everything else"}: ${perYearLabel(p.perYear)}`)
                .join(" · ")
            : "No plan set - nobody has said what these systems are owed."}
          actions={
            <Link className="btn sm" href={`/settings/organizations/${c.orgId}?tab=pm`}>
              {c.plans.length ? "Their plan" : "Set a plan"}
            </Link>
          }
        >
          <DataTable
            cols={[
              { key: "system", label: "System", width: "minmax(160px, 1.5fr)" },
              { key: "class", label: "Class", width: "110px" },
              { key: "standing", label: "Standing", width: "130px" },
              { key: "detail", label: "This year", width: "minmax(180px, 1.6fr)" },
            ]}
            rows={c.rows.map((r) => ({
              key: r.instrumentId,
              href: `/instruments/${r.instrumentId}`,
              cells: {
                system: (
                  <span style={{ minWidth: 0, display: "block" }}>
                    <Id>{r.externalId}</Id>
                    {r.label && (
                      <span className="mut t-meta" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.label}
                      </span>
                    )}
                  </span>
                ),
                class: r.category
                  ? <span className="t-small">{r.category}</span>
                  : <span className="mut t-small">unclassed</span>,
                standing: (
                  <Pill tone={COVERAGE_TONE[r.coverage.state]}>
                    {COVERAGE_LABEL[r.coverage.state]}
                  </Pill>
                ),
                detail: <span className="mut t-small">{coverageLine(r.coverage)}</span>,
              },
            }))}
          />
        </Panel>
      ))}
    </div>
  );
}
