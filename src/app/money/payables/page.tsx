import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { bills, expenseCategories, expenses, houseMembers } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant } from "@/lib/tenancy";
import { formatCents, formatDollars } from "@/lib/money";
import { booksContext, overheadExpense } from "@/lib/financeData";
import { periodSpan, daysFrom } from "@/lib/finance";
import { billsDueSoon, nextBillCycle } from "@/lib/bills";
import { visibleDirectory } from "@/lib/directory";
import { ACCOUNTS } from "@/lib/ledger/accounts";
import FinanceShell from "@/components/FinanceShell";
import BillsPanel from "@/components/BillsPanel";
import OverheadPanel from "@/components/OverheadPanel";
import DecisionButton from "@/components/money/DecisionButton";
import { RemitTaxButton } from "@/components/money/LedgerTools";
import { Figure, Id, Pill } from "@/components/ui";
import type { Tone } from "@/lib/tones";

export const dynamic = "force-dynamic";

const TONE: Record<string, Tone> = {
  due: "warn", owed: "warn", "to approve": "neutral", "on order": "faint", scheduled: "info", accruing: "info",
};

/**
 * Everything the shop owes, and when: one queue by date. A purchase order
 * and a bill are the same question. Owed now is on the ledger; committed but
 * not yet owed (orders on their way, a month not yet run) is not, and the
 * copy says so. The payroll rows are for a reader who may read the register.
 */
