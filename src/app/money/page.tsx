import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, myTenantOrgId } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { brandForTenant } from "@/lib/brand";
import { booksContext } from "@/lib/financeData";
import { periodSpan, periodWord } from "@/lib/finance";
import FinanceShell from "@/components/FinanceShell";
import CashOpeningForm from "@/components/CashOpeningForm";
import DecisionButton from "@/components/money/DecisionButton";
import { Figure } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Where the business stands, in money.
 *
 * The cash line first - the one big number, and what the books know about
 * it. Then the position: owed, owes, and the difference, with the deposits
 * called out as not-yours. Then the one list of things somebody has to
 * decide, worst first, where every row's button is the action. Every figure
 * is a button into the ledger, because nothing here is stored.
 */
export default async function MoneyPage({ searchParams }: {
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { period, today, figures: f, rail } = await booksContext(user, (await searchParams).period);
  const brand = await brandForTenant(myTenantOrgId(user));
  const p = f.positions;
  const net = p.receivable - f.owes.totalCents;
  const unrec = f.unreconciled.unmatched + f.unreconciled.inTransit;
  const hasOpening = f.sources.today !== "" && (p.bank !== 0 || p.stripe !== 0 || f.flow.cashInCents > 0);

  return (
    <FinanceShell
      rail={rail} active="overview"
      period={period}
      path="/money"
      title="Financial"
      sub={`${brand.operatorName} · cash, position, and what needs deciding · ${periodSpan(today, period)}`}
    >
      <div className="panel">
        <div className="cashline">
          <div>
            <div>
              <Figure cents={f.cashCents} filter={{ acct: "bank" }} big />
            </div>
            <div className="since">
              Cash on hand · <Figure cents={p.bank} filter={{ acct: "bank" }} label={`${formatCents(p.bank)} in the bank`} />
              {p.stripe !== 0 && <> + <Figure cents={p.stripe} filter={{ acct: "stripe" }} label={`${formatCents(p.stripe)} in Stripe`} /></>}
              {" · "}
              {unrec > 0
                ? <Link href="/money/cash">{unrec} item{unrec === 1 ? "" : "s"} unreconciled</Link>
                : f.unreconciled.hasFeed ? "reconciled to the bank" : <Link href="/money/cash">no bank feed yet</Link>}
              . <b>{formatCents(f.collected.cents)}</b> collected and <b>−{formatCents(f.flow.costCents)}</b> out {periodWord(period)}.
            </div>
            {!hasOpening && (
              <div className="mut t-small" style={{ marginTop: 8 }}>
                The bank balance is the one figure the books cannot work out. Tell it once; it posts an opening entry and carries the figure forward.
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <CashOpeningForm today={today} compact={hasOpening} canSet={user.role === "owner"} />
            </div>
          </div>
          <div className="runway">
            <div className="n">{f.runway.months === null ? "—" : `${f.runway.months} mo`}</div>
            <div className="meta t-meta mut">runway at {formatCents(f.runway.burnCents)}/mo average burn (last two months)</div>
          </div>
        </div>
        <div className="position">
          <div>
            <div className="k">Owed to you</div>
            <div className="v"><Figure cents={p.receivable} filter={{ acct: "receivable" }} /></div>
            <div className="d">
              <Figure cents={f.stages.pastDue.cents} filter={{ acct: "receivable", live: true }} tone={f.stages.pastDue.cents ? "bad" : undefined} />
              {" "}past due on {f.stages.pastDue.n} · {formatCents(f.stages.current.cents)} inside terms
            </div>
          </div>
          <div>
            <div className="k">You owe</div>
            <div className="v"><Figure cents={f.owes.totalCents} filter={{ acct: "payable" }} /></div>
            <div className="d">
              {formatCents(f.owes.vendorsCents)} to vendors · {formatCents(f.owes.reimbDueCents)} to your people · {formatCents(f.owes.taxCents)} sales tax
            </div>
          </div>
          <div>
            <div className="k">Position</div>
            <div className={`v${net < 0 ? " fig bad" : ""}`}>{formatCents(net)}</div>
            <div className="d">
              receivable less payable, right now. <Figure cents={p.depositsHeld} filter={{ acct: "deposits_held" }} /> held in deposits is not yours yet.
            </div>
          </div>
        </div>
      </div>

      <div className="panel decide">
        <div className="ph">
          <h2>Needs a decision</h2>
          <span className="t-meta mut">{f.decisions.length} item{f.decisions.length === 1 ? "" : "s"}, worst first · each one is a button that posts</span>
        </div>
        <ul>
          {f.decisions.length === 0 && <li><span className="mut">Nothing waiting on you.</span></li>}
          {f.decisions.map((d) => (
            <li key={d.key}>
              <div className="why">
                <Link href={d.href}>{d.title}</Link>
                <span className="meta">{d.detail}</span>
              </div>
              <div className={`amt${d.tone ? ` ${d.tone}` : ""}`}>{formatCents(d.cents)}</div>
              <div><DecisionButton action={d.action} /></div>
            </li>
          ))}
        </ul>
      </div>

      <div className="two">
        <div className="panel">
          <div className="ph"><h2>Money in · {periodSpan(today, period)}</h2></div>
          <div className="tblwrap"><table className="list"><tbody>
            <tr><td>Collected</td><td className="meta">{f.collected.n} payment{f.collected.n === 1 ? "" : "s"}</td>
              <td className="num"><Figure cents={f.collected.cents} filter={{ acct: "bank", type: "invoice", from: f.from, to: f.to }} tone="good" /></td></tr>
            <tr><td>Invoiced, inside terms</td><td className="meta">{f.stages.current.n} invoice{f.stages.current.n === 1 ? "" : "s"}</td>
              <td className="num"><Link className="fig money" href="/money/receivables?stage=current">{formatCents(f.stages.current.cents)}</Link></td></tr>
            <tr><td>Past due</td><td className="meta">{f.stages.pastDue.n} in collections</td>
              <td className="num"><Link className={`fig money${f.stages.pastDue.cents ? " bad" : ""}`} href="/money/receivables?stage=pastdue">{formatCents(f.stages.pastDue.cents)}</Link></td></tr>
            <tr><td>Worked, unbilled</td><td className="meta">{f.stages.unbilled.n} closed job{f.stages.unbilled.n === 1 ? "" : "s"} and draft{f.stages.unbilled.n === 1 ? "" : "s"} · not in the ledger until sent</td>
              <td className="num"><Link className={`fig money${f.stages.unbilled.cents ? " warn" : ""}`} href="/money/receivables?stage=unbilled">{formatCents(f.stages.unbilled.cents)}</Link></td></tr>
          </tbody></table></div>
        </div>
        <div className="panel">
          <div className="ph"><h2>Money out · {periodSpan(today, period)}</h2></div>
          <div className="tblwrap"><table className="list"><tbody>
            <tr><td>Parts bought</td><td className="meta">on received orders</td>
              <td className="num"><Figure cents={f.flow.cost.cost_parts} filter={{ acct: "cost_parts", from: f.from, to: f.to }} /></td></tr>
            <tr><td>Overhead</td><td className="meta">rent, insurance, telecom, software</td>
              <td className="num"><Figure cents={f.flow.cost.overhead} filter={{ acct: "overhead", from: f.from, to: f.to }} /></td></tr>
            {rail.seesPayroll && (
              <tr><td>Payroll</td><td className="meta">{f.sources.payroll ? "this month not yet run" : "run"}</td>
                <td className="num"><Figure cents={f.flow.cost.payroll} filter={{ acct: "payroll", from: f.from, to: f.to }} /></td></tr>
            )}
            <tr><td>Field expenses</td><td className="meta">reimbursed to engineers, and paid on jobs</td>
              <td className="num"><Figure cents={f.flow.cost.cost_field_expenses} filter={{ acct: "cost_field_expenses", from: f.from, to: f.to }} /></td></tr>
            <tr><td>Processing fees</td><td className="meta">Stripe, on pay-link payments</td>
              <td className="num"><Figure cents={f.flow.cost.cost_processing} filter={{ acct: "cost_processing", from: f.from, to: f.to }} /></td></tr>
            <tr><td>On order, not yet a cost</td><td className="meta">orders sent, not received</td>
              <td className="num"><Link className="fig money" href="/money/payables">{formatCents(f.onOrderCents)}</Link></td></tr>
          </tbody></table></div>
        </div>
      </div>
    </FinanceShell>
  );
}
