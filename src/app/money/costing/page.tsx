import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { readTenant } from "@/lib/tenancy";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { costingBoard, pmCostingBoard } from "@/lib/invoiceData";
import { short, SLOW_PAY_DAYS } from "@/lib/costing";
import { periodDays, periodSpan } from "@/lib/finance";
import FinanceShell from "@/components/FinanceShell";
import { booksContext } from "@/lib/financeData";
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
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");

  // This page used to keep its own ?w= window of 30/90/365 days, which meant
  // the section had two answers to "over what period" and no way to carry one
  // across a click. It reads the section's window now - see lib/finance.
  const { period, seesPayroll, figures: fig } =
    await booksContext(user, (await searchParams).period);
  const today = shopToday();
  const days = periodDays(today, period);
  const [{ jobs, clients, loadedLaborCents }, pm] = await Promise.all([
    costingBoard(today, days, readTenant(user)),
    pmCostingBoard(today, days, readTenant(user)),
  ]);

  const label = periodSpan(today, period);

  return (
    <FinanceShell
      rail={{ active: "costing", amounts: fig.amounts, seesBooks: true, seesPayroll }}
      period={period}
      path="/money/costing"
      title="Job costing"
      sub="Where money in meets money out: every closed job, what it billed and what it cost."
    >

      {loadedLaborCents <= 0 && (
        <div className="card" style={{ borderLeft: "3px solid var(--t-warn-fg)" }}>
          <div className="t-body">
            No loaded labor rate set - margins exclude labor. Set it in{" "}
            <Link href="/settings/billing">Billing settings</Link>.
          </div>
        </div>
      )}

      <Panel
        title="By work order"
        count={jobs.length}
        hint={loadedLaborCents > 0
          ? `Closed in ${label} · loaded labor ${formatCents(loadedLaborCents)}/h`
          : `Closed in ${label}`}
        empty={`Nothing closed in ${label}.`}
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

      {/*
        Maintenance, which nothing on the money side has ever counted.

        A completed PM is a task, not a work order, so it reaches no invoice and
        has no margin to report - the value of a PM under contract belongs to
        the agreement, exactly as a covered job's does above. What it has is a
        cost, and until now that cost left the building unrecorded: the parts
        were stamped "part of maintenance" only so a contract that includes PM
        parts could keep them OFF the client's allowance.

        Parts only, said out loud rather than reported as if it were the whole
        figure. Hours and expenses link to a work order and to nothing else, and
        claiming a PM's labour by matching system and date would take hours off
        a job with a real claim to them.
      */}
      <Panel
        title="By maintenance"
        count={pm.rows.length}
        hint={
          <>
            {`Completed in ${label} · parts only`}
            {pm.totalCents > 0 ? ` · ${formatCents(pm.totalCents)}` : ""}
            {pm.quiet > 0
              ? ` · ${pm.quiet} more completed with no parts recorded`
              : ""}
          </>
        }
        empty={`No maintenance with recorded parts in ${label}.`}
      >
        {pm.rows.length > 0 && pm.rows.map((p) => {
          const under = [p.systemName, p.orgName].filter(Boolean).join(" · ");
          const sub = (
            <span className="mut t-meta" style={{ display: "block", fontWeight: 400 }}>
              {under}{under && p.completedOn ? " · " : ""}
              {p.completedOn ? `done ${p.completedOn}` : ""}
            </span>
          );
          return (
            <div key={p.taskId} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
              {p.href
                ? (
                  <Link href={p.href} className="t-body" style={{ textDecoration: "none", fontWeight: 600, flex: "1 1 220px", minWidth: 0 }}>
                    {p.title}{sub}
                  </Link>
                )
                : (
                  <span className="t-body" style={{ fontWeight: 600, flex: "1 1 220px", minWidth: 0 }}>
                    {p.title}{sub}
                  </span>
                )}
              <span className="mut t-small" style={{ width: 92, textAlign: "right" }}>
                {p.parts > 0 ? `${p.parts} part${p.parts === 1 ? "" : "s"}` : ""}
              </span>
              <span className="t-body" style={{ width: 92, textAlign: "right", fontWeight: 600 }}>
                {formatCents(p.partsCents)}
              </span>
              <span className="mut t-small" style={{ width: 118, textAlign: "right" }}>{p.note}</span>
            </div>
          );
        })}
      </Panel>

      <Panel
        title="By client"
        count={clients.length}
        hint={label}
        empty="Nothing yet."
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

          </div>
        ))}
      </Panel>

      {jobs.length === 0 && clients.length === 0 && pm.rows.length === 0 && (
        <EmptyState title="Nothing closed in this window." />
      )}
    </FinanceShell>
  );
}