export default async function PayablesPage({ searchParams }: {
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { period, today, mine, seesPayroll, figures: f, rail } = await booksContext(user, (await searchParams).period);

  const rows = f.payables.filter((r) => !r.payroll || seesPayroll);
  const owedNow = rows.filter((r) => r.status === "owed" || r.status === "due" || r.status === "to approve" || r.status === "accruing").reduce((n, r) => n + r.cents, 0);
  const committed = rows.filter((r) => r.status === "on order" || r.status === "scheduled").reduce((n, r) => n + r.cents, 0);
  const paidOut = (["cost_parts", "overhead", "payroll", "cost_field_expenses", "cost_processing"] as const)
    .filter((k) => k !== "payroll" || seesPayroll)
    .map((k) => [k, f.flow.cost[k]] as const);

  const [billRows, categoryRows, members, overheadRows, people] = await Promise.all([
    db.select().from(bills).where(forTenant(bills.tenantOrgId, mine)).orderBy(asc(bills.name)),
    db.select().from(expenseCategories).where(forTenant(expenseCategories.tenantOrgId, mine))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id)),
    db.select({ name: houseMembers.name }).from(houseMembers)
      .where(and(forTenant(houseMembers.orgId, mine), ne(houseMembers.role, "none"))).orderBy(asc(houseMembers.name)),
    db.select().from(expenses).where(and(overheadExpense(), forTenant(expenses.tenantOrgId, mine)))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)).limit(200),
    visibleDirectory(user),
  ]);
  const soon = billsDueSoon(billRows, today);

  return (
    <FinanceShell
      rail={rail} active="payables"
      period={period}
      path="/money/payables"
      title="Payables"
      sub={`Everything the shop owes, and when · ${periodSpan(today, period)}`}
    >
      <div className="panel">
        <div className="position" style={{ borderTop: 0 }}>
          <div>
            <div className="k">Owed now</div>
            <div className="v"><Figure cents={owedNow} filter={{ acct: "payable" }} label={formatCents(owedNow)} /></div>
            <div className="d">vendors, bills due, your people, and the state</div>
          </div>
          <div>
            <div className="k">Committed, not yet owed</div>
            <div className="v">{formatCents(committed)}</div>
            <div className="d">orders on their way and a month not yet run - not in the ledger</div>
          </div>
          <div>
            <div className="k">Paid out · {periodSpan(today, period)}</div>
            <div className="v"><Figure cents={f.flow.cashOutCents} filter={{ acct: "bank", side: "cr", from: f.from, to: f.to }} /></div>
            <div className="d">{paidOut.map(([k, v]) => `${ACCOUNTS[k].name.toLowerCase()} ${formatDollars(v)}`).join(" · ")}</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph"><h2>What goes out, in order</h2><span className="t-meta mut">{rows.length} item{rows.length === 1 ? "" : "s"} · a purchase order and a bill are the same question</span></div>
        <div className="tblwrap">
          <table className="list">
            <thead><tr><th>When</th><th>Payee</th><th>What</th><th className="r">Amount</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="empty">Nothing owed.</td></tr>}
              {rows.map((r) => {
                const d = r.when >= "9999" ? null : daysFrom(today, r.when);
                return (
                  <tr key={`${r.kind}-${r.doc}-${r.when}`} className="row">
                    <td className="num" style={{ textAlign: "left" }}>
                      {d === null ? "—" : r.when}
                      <span className="meta">{d === null ? "no date yet" : d < 0 ? `${-d}d late` : d === 0 ? "today" : `in ${d}d`}</span>
                    </td>
                    <td>{r.payee}<span className="meta">{r.kind}</span></td>
                    <td className="title">
                      {r.href ? <Link className="plain" href={r.href}><Id>{r.doc}</Id></Link> : <Id>{r.doc}</Id>}
                      {" "}<Pill tone={TONE[r.status] ?? "neutral"}>{r.status}</Pill>
                      <span className="meta">{r.title}</span>
                    </td>
                    <td className="num">{formatCents(r.cents)}</td>
                    <td className="acts">
                      {r.action?.kind === "pay-po" && <DecisionButton action={{ kind: "pay-po", id: r.action.id, label: "Pay" }} />}
                      {r.action?.kind === "run-payroll" && <DecisionButton action={{ kind: "run-payroll", ym: r.action.ym, label: "Run" }} />}
                      {r.action?.kind === "remit-tax" && user.role === "owner" && <RemitTaxButton period={r.doc} today={today} />}
                      {r.action?.kind === "link" && <DecisionButton action={{ kind: "link", href: r.action.href, label: r.action.label }} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="note">
          Owed now is on the ledger: a received order posted to payable, a claim on the desk, tax collected on parts. Committed is a promise the ledger has not seen yet.
          {seesPayroll ? <> The register is at <Link href="/money/payroll">Payroll</Link>.</> : null}
        </div>
      </div>

      <BillsPanel
        today={today}
        isOwner={user.role === "owner"}
        categories={categoryRows.map((c) => c.name)}
        roster={members.filter((m) => m.name.trim()).map((m) => ({ name: m.name }))}
        soon={soon.cycles.map((c) => ({ billId: c.bill.id, on: c.on }))}
        rows={billRows.map((r) => ({
          id: r.id, name: r.name, payee: r.payee, kind: r.kind, amountCents: r.amountCents,
          cadence: r.cadence, everyMonths: r.everyMonths, dayOfMonth: r.dayOfMonth,
          everyWeeks: r.everyWeeks, weekday: r.weekday,
          startsOn: r.startsOn, endsOn: r.endsOn, active: r.active, lastOn: r.lastOn,
          nextOn: nextBillCycle(r, today),
          portalUrl: r.portalUrl, accountRef: r.accountRef, person: r.person,
          autopay: r.autopay, note: r.note,
        }))} />

      <OverheadPanel today={today} me={user.name}
        payrollByMonth={{}}
        payrollHref=""
        categories={categoryRows.map((c) => c.name)}
        people={people.map((p) => ({ name: p.name, org: p.org }))}
        rows={overheadRows.map((r) => ({
          id: r.id, kind: r.kind, description: r.description,
          amountCents: r.amountCents, incurredOn: r.incurredOn, person: r.person,
          standing: r.billId !== null,
        }))} />
    </FinanceShell>
  );
}
