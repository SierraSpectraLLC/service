import Link from "next/link";
import { myTenantOrgId, type SessionUser } from "@/lib/authz";
import { readTenant, visibleOrgs } from "@/lib/tenancy";
import { brandForTenant } from "@/lib/brand";
import { formatCents, formatDollars } from "@/lib/money";
import { periodSpan } from "@/lib/finance";
import { booksContext } from "@/lib/financeData";
import { allInvoices, asStatementRow } from "@/lib/invoiceData";
import { aging, invoiceView } from "@/lib/statement";
import { coverageBoard } from "@/lib/pmPlanData";
import { coverageRollup } from "@/lib/pmPlan";
import { ladder } from "@/lib/chartPalette";
import { bands, cashByMonth, lastMonths, topDebtors } from "@/lib/ownerCharts";
import PositionLine from "@/components/PositionLine";
import TrendChart from "@/components/charts/TrendChart";
import SplitBar from "@/components/charts/SplitBar";
import RankBars from "@/components/charts/RankBars";
import StatTile from "@/components/charts/StatTile";
import Meter from "@/components/charts/Meter";
import { DataTable, Id, PageHead, Panel, Pill } from "@/components/ui";

/**
 * The operator's owner: the business, on one page.
 *
 * Deliberately a summary. Every number here is one lib/financeData already
 * computes for /money, read through the same booksContext so the two pages
 * cannot disagree, and every one of them links to the room that owns it. The
 * failure this avoids is a second set of totals - two pages answering "what
 * are we owed" with different numbers because one of them grew its own query.
 *
 * THE CHARTS ADD NO QUERIES. Every shape below is derived from rows this render
 * already had: allInvoices is cache()d and financeFigures fetched it moments
 * ago, so the twelve-month cash line, the ageing ladder and the debtor ranking
 * are three views of one set of rows rather than three trips to Postgres. The
 * one exception is the maintenance meter, which is its own reader and says so.
 *
 * WHY EACH FORM IS THE FORM. lib/dataviz's heuristic, applied:
 *   - the position is four numbers, so it is four stat tiles and one hero
 *     figure, not a four-bar bar chart;
 *   - billed against collected is two series of the same unit over time, so it
 *     is two lines on ONE axis - the gap between them IS the collection lag,
 *     and a second y-scale would let that gap say whatever was convenient;
 *   - ageing and the pipeline are ordered bands of one whole, so they are
 *     stacked bars in a validated ordinal ramp;
 *   - clients have no natural order, so the debtor chart is one series in one
 *     colour, its length carrying the only thing it knows.
 *
 * AND WHY THE LATE MONEY IS NOT RED. Severity is carried by the status tones -
 * the sentence at the top and the "Past terms" tile - and the ageing ladder
 * beside them is a SERIES, drawn in the sequential ramp. Reusing the status red
 * for a band of a chart would leave the page with one colour meaning two
 * things, which is the fastest way to make both of them mean nothing.
 */
