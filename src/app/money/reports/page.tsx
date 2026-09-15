import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { booksContext } from "@/lib/financeData";
import { periodDays, periodSpan, plusDays } from "@/lib/finance";
import { ACCOUNTS, accountSums, closedThrough, COST_ACCOUNTS, REVENUE_ACCOUNTS, sumsByOrg } from "@/lib/ledger";
import { monthWord } from "@/lib/ledger/postings";
import { monthsBetween } from "@/lib/ledger/backfill";
import { costingBoard } from "@/lib/invoiceData";
import { endOfMonth } from "@/lib/bills";
import FinanceShell from "@/components/FinanceShell";
import { CloseBooksForm } from "@/components/money/LedgerTools";
import { Figure, Id, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Derived from the ledger, nothing typed: the P&L (accrual) beside the cash
 * flow, with the gap between them named; margin by client; job costing;
 * closing the books; the exports. Every figure is a door into the rows.
 */
export default async function ReportsPage({ searchParams }: {
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { period, today, mine, seesPayroll, figures: f, rail } = await booksContext(user, (await searchParams).period);
  const isOwner = user.role === "owner";
  const label = periodSpan(today, period);

  const [before, byOrg, orgRows, closed, board] = await Promise.all([
    accountSums({ tenant: mine, to: plusDays(f.from, -1) }),
    sumsByOrg(mine, f.from, f.to),
    db.select({ id: orgs.id, name: orgs.name }).from(orgs),
    closedThrough(),
    costingBoard(today, periodDays(today, period), mine),
  ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const openingCash = before.filter((s) => s.account === "bank" || s.account === "stripe").reduce((n, s) => n + s.balanceCents, 0);
  const revenue = REVENUE_ACCOUNTS.map((k) => [k, f.flow.revenue[k]] as const);
  const cost = COST_ACCOUNTS.filter((k) => k !== "payroll" || seesPayroll).map((k) => [k, f.flow.cost[k]] as const);
  const revT = f.flow.revenueCents;
  const costT = cost.reduce((n, [, v]) => n + v, 0);
  const net = revT - costT;
  const cashChange = f.flow.cashInCents - f.flow.cashOutCents;
  const margins = byOrg.map((o) => ({ ...o, marginPct: o.revenueCents ? Math.round(((o.revenueCents - o.partsCostCents - o.fieldCostCents) / o.revenueCents) * 100) : null }))
    .sort((a, b) => b.revenueCents - a.revenueCents);
  const maxRev = Math.max(1, ...margins.map((m) => m.revenueCents));

  // Months that have ended and are not yet closed, newest first.
  const thisYm = today.slice(0, 7);
  const closable = monthsBetween(plusDays(f.from, -400).slice(0, 7), thisYm)
    .filter((ym) => ym < thisYm && endOfMonth(`${ym}-01`) <= today && ym > closed)
    .reverse().slice(0, 12).map((ym) => ({ ym, label: monthWord(ym) }));

  return (
    <FinanceShell
      rail={rail} active="reports"
      period={period}
      path="/money/reports"
      title="Reports"
      sub={`Derived from the ledger, nothing typed · ${label}`}
    >
      <div className="two">
        <div className="panel">
          <div className="ph"><h2>Profit and loss · {label}</h2><span className="t-meta mut">accrual: revenue when invoiced, cost when received</span></div>
          <div className="tblwrap"><table className="list pl"><tbody>
            <tr><td>Revenue</td><td className="num"></td></tr>
            {revenue.map(([k, v]) => <tr key={k}><td className="ind">{ACCOUNTS[k].name}</td><td className="num"><Figure cents={v} filter={{ acct: k, from: f.from, to: f.to }} /></td></tr>)}
            <tr className="tot"><td>Total revenue</td><td className="num">{formatCents(revT)}</td></tr>
            <tr><td>Costs</td><td></td></tr>
            {cost.map(([k, v]) => <tr key={k}><td className="ind">{ACCOUNTS[k].name}</td><td className="num"><Figure cents={v} filter={{ acct: k, from: f.from, to: f.to }} /></td></tr>)}
            <tr className="tot"><td>Total costs{seesPayroll ? "" : " (before payroll)"}</td><td className="num">{formatCents(costT)}</td></tr>
            <tr className="tot"><td>Net</td><td className={`num fig ${net < 0 ? "bad" : "good"}`}>{formatCents(net)}</td></tr>
          </tbody></table></div>
        </div>
        <div className="panel">
          <div className="ph"><h2>Cash flow · {label}</h2><span className="t-meta mut">the other question: what actually moved</span></div>
          <div className="tblwrap"><table className="list pl"><tbody>
            <tr><td>Opening cash</td><td className="num">{formatCents(openingCash)}</td></tr>
            <tr><td className="ind">In (payments, deposits, payouts)</td><td className="num"><Figure cents={f.flow.cashInCents} filter={{ acct: "bank", side: "dr", from: f.from, to: f.to }} tone="good" /></td></tr>
            <tr><td className="ind">Out (vendors, bills, people)</td><td className="num"><Figure cents={f.flow.cashOutCents} filter={{ acct: "bank", side: "cr", from: f.from, to: f.to }} tone="bad" label={`−${formatCents(f.flow.cashOutCents)}`} /></td></tr>
            <tr className="tot"><td>Closing cash</td><td className="num">{formatCents(openingCash + cashChange)}</td></tr>
            <tr><td colSpan={2} className="t-meta mut" style={{ paddingTop: 12 }}>
              Net income {formatCents(net)} and cash change {formatCents(cashChange)} differ by {formatCents(Math.abs(net - cashChange))} - that gap is receivables aging, payables unpaid, deposits held and tax collected. It is the number most shops cannot see.
            </td></tr>
          </tbody></table></div>
        </div>
      </div>

      <div className="panel">
        <div className="ph"><h2>Margin by client · {label}</h2><span className="t-meta mut">revenue invoiced less parts and field cost posted against their jobs</span></div>
        <div className="tblwrap"><table className="list">
          <thead><tr><th>Client</th><th>Revenue</th><th className="r">Direct cost</th><th className="r">Margin</th></tr></thead>
          <tbody>
            {margins.length === 0 && <tr><td colSpan={4} className="empty">Nothing invoiced in this window.</td></tr>}
            {margins.map((m) => (
              <tr key={m.orgId}>
                <td style={{ width: "30%" }}><Link className="plain" href={`/money/clients?org=${m.orgId}`}>{orgName.get(m.orgId) ?? `org ${m.orgId}`}</Link></td>
                <td><div className="bar" style={{ margin: 0 }}><span style={{ width: `${Math.min(100, (Math.max(0, m.revenueCents) / maxRev) * 100)}%`, background: "var(--navy)" }} /></div>
                  <span className="t-meta mut"><Figure cents={m.revenueCents} filter={{ org: m.orgId, from: f.from, to: f.to }} /></span></td>
                <td className="num">{formatCents(m.partsCostCents + m.fieldCostCents)}</td>
                <td className={`num${m.marginPct !== null && m.marginPct < 50 ? " fig warn" : ""}`}>{m.marginPct === null ? "—" : `${m.marginPct}%`}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      <div className="two">
        <div className="panel">
          <div className="ph"><h2>Close the books</h2><span className="t-meta mut">{closed ? <>closed through <b>{monthWord(closed)}</b></> : "nothing closed yet"}</span></div>
          <div className="pb">
            <p className="t-small" style={{ margin: "0 0 10px" }}>A closed month takes no new postings. A mistake found later is corrected by a reversing entry dated today, so the month your accountant already has never changes under them.</p>
            {isOwner ? <CloseBooksForm closedThrough={closed} months={closable} /> : <span className="t-meta mut">The owner closes the books.</span>}
          </div>
        </div>
        <div className="panel">
          <div className="ph"><h2>Send to the accountant</h2><span className="t-meta mut">the journal, not a summary of it</span></div>
          <div className="pb">
            <p className="t-small" style={{ margin: "0 0 10px" }}>Ridgeline is not the tax return. It is the book the return is prepared from. Both exports are the ledger, row for row.</p>
            {isOwner ? (
              <div className="inline-form">
                <a className="btn sm" href="/money/reports/export?format=csv">Ledger as CSV</a>
                <a className="btn sm" href="/money/reports/export?format=iif">Journal for QuickBooks</a>
              </div>
            ) : <span className="t-meta mut">The owner exports the journal.</span>}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph"><h2>Job costing · {label}</h2><span className="t-meta mut">
          {board.loadedLaborCents > 0 ? `billed against parts, expenses, and hours at ${formatCents(board.loadedLaborCents)}/h loaded` : "no loaded labor rate set - margins exclude labor"}
        </span></div>
        <div className="tblwrap"><table className="list">
          <thead><tr><th>Job</th><th>Client</th><th className="r">Billed</th><th className="r">Cost</th><th className="r">Margin</th></tr></thead>
          <tbody>
            {board.jobs.length === 0 && <tr><td colSpan={5} className="empty">Nothing closed in {label}.</td></tr>}
            {[...board.jobs].sort((a, b) => (a.marginPct ?? 999) - (b.marginPct ?? 999)).map((j) => (
              <tr key={j.woId} className="row">
                <td><Link className="plain doc" href={`/work/${j.woId}`}><Id>{j.number}</Id></Link><span className="meta">{j.title}</span></td>
                <td>{j.orgName}</td>
                <td className="num">{formatCents(j.billedCents)}</td>
                <td className="num">{formatCents(j.costCents)}</td>
                <td className="num">{j.marginPct === null ? <Pill tone={j.tone}>{j.note}</Pill> : <span className={j.marginPct < 20 ? "fig warn" : ""}>{j.marginPct}%</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="note">Job cost is parts at what they landed at, expenses on the job, and hours at the loaded rate from <Link href="/money/payroll">the register</Link>. A covered job reports the agreement, not a percentage.</div>
      </div>
    </FinanceShell>
  );
}
