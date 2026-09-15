import Link from "next/link";
import { myTenantOrgId, type SessionUser } from "@/lib/authz";
import { visibleOrgs } from "@/lib/tenancy";
import { brandForTenant } from "@/lib/brand";
import { formatCents, formatDollars } from "@/lib/money";
import { periodSpan, positionTone, withPeriod } from "@/lib/finance";
import { booksContext } from "@/lib/financeData";
import { allInvoices, asStatementRow } from "@/lib/invoiceData";
import { aging, invoiceView } from "@/lib/statement";
import { coverageBoard } from "@/lib/pmPlanData";
import { coverageRollup } from "@/lib/pmPlan";
import { ladder } from "@/lib/chartPalette";
import { bands, cashByMonth, lastMonths, runningCosts, topDebtors } from "@/lib/ownerCharts";
import TrendChart from "@/components/charts/TrendChart";
import SplitBar from "@/components/charts/SplitBar";
import RankBars from "@/components/charts/RankBars";
import StatTile from "@/components/charts/StatTile";
import Meter from "@/components/charts/Meter";
import StatusLine from "@/components/ui/StatusLine";
import { DataTable, Id, PageHead, Panel, Pill } from "@/components/ui";

/**
 * The operator's owner: the business, on one page.
 *
 * Deliberately a summary. Every dollar here is one lib/money/figures already
 * computed for /money - a sum over the ledger, read through the same
 * booksContext - so the two pages cannot disagree, and every one of them
 * links to the room that owns it.
 *
 * THE CHARTS ADD NO QUERIES beyond the invoice rows: allInvoices is cache()d
 * and the figures loader fetched it moments ago, so the twelve-month cash
 * line, the ageing ladder and the debtor ranking are three views of one set
 * of rows. The one exception is the maintenance meter, which is its own
 * reader and says so.
 */
