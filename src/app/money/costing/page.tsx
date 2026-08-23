import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { costingBoard } from "@/lib/invoiceData";
import { short, WINDOWS, WINDOW_LABEL, SLOW_PAY_DAYS } from "@/lib/costing";
import MoneyTabs from "@/components/MoneyTabs";
import { EmptyState, Id, PageHead, Panel, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Revenue against cost, and what it cost to be owed the money.
 *
 * The two columns sit beside each other on purpose. Margin says whether a job
 * was worth doing; days-to-pay says what being owed for it cost. A 41% client
 * who takes sixty-seven days is not a better client than a 38% one who pays in
 * eleven, and a shop that only reads the first column cannot see that.
 *
 * Every figure is summed from rows at render, like the rest of Billing. There
 * is no costing table.
 */
export default async function CostingPage({ searchParams }: {
  searchParams: Promise<{ w?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");

  const { w = "90" } = await searchParams;
  const windowDays = (WINDOWS as readonly number[]).includes(Number(w)) ? Number(w) : 90;
  const today = shopToday();
  const { jobs, clients, loadedLaborCents } = await costingBoard(today, windowDays);

  const label = WINDOW_LABEL[windowDays];

  return (
    <div className="container wide">
      <PageHead
        crumb={<><Link href="/money">Billing</Link> › <b>Costing</b></>}
        title="Job costing"
        sub="Revenue against cost. The cost inputs are the ones the app already records - what parts landed at, hours at a loaded rate, and expenses."
        actions={
          <div className="seg" role="group" aria-label="Reporting window">
            {WINDOWS.map((d) => (
              <Link key={d} href={`/money/costing?w=${d}`}
                aria-current={d === windowDays ? "true" : undefined}>
                {WINDOW_LABEL[d]}
              </Link>
            ))}
          </div>
        }
      />
      <MoneyTabs active="costing" />

      {loadedLaborCents <= 0 && (
        <div className="card" style={{ borderLeft: "3px solid var(--t-warn-fg)" }}>
          <div className="t-body">
            No loaded labor rate is set, so the labour half of every cost is missing and no margin can
            be honest about itself.
          </div>
          <div className="mut t-small" style={{ marginTop: 4 }}>
            Set it in <Link href="/settings/billing">Billing settings</Link> - wage plus burden, van
            and insurance, which is what an hour actually costs whether or not it was sold.
          </div>
        </div>
      )}

      <Panel
        title="By work order"
        count={jobs.length}
        hint={
          loadedLaborCents > 0
            ? `Closed in the last ${label}. Loaded labor at ${formatCents(loadedLaborCents)} an hour; covered visits roll up against their agreement instead of showing as a loss.`
            : `Closed in the last ${label}.`
        }
        empty={`Nothing closed in the last ${label}.`}
      >
        {jobs.length > 0 && jobs.map((j) => (
          <div key={j.woId} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
            <Link href={`/work/${j.woId}`} className="t-body" style={{ textDecoration: "none", fontWeight: 600, flex: "1 1 220px", minWidth: 0 }}>
              <Id>{j.number}</Id> {j.title}
              <span className="mut t-meta" style={{ display: "block", fontWeight: 400 }}>
                {j.orgName}{j.closedOn ? ` · closed ${j.closedOn}` : ""}
              </span>
            </Link>
            <span className="mut t-small" style={{ width: 92, textAlign: "right" }}>{formatCents(j.billedCents)}</span>
            <span className="mut t-small" style={{ width: 92, textAlign: "right" }}>{formatCents(j.costCents)}</span>
            <span style={{ width: 118, textAlign: "right" }}>
              {j.marginPct !== null
                ? <Pill tone={j.tone}>{j.marginPct}%</Pill>
                : <span className="mut t-small">{j.note}</span>}
            </span>
          </div>
        ))}
      </Panel>

      <Panel
        title="By client"
        count={clients.length}
        hint={`Trailing ${label}, with what it cost to be owed the money. Days-to-pay is weighted by amount - a client who pays five small invoices at once and one large one at ninety days is a ninety-day client.`}
        empty="Nothing to compare yet."
      >
        {clients.length > 0 && clients.map((c) => (
          <div key={c.orgId} style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
            <div className="row-2" style={{ alignItems: "baseline" }}>
              <span style={{ flex: "1 1 200px", minWidth: 0 }}>
                <span className="t-body" style={{ fontWeight: 600 }}>{c.orgName}</span>
                <span className="mut t-meta" style={{ display: "block" }}>
                  {`${c.terms} · ${c.jobs} job${c.jobs === 1 ? "" : "s"}`}
                  {c.openCents > 0 ? ` · ${formatCents(c.openCents)} still open` : ""}
                </span>
              </span>
              <span className="t-body" style={{ width: 92, textAlign: "right", fontWeight: 600 }}>
                {short(c.billedCents)}
              </span>
              <span style={{ width: 92, textAlign: "right" }}>
                {c.marginPct !== null
                  ? <Pill tone={c.marginPct < 20 ? "warn" : "good"}>{c.marginPct}%</Pill>
                  : <span className="mut t-small">covered</span>}
              </span>
              <span style={{ width: 118, textAlign: "right" }}>
                {c.daysToPay !== null
                  ? <Pill tone={c.daysToPay >= SLOW_PAY_DAYS ? "bad" : c.daysToPay > 20 ? "warn" : "good"}>
                      {c.daysToPay} d to pay
                    </Pill>
                  : <span className="mut t-small">nothing settled yet</span>}
              </span>
            </div>
            {c.note && <div className="mut t-small" style={{ marginTop: 4 }}>{c.note}</div>}
          </div>
        ))}
      </Panel>

      {jobs.length === 0 && clients.length === 0 && (
        <EmptyState
          title="Nothing to cost yet"
          body="Close a job and invoice it, and it appears here with what it actually cost to do."
        />
      )}
    </div>
  );
}