export default async function OperatorOwnerView({ user, periodParam }: {
  user: SessionUser;
  periodParam?: string;
}) {
  // The window, the permission and every figure, asked the one way. This
  // redirects a staff member who may not read the books, which is the same
  // thing /money does to them.
  const { period, today, figures: fig } = await booksContext(user, periodParam);
  const tenant = readTenant(user);
  const [brand, invoices, orgRows] = await Promise.all([
    brandForTenant(myTenantOrgId(user)),
    // Already cache()d and already fetched by financeFigures on this render,
    // so this is the same rows, not a second read.
    allInvoices(tenant),
    visibleOrgs(user),
  ]);

  const { moneyIn: mIn, moneyOut: mOut } = fig;
  const owed = mIn.currentCents + mIn.pastDueCents;
  const owes = mOut.purchasingCents + mOut.reimbursementsCents;

  /*
   * Every invoice, priced once. invoiceView is the authority on what an invoice
   * is worth and how late it is; the three charts below are three groupings of
   * this one list, so they cannot disagree with each other or with /money.
   */
  const priced = invoices.map((f) => ({ orgId: f.row.orgId, f, view: invoiceView(asStatementRow(f), today) }));

  /*
   * How late the late money is. aging() buckets by daysLate and bucketOf
   * returns `current` for anything not yet past its terms, so d30 + d60 + d90
   * is pastDueCents by construction - this split cannot disagree with the
   * figure above it.
   */
  const buckets = aging(priced.map((p) => p.view)).buckets;
  const ageRamp = ladder(4);
  const age = bands([
    { key: "current", label: "Inside terms", cents: buckets.current },
    { key: "d30", label: "1-30 days", cents: buckets.d30 },
    { key: "d60", label: "31-60", cents: buckets.d60 },
    { key: "d90", label: "60+", cents: buckets.d90 },
  ]);

  /*
   * Twelve months of billing against twelve months of collection. Two dates,
   * not one: an invoice counts when it was ISSUED and a payment when it
   * ARRIVED, so the space between the lines is the lag. See lib/ownerCharts.
   */
  const months = lastMonths(today, 12);
  const cash = cashByMonth(
    priced.map((p) => ({
      issuedOn: p.f.row.issuedOn,
      status: p.f.row.status,
      billedCents: p.view.linesCents + p.view.feesCents,
      payments: p.f.payments.map((x) => ({ receivedOn: x.receivedOn, amountCents: x.amountCents })),
    })),
    months,
  );

  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const openInvoices = priced.filter((p) =>
    p.view.balanceCents > 0 && !["draft", "void", "paid"].includes(p.view.standing));
  const debtors = topDebtors(
    openInvoices.map((p) => ({ orgId: p.orgId, balanceCents: p.view.balanceCents })),
    (id) => orgName.get(id) ?? "an organization",
  );

  /*
   * The pipeline as three DISJOINT stocks: money quoted and not answered, work
   * done and not billed, bills sent and not paid. Collected is deliberately not
   * a fourth band - it is a flow through a window rather than a stock sitting
   * somewhere, and stacking it with the others would add a length to a bar
   * whose whole is supposed to be "money that has not landed yet".
   */
  const pipeRamp = ladder(3);
  const pipe = bands([
    { key: "quoted", label: "Quoted", cents: mIn.quotedCents },
    { key: "unbilled", label: "Not billed", cents: mIn.unbilledCents },
    { key: "open", label: "Invoiced", cents: owed },
  ]);

  /*
   * The maintenance promise, as one ratio. Its own reader - lib/pmPlanData -
   * because it is the only thing on this page that is not money, and the only
   * thing here that costs a query the render did not already have.
   */
  const pm = coverageRollup(
    (await coverageBoard({
      tenantOrgId: tenant, today,
      orgs: orgRows.filter((o) => o.kind === "client" && !o.isOperator).map((o) => ({ id: o.id, name: o.name })),
    })).flatMap((c) => c.rows.map((r) => r.coverage)),
  );

  const collected = cash.map((m) => m.collectedCents);
  const pastDueShare = owed > 0 ? Math.round((mIn.pastDueCents / owed) * 100) : 0;

  return (
    <div className="container wide">
      <PageHead
        title="Owner view"
        sub={`${brand.operatorName} · what is owed, what is owed out, and what needs you · ${periodSpan(today, period)}`}
        /* The way back. These two pages are one person's two questions - what
           is the shop doing today, and how is the business doing - so each
           carries the door to the other and neither needs a nav word. */
        actions={<Link className="btn sm" href="/">Switch to dashboard</Link>}
      />

      <PositionLine
        owedCents={owed} owesCents={owes}
        pastDueCents={mIn.pastDueCents} pastDueCount={mIn.pastDueCount}
        period={period}
      />

      {/* One hero figure on the page, and three tiles around it. Four numbers
          drawn as four bars would be a bar chart that says nothing the numbers
          do not say louder and smaller. */}
      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <StatTile
          hero
          label="Owed to you"
          value={formatDollars(owed)}
          sub={`${openInvoices.length} invoice${openInvoices.length === 1 ? "" : "s"} open`}
          href="/money/invoices"
        />
        <StatTile
          label="Past terms"
          value={formatDollars(mIn.pastDueCents)}
          sub={mIn.pastDueCents > 0
            ? `${pastDueShare}% of the book, across ${mIn.pastDueCount} invoice${mIn.pastDueCount === 1 ? "" : "s"}`
            : "Nothing is late"}
          tone={mIn.pastDueCents === 0 ? "good" : pastDueShare >= 25 ? "bad" : "warn"}
          href="/money/collections"
        />
        <StatTile
          label="You owe out"
          value={formatDollars(owes)}
          sub={`${mOut.openPos} order${mOut.openPos === 1 ? "" : "s"} · ${mOut.reimbursementReports} claim${mOut.reimbursementReports === 1 ? "" : "s"}`}
          href="/money/purchasing"
        />
        <StatTile
          /* The window's own words, not "this " + a label that already says
             "This month". PERIOD_LABEL is written for a rail, where the label
             stands alone. */
          label={period === "ytd" ? "Collected this year" : period === "quarter" ? "Collected this quarter" : "Collected this month"}
          value={formatDollars(mIn.paidCents)}
          sub="Money that actually arrived"
          spark={collected}
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
          title="How late"
          hint="Everything open, by how long it has been waiting."
          empty="Nothing is outstanding."
          actions={mIn.pastDueCents > 0
            ? <Link className="btn sm" href="/money/collections">Collections</Link>
            : undefined}
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
          actions={<Link className="btn sm" href="/money/invoices">Invoices</Link>}
        >
          {debtors.top.length > 0 && (
            <RankBars
              rows={[
                ...debtors.top.map((d) => ({
                  key: String(d.orgId),
                  label: d.name,
                  cents: d.cents,
                  detail: `${d.invoices} invoice${d.invoices === 1 ? "" : "s"}`,
                  href: `/settings/organizations/${d.orgId}`,
                })),
                // The tail is summed rather than dropped: a top-six that
                // silently omits the rest answers "who owes us" wrongly.
                ...(debtors.restCount > 0 ? [{
                  key: "rest",
                  label: `${debtors.restCount} other${debtors.restCount === 1 ? "" : "s"}`,
                  cents: debtors.restCents,
                  faint: true,
                }] : []),
              ]}
            />
          )}
        </Panel>
      </div>

      <div className="chart-pair">
        <Panel
          title="The pipeline"
          hint="Money that has not landed yet, by how far along it is."
          empty="Nothing quoted, unbilled or outstanding."
        >
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
            <div style={{ display: "grid", gap: 14 }}>
              <Meter
                label="Systems behind"
                done={pm.behind}
                total={pm.planned}
                invert
                sub={pm.behind === 0
                  ? "Every system on a plan is on pace for the year."
                  : `${pm.behind} of ${pm.planned} have had fewer visits than the year has asked for.`}
              />
              <Meter
                label="Visits delivered"
                done={pm.delivered}
                total={pm.delivered + pm.owed}
                sub={`${pm.owed} still owed before the year is out.`}
              />
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Needs a decision"
        count={fig.decisions.length}
        hint="Gathered from every ledger. Each one is somebody waiting on you."
        empty="Nothing is waiting on a decision."
        actions={<Link className="btn sm" href="/money">Financial</Link>}
      >
        {fig.decisions.length > 0 && (
          <DataTable
            cols={[
              { key: "what", label: "What", width: "minmax(240px, 2fr)" },
              { key: "detail", label: "Detail", width: "minmax(160px, 1.4fr)", hideMobile: true },
            ]}
            rows={fig.decisions.map((d) => ({
              key: d.key,
              href: d.href,
              cells: {
                what: <><Pill tone={d.tone}>{d.tone === "bad" ? "now" : "soon"}</Pill> <span>{d.title}</span></>,
                detail: <span className="mut">{d.detail}</span>,
              },
            }))}
          />
        )}
      </Panel>

      <Panel
        title="Not yet invoiced"
        count={mIn.unbilledJobs}
        hint={`${formatCents(mIn.unbilledCents)} of closed work nobody has billed.`}
        empty="Every closed job has been invoiced."
        actions={<Link className="btn sm" href="/money/invoices">Invoices</Link>}
      >
        {fig.unbilled.length > 0 && (
          <DataTable
            cols={[
              { key: "job", label: "Job", width: "minmax(160px, 1.4fr)" },
              { key: "client", label: "Client", width: "minmax(120px, 1fr)", hideMobile: true },
              { key: "value", label: "Value", width: "110px", align: "right" },
            ]}
            rows={fig.unbilled.map((j) => ({
              key: j.woId,
              href: `/work/${j.woId}`,
              cells: {
                job: <Id>{j.number}</Id>,
                client: <span className="mut">{j.orgName}</span>,
                value: formatCents(j.valueCents),
              },
            }))}
          />
        )}
      </Panel>

      {/* The work half is not reproduced here. /work is where a job is
          cleared and it is not gated on the books, so an owner following
          this lands where their dispatchers already are. */}
      <Panel
        title="The floor"
        hint="Work, stages and turnaround live where the people doing them work."
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="btn sm" href="/work">Jobs</Link>
          <Link className="btn sm" href="/">The board</Link>
          <Link className="btn sm" href="/metrics">Metrics</Link>
          <Link className="btn sm" href="/money/contracts">Contracts</Link>
          <Link className="btn sm" href="/maintenance">Maintenance</Link>
        </div>
      </Panel>
    </div>
  );
}