export default async function OperatorOwnerView({ user, periodParam }: {
  user: SessionUser;
  periodParam?: string;
}) {
  const { period, today, mine, seesPayroll, figures: f } = await booksContext(user, periodParam);
  const [brand, invoices, orgRows] = await Promise.all([
    brandForTenant(myTenantOrgId(user)),
    allInvoices(mine),
    visibleOrgs(user),
  ]);

  const owed = f.positions.receivable;
  const owes = f.owes.totalCents;
  const pastDue = f.stages.pastDue;
  const net = owed - owes;
  const tone = positionTone(owed, pastDue.cents);
  const share = owed > 0 ? Math.round((pastDue.cents / owed) * 100) : 0;

  const priced = invoices.map((x) => ({ orgId: x.row.orgId, f: x, view: invoiceView(asStatementRow(x), today) }));
  const buckets = aging(priced.map((p) => p.view)).buckets;
  const ageRamp = ladder(4);
  const age = bands([
    { key: "current", label: "Inside terms", cents: buckets.current },
    { key: "d30", label: "1-30 days", cents: buckets.d30 },
    { key: "d60", label: "31-60", cents: buckets.d60 },
    { key: "d90", label: "60+", cents: buckets.d90 },
  ]);
  const months = lastMonths(today, 12);
  const cash = cashByMonth(
    priced.map((p) => ({
      issuedOn: p.f.row.issuedOn, status: p.f.row.status,
      billedCents: p.view.linesCents + p.view.feesCents,
      payments: p.f.payments.map((x) => ({ receivedOn: x.receivedOn, amountCents: x.amountCents })),
    })),
    months,
  );
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const openInvoices = priced.filter((p) => p.view.balanceCents > 0 && !["draft", "void", "paid"].includes(p.view.standing));
  const debtors = topDebtors(
    openInvoices.map((p) => ({ orgId: p.orgId, balanceCents: p.view.balanceCents })),
    (id) => orgName.get(id) ?? "an organization",
  );
  const pipeRamp = ladder(3);
  const pipe = bands([
    { key: "quoted", label: "Quoted", cents: f.stages.quoted.cents },
    { key: "unbilled", label: "Not billed", cents: f.stages.unbilled.cents },
    { key: "open", label: "Invoiced", cents: owed },
  ]);
  const pm = coverageRollup(
    (await coverageBoard({
      tenantOrgId: mine, today,
      orgs: orgRows.filter((o) => o.kind === "client" && !o.isOperator).map((o) => ({ id: o.id, name: o.name })),
    })).flatMap((c) => c.rows.map((r) => r.coverage)),
  );
  const collected = cash.map((m) => m.collectedCents);
  const costs = runningCosts(f.collected.cents, seesPayroll ? f.flow.cost.payroll : null, f.flow.cost.overhead);
  const costBands = bands(costs.rows);
  const costRamp = ladder(2);
  const costLabel = costs.complete ? "payroll and overhead" : "overhead, before payroll";

  return (
    <div className="container wide">
      <PageHead
        title="Owner view"
        sub={`${brand.operatorName} · what is owed, what is going out, and what needs you · ${periodSpan(today, period)}`}
        actions={<Link className="btn sm" href="/">Switch to dashboard</Link>}
      />

      <StatusLine tone={tone} actions={<>
        {pastDue.cents > 0 && <Link className="btn sm accent" href={withPeriod("/money/receivables?stage=pastdue", period)}>Work collections</Link>}
        <Link className="btn sm" href={withPeriod("/money/receivables", period)}>Receivables</Link>
      </>}>
        You are owed <span className="fig">{formatDollars(owed)}</span> and owe{" "}
        <span className="fig">{formatDollars(owes)}</span>. Net <span className="fig">{formatDollars(net)}</span>
        {pastDue.cents > 0
          ? <> — but <span className="fig">{formatDollars(pastDue.cents)}</span> of what you are owed is past terms (<b>{share}%</b>, across {pastDue.n} invoice{pastDue.n === 1 ? "" : "s"}).</>
          : <>. Nothing is past terms.</>}
      </StatusLine>

      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <StatTile
          hero
          label="Cash on hand"
          value={formatDollars(f.cashCents)}
          sub={f.runway.months === null ? "bank plus Stripe, from the ledger" : `bank plus Stripe · ${f.runway.months} months of runway at ${formatDollars(f.runway.burnCents)}/mo`}
          tone={f.cashCents < 0 ? "bad" : undefined}
          href="/money/cash"
        />
        <StatTile
          label="Owed to you"
          value={formatDollars(owed)}
          sub={`${openInvoices.length} invoice${openInvoices.length === 1 ? "" : "s"} open`}
          href="/money/receivables"
        />
        <StatTile
          label="Past terms"
          value={formatDollars(pastDue.cents)}
          sub={pastDue.cents > 0 ? `${share}% of the book, across ${pastDue.n} invoice${pastDue.n === 1 ? "" : "s"}` : "Nothing is late"}
          tone={pastDue.cents === 0 ? "good" : share >= 25 ? "bad" : "warn"}
          href="/money/receivables?stage=pastdue"
        />
        <StatTile
          label="You owe out"
          value={formatDollars(owes)}
          sub={`${formatDollars(f.owes.vendorsCents)} vendors · ${formatDollars(f.owes.reimbDueCents)} people · ${formatDollars(f.owes.taxCents)} tax`}
          href="/money/payables"
        />
        <StatTile
          label={period === "ytd" ? "Collected this year" : period === "quarter" ? "Collected this quarter" : "Collected this month"}
          value={formatDollars(f.collected.cents)}
          sub="Money that actually arrived"
          spark={collected}
        />
        <StatTile
          label={period === "ytd" ? "Spent this year" : period === "quarter" ? "Spent this quarter" : "Spent this month"}
          value={formatDollars(costs.totalCents)}
          sub={costs.complete ? "Payroll and overhead" : "Overhead only - the register is not yours to read"}
          href={withPeriod("/money/reports", period)}
        />
      </div>

      <Panel
        title="Billed and collected"
        hint="Twelve months. An invoice counts in the month it went out and a payment in the month it landed, so the space between the lines is how long you wait to be paid."
        actions={<Link className="btn sm" href="/money">Financial</Link>}
      >
        <TrendChart
          points={cash.map((m) => ({ label: m.label, values: [m.billedCents, m.collectedCents] }))}
          names={["Billed", "Collected"]}
          height={210}
        />
      </Panel>

      <div className="chart-pair">
        <Panel
          title="Going out"
          hint={`What it costs to exist, whether or not a job happens: ${costLabel}, ${periodSpan(today, period)}.`}
          empty={costs.complete ? "Nothing has gone out to payroll or overhead this period." : "No overhead has been recorded this period."}
          actions={<>
            {seesPayroll && <Link className="btn sm" href={withPeriod("/money/payroll", period)}>Payroll</Link>}
            <Link className="btn sm" href={withPeriod("/money/payables", period)}>Payables</Link>
          </>}
        >
          {costBands.shown.length > 0 && (
            <SplitBar
              slices={costBands.shown.map((b, i) => ({ ...b, color: costRamp[["payroll", "overhead"].indexOf(b.key)] ?? costRamp[i] }))}
              totalCents={costBands.totalCents}
              unit="spent this period"
            />
          )}
        </Panel>

        <Panel
          title="After costs"
          hint="Collected, less what it cost to be open while collecting it. Open orders and unpaid claims are not in here - they have not moved yet, and the position line above already counts them."
        >
          <div className={`bignum${costs.leftCents < 0 ? " neg" : ""}`}>{formatCents(costs.leftCents)}</div>
          <div className="biglab">
            left {costs.complete ? "after payroll and overhead" : "after overhead, before payroll"}
            {" · "}{periodSpan(today, period)}
          </div>
          <div className="rule" />
          <div className="ledger">
            <span className="grow">Collected<span className="sub">money that actually arrived</span></span>
            <span className="money">{formatCents(f.collected.cents)}</span>
          </div>
          {seesPayroll && (
            <div className="ledger">
              <span className="grow">Payroll<span className="sub">gross, employer costs included</span></span>
              <span className="money">&minus;{formatCents(f.flow.cost.payroll)}</span>
            </div>
          )}
          <div className="ledger">
            <span className="grow">Overhead<span className="sub">runs whether or not anyone works</span></span>
            <span className="money">&minus;{formatCents(f.flow.cost.overhead)}</span>
          </div>
          <div className="ledger total">
            <span className="grow">Left this period</span>
            <span className={`money${costs.leftCents < 0 ? " neg" : ""}`}>{formatCents(costs.leftCents)}</span>
          </div>
        </Panel>
      </div>

      <div className="chart-pair">
        <Panel
          title="How late"
          hint="Everything open, by how long it has been waiting."
          empty="Nothing is outstanding."
          actions={pastDue.cents > 0 ? <Link className="btn sm" href="/money/receivables?stage=pastdue">Collections</Link> : undefined}
        >
          {age.shown.length > 0 && (
            <SplitBar
              slices={age.shown.map((b, i) => ({ ...b, color: ageRamp[["current", "d30", "d60", "d90"].indexOf(b.key)] ?? ageRamp[i] }))}
              totalCents={age.totalCents}
            />
          )}
        </Panel>

        <Panel
          title="Who owes you"
          count={debtors.top.length || undefined}
          hint="Open balance by client, largest first."
          empty="Nobody owes you anything."
          actions={<Link className="btn sm" href="/money/clients">Clients</Link>}
        >
          {debtors.top.length > 0 && (
            <RankBars
              rows={[
                ...debtors.top.map((d) => ({
                  key: String(d.orgId), label: d.name, cents: d.cents,
                  detail: `${d.invoices} invoice${d.invoices === 1 ? "" : "s"}`,
                  href: `/money/clients?org=${d.orgId}`,
                })),
                ...(debtors.restCount > 0 ? [{
                  key: "rest", label: `${debtors.restCount} other${debtors.restCount === 1 ? "" : "s"}`,
                  cents: debtors.restCents, faint: true,
                }] : []),
              ]}
            />
          )}
        </Panel>
      </div>

      <div className="chart-pair">
        <Panel title="The pipeline" hint="Money that has not landed yet, by how far along it is." empty="Nothing quoted, unbilled or outstanding.">
          {pipe.shown.length > 0 && (
            <SplitBar
              slices={pipe.shown.map((b, i) => ({ ...b, color: pipeRamp[["quoted", "unbilled", "open"].indexOf(b.key)] ?? pipeRamp[i] }))}
              totalCents={pipe.totalCents}
              unit="in flight"
            />
          )}
        </Panel>

        <Panel
          title="The maintenance promise"
          hint="Systems on a plan, and whether this year's visits have happened."
          actions={<Link className="btn sm" href="/maintenance/coverage">Coverage</Link>}
          empty="No client is on a maintenance plan yet."
        >
          {pm.planned > 0 && (
            <div style={{ display: "grid", gap: 16 }}>
              <Meter label="Systems behind" done={pm.behind} total={pm.planned} invert
                sub={pm.behind === 0 ? "Every system on a plan is on pace for the year." : `${pm.behind} of ${pm.planned} have had fewer visits than the year has asked for.`} />
              <Meter label="Visits delivered" done={pm.delivered} total={pm.delivered + pm.owed}
                sub={`${pm.owed} still owed before the year is out.`} />
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Needs a decision"
        count={f.decisions.length}
        hint="Gathered from every document. Each one is somebody waiting on you; the button that posts is on Financial."
        empty="Nothing is waiting on a decision."
        actions={<Link className="btn sm" href="/money">Financial</Link>}
      >
        {f.decisions.length > 0 && (
          <DataTable
            cols={[
              { key: "what", label: "What", width: "minmax(240px, 2fr)" },
              { key: "detail", label: "Detail", width: "minmax(160px, 1.4fr)", hideMobile: true },
              { key: "cents", label: "Amount", width: "110px", align: "right" },
            ]}
            rows={f.decisions.map((d) => ({
              key: d.key,
              href: d.href,
              cells: {
                what: <><Pill tone={d.tone === "bad" ? "bad" : d.tone === "warn" ? "warn" : "neutral"}>{d.tone === "bad" ? "now" : d.tone === "warn" ? "soon" : "when you can"}</Pill> <span>{d.title}</span></>,
                detail: <span className="mut">{d.detail}</span>,
                cents: formatCents(d.cents),
              },
            }))}
          />
        )}
      </Panel>

      <Panel
        title="Not yet invoiced"
        count={f.sources.unbilled.length}
        hint={`${formatCents(f.sources.unbilled.reduce((n, j) => n + j.valueCents, 0))} of closed work nobody has billed.`}
        empty="Every closed job has been invoiced."
        actions={<Link className="btn sm" href="/money/receivables?stage=unbilled">Receivables</Link>}
      >
        {f.sources.unbilled.length > 0 && (
          <DataTable
            cols={[
              { key: "job", label: "Job", width: "minmax(160px, 1.4fr)" },
              { key: "client", label: "Client", width: "minmax(120px, 1fr)", hideMobile: true },
              { key: "value", label: "Value", width: "110px", align: "right" },
            ]}
            rows={f.sources.unbilled.map((j) => ({
              key: j.woId,
              href: `/work/${j.woId}`,
              cells: { job: <Id>{j.number}</Id>, client: <span className="mut">{j.orgName}</span>, value: formatCents(j.valueCents) },
            }))}
          />
        )}
      </Panel>

      <Panel title="The floor" hint="Work, stages and turnaround live where the people doing them work.">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="btn sm" href="/work">Jobs</Link>
          <Link className="btn sm" href="/">The board</Link>
          <Link className="btn sm" href="/metrics">Metrics</Link>
          <Link className="btn sm" href="/money/clients">Clients</Link>
          <Link className="btn sm" href="/maintenance">Maintenance</Link>
        </div>
      </Panel>
    </div>
  );
}
