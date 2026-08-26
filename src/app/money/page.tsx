import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, myTenantOrgId } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents, formatDollars } from "@/lib/money";
import { brandForTenant } from "@/lib/brand";
import { costingBoard } from "@/lib/invoiceData";
import { booksContext } from "@/lib/financeData";
import { periodDays, periodSpan } from "@/lib/finance";
import FinanceShell from "@/components/FinanceShell";
import PositionLine from "@/components/PositionLine";
import DraftInvoiceButton from "@/components/DraftInvoiceButton";
import { EmptyState, Id, Panel, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Where the business stands, in money.
 *
 * This page used to open with five tiles - Quoted, Unbilled, Current, Past
 * due, Paid - side by side, with no arithmetic between any two of them. Every
 * figure an owner needs was on the screen and the answer was on none of it,
 * because the answer is a subtraction and nothing performed it.
 *
 * Three lanes perform it. What is owed to the business, what it owes, and the
 * difference. Underneath, the one list of things somebody has to decide,
 * gathered from four ledgers that were four menu items.
 */
export default async function MoneyPage({ searchParams }: {
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");

  // The window, the permission and every figure, asked the one way - see
  // lib/financeData. A page that worked out `seesPayroll` slightly differently
  // from the rail beside it is the leak this whole section is built around.
  const { period, today, seesPayroll, figures: fig } =
    await booksContext(user, (await searchParams).period);
  const [brand, board] = await Promise.all([
    brandForTenant(myTenantOrgId(user)),
    costingBoard(today, periodDays(today, period)),
  ]);

  const { moneyIn: mIn, moneyOut: mOut } = fig;
  // Receivable less payable. Deliberately NOT less payroll and overhead: those
  // are what it costs to exist rather than what anybody is waiting to be paid,
  // and leaving them out is also what keeps this figure the same number for
  // every reader - a total that changed shape by viewer would leak gross pay
  // by subtraction.
  const owed = mIn.currentCents + mIn.pastDueCents;
  const owes = mOut.purchasingCents + mOut.reimbursementsCents;
  const net = owed - owes;

  const collected = mIn.paidCents;
  const spread = collected + mIn.currentCents + mIn.pastDueCents;
  const width = (n: number) => (spread > 0 ? `${(n / spread) * 100}%` : "0%");

  const margins = board.clients.filter((c) => c.marginPct !== null).slice(0, 5);

  return (
    <FinanceShell
      rail={{ active: "overview", amounts: fig.amounts, seesBooks: true, seesPayroll }}
      period={period}
      path="/money"
      title="Financial"
      sub={`${brand.operatorName} · everything in, out, and what is left · ${periodSpan(today, period)}`}
      banner={
        <PositionLine owedCents={owed} owesCents={owes}
          pastDueCents={mIn.pastDueCents} pastDueCount={mIn.pastDueCount} period={period} />
      }
    >
      <div className="lanes">
        <div className="lane in">
          <h3>Money in <span className="tot money">{formatDollars(collected + owed)}</span></h3>
          <div className="inner">
            <Row label="Paid this period" sub="ACH, card, check" cents={mIn.paidCents} />
            <Row label="Invoiced, current" sub="inside terms" cents={mIn.currentCents} />
            <Row label="Past due" sub={`${mIn.pastDueCount} in collections`}
              cents={mIn.pastDueCents} tone={mIn.pastDueCents > 0 ? "bad" : undefined} />
            <Row label="Worked, unbilled" sub={`${mIn.unbilledJobs} closed job${mIn.unbilledJobs === 1 ? "" : "s"} - the leak`}
              cents={mIn.unbilledCents} tone={mIn.unbilledCents > 0 ? "warn" : undefined} />
            <div className="ledger total">
              <span className="grow">Owed to you</span>
              <span className="money">{formatCents(owed)}</span>
            </div>
          </div>
        </div>

        <div className="lane out">
          <h3>Money out</h3>
          <div className="inner">
            {/* Payroll and overhead appear only for a reader who may read them.
                Absent rather than zeroed: a $0 payroll line would be a lie, and
                a line labelled but blank tells them a number exists. */}
            {mOut.payrollCents !== null && (
              <Row label="Payroll" sub="gross this period" cents={mOut.payrollCents} />
            )}
            <Row label="Purchase orders" sub={`${mOut.openPos} committed, not yet received`}
              cents={mOut.purchasingCents} />
            {mOut.overheadCents !== null && (
              <Row label="Overhead" sub="runs whether or not anyone works" cents={mOut.overheadCents} />
            )}
            <Row label="Reimbursements" sub={`${mOut.reimbursementReports} report${mOut.reimbursementReports === 1 ? "" : "s"} awaiting payout`}
              cents={mOut.reimbursementsCents} tone={mOut.reimbursementsCents > 0 ? "warn" : undefined} />
            <div className="ledger total">
              <span className="grow">Owed by you</span>
              <span className="money">{formatCents(owes)}</span>
            </div>
          </div>
        </div>

        <div className="lane net">
          <h3>What is left</h3>
          <div className="inner">
            <div className={`bignum${net < 0 ? " neg" : ""}`}>{formatCents(net)}</div>
            <div className="biglab">receivable less payable · {periodSpan(today, period)}</div>
            <div className="rule" />
            <div className="bar" role="img"
              aria-label={`${formatDollars(collected)} collected, ${formatDollars(mIn.currentCents)} inside terms, ${formatDollars(mIn.pastDueCents)} past terms`}>
              <span style={{ width: width(collected), background: "var(--t-good-fg)" }} />
              <span style={{ width: width(mIn.currentCents), background: "var(--t-info-fg)" }} />
              <span style={{ width: width(mIn.pastDueCents), background: "var(--t-bad-fg)" }} />
            </div>
            <div className="bar-key">
              <span><i style={{ background: "var(--t-good-fg)" }} />Collected</span>
              <span><i style={{ background: "var(--t-info-fg)" }} />Current</span>
              <span><i style={{ background: "var(--t-bad-fg)" }} />Past due</span>
            </div>
            <div className="rule" />
            <Row label="Committed monthly" sub="contracts in force" cents={fig.contractsMonthlyCents} />
            <Row label="Quoted, awaiting" sub="not revenue until accepted" cents={mIn.quotedCents} />
          </div>
        </div>
      </div>

      <div className="pair" style={{ marginTop: 12 }}>
        <Panel title="Needs a decision" count={fig.decisions.length}
          hint="Every ledger in this section, ranked. Before it existed these lived on five pages and nothing added them up."
          empty="Nothing is waiting on you.">
          {fig.decisions.length > 0 && fig.decisions.map((d) => (
            <div key={d.key} className="ledger">
              <Pill tone={d.tone}>{d.tone === "bad" ? "Now" : "Soon"}</Pill>
              <span className="grow">
                <Link href={d.href} className="t-body plain" style={{ fontWeight: 600 }}>{d.title}</Link>
                <span className="sub">{d.detail}</span>
              </span>
            </div>
          ))}
        </Panel>

        <Panel title="Margin by client"
          hint={`Closed jobs, ${periodSpan(today, period).toLowerCase()}.`}
          actions={<Link className="btn sm" href="/money/costing">Open job costing</Link>}
          empty="Nothing closed in this window.">
          {margins.length > 0 && margins.map((c) => (
            <div key={c.orgId} className="ledger">
              <span className="grow">
                {c.orgName}
                <span className="sub">{formatCents(c.billedCents)} billed · {c.jobs} job{c.jobs === 1 ? "" : "s"}</span>
              </span>
              <Pill tone={(c.marginPct ?? 0) < 20 ? "bad" : (c.marginPct ?? 0) < 35 ? "warn" : "good"}>
                {c.marginPct}%
              </Pill>
              <span className="money">{formatCents(c.billedCents - c.costCents)}</span>
            </div>
          ))}
        </Panel>
      </div>

      {/* The only place a closed job can be turned into an invoice. The
          decisions list names the leak; this is where it gets plugged. */}
      <Panel title="Needs an invoice" count={fig.unbilled.length} empty="Nothing to invoice.">
        {fig.unbilled.length > 0 && fig.unbilled.map((j) => (
          <div key={j.woId} className="ledger">
            <span className="grow">
              <Link href={`/work/${j.woId}`} className="t-body plain" style={{ fontWeight: 600 }}>
                <Id>{j.number}</Id> {j.title}
              </Link>
              <span className="sub">
                {j.orgName}
                {j.closedOn ? ` · closed ${j.daysClosed}d ago` : ""}
                {j.coveredBy ? ` · ${j.allCovered ? "covered by" : "partly covered by"} ${j.coveredBy}` : ""}
              </span>
            </span>
            <span className="money">{formatCents(j.valueCents)}</span>
            <DraftInvoiceButton workOrderId={j.woId} number={j.number} />
          </div>
        ))}
      </Panel>

      {fig.decisions.length === 0 && owed === 0 && owes === 0 && (
        <EmptyState title="No money is moving yet."
          body="Quotes, invoices and orders show up here as they are raised." />
      )}
    </FinanceShell>
  );
}

/** One line of a lane: what it is, what it comes to, and why it is here. */
function Row({ label, sub, cents, tone }: {
  label: string; sub: string; cents: number; tone?: "warn" | "bad";
}) {
  return (
    <div className="ledger">
      <span className="grow">
        {label}
        <span className="sub">{sub}</span>
      </span>
      <span className="money" style={tone ? { color: `var(--t-${tone}-fg)` } : undefined}>
        {formatCents(cents)}
      </span>
    </div>
  );
}
