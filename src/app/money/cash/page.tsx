import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { bankConnections, bankTransactions, orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant } from "@/lib/tenancy";
import { formatCents } from "@/lib/money";
import { booksContext } from "@/lib/financeData";
import { plaidConfigured } from "@/lib/bank/sync";
import { entries } from "@/lib/ledger";
import { bankBalance, memoFromDescription, suggestFor, type CashEntry } from "@/lib/ledger/match";
import { forecast } from "@/lib/money/forecast";
import { endOfMonth } from "@/lib/bills";
import FinanceShell from "@/components/FinanceShell";
import { BankConnectButton, BankImportForm, BankLineActions, BankOpeningForm, SyncBankButton, UnmatchButton } from "@/components/money/BankTools";
import { Figure, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Bank against books, and the next eight weeks.
 *
 * Reconciled means every bank line has an entry and every cash entry has a
 * bank line. The difference is not a rounding error to absorb; it is the two
 * lists on this page. The forecast is the only place in the section that
 * projects, and it projects commitments only - no quotes, no unbilled work.
 */
export default async function CashPage({ searchParams }: {
  searchParams: Promise<{ period?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const { period, today, mine, figures: f, rail } = await booksContext(user, (await searchParams).period);
  const isOwner = user.role === "owner";

  const [conn] = await db.select().from(bankConnections).where(eq(bankConnections.tenantOrgId, mine));
  const [feed, cashEntries, orgRows] = await Promise.all([
    db.select().from(bankTransactions).where(forTenant(bankTransactions.tenantOrgId, mine))
      .orderBy(desc(bankTransactions.on), desc(bankTransactions.id)).limit(60),
    entries({ tenant: mine, account: "bank", liveOnly: true }, 1000),
    db.select({ id: orgs.id, termsDays: orgs.termsDays }).from(orgs),
  ]);
  const allFeed = await db.select({ amountCents: bankTransactions.amountCents, matchedEntryId: bankTransactions.matchedEntryId })
    .from(bankTransactions).where(forTenant(bankTransactions.tenantOrgId, mine));
  const matched = new Set(allFeed.map((b) => b.matchedEntryId).filter((x): x is number => x !== null));
  const cash: CashEntry[] = cashEntries.map((e) => ({
    id: e.id, on: e.postedOn, memo: e.memo, refType: e.refType,
    bankCents: e.lines.filter((l) => l.account === "bank").reduce((n, l) => n + l.debitCents - l.creditCents, 0),
    matched: matched.has(e.id),
  }));
  const openInvoices = f.receivables.filter((r) => (r.stage === "current" || r.stage === "pastdue") && r.invoiceId)
    .map((r) => ({ id: r.invoiceId!, number: r.doc, balanceCents: r.cents, orgId: r.orgId }));
  const unmatched = allFeed.filter((b) => b.matchedEntryId === null);
  const inTransit = conn ? cash.filter((e) => !e.matched && e.refType !== "opening") : [];
  const bankSays = conn ? bankBalance(allFeed, conn.openingCents) : null;
  const diff = bankSays === null ? null : f.positions.bank - bankSays;
  const entryById = new Map(cashEntries.map((e) => [e.id, e]));

  const terms = new Map(orgRows.map((o) => [o.id, o.termsDays]));
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const quarterEnd = endOfMonth(`${today.slice(0, 4)}-${String(q * 3 + 3).padStart(2, "0")}-01`);
  const fc = forecast({
    today, cashCents: f.cashCents,
    invoices: f.receivables.filter((r) => r.stage === "current" || r.stage === "pastdue").map((r) => ({ number: r.doc, balanceCents: r.cents, dueOn: r.sort === "z" ? "" : r.sort })),
    installments: f.sources.installments.map((a) => ({ label: a.title, cents: a.cents, dueOn: a.on, termsDays: 30 })),
    bills: f.sources.billsDue.map((b) => ({ payee: b.payee, cents: b.cents, on: b.on })),
    payroll: f.sources.payroll ? [f.sources.payroll] : [],
    posReceived: f.sources.posReceived.map((p) => ({ number: p.number, vendor: p.vendor, cents: p.cents, receivedOn: p.receivedOn })),
    posOnOrder: [],
    reports: f.sources.reports.map((r) => ({ person: r.person, cents: r.cents })),
    tax: f.positions.salesTaxOwed > 0 ? { cents: f.positions.salesTaxOwed, dueOn: quarterEndPlus(quarterEnd) } : null,
  });
  void terms;

  return (
    <FinanceShell
      rail={rail} active="cash"
      period={period}
      path="/money/cash"
      title="Cash"
      sub="Bank against books, and the next eight weeks"
      actions={conn && conn.provider !== "manual" && isOwner ? <SyncBankButton /> : undefined}
    >
      <div className="panel">
        <div className="recon">
          <div><div className="k">Books say</div><div className="v"><Figure cents={f.positions.bank} filter={{ acct: "bank" }} /></div><div className="d">the bank account, from the ledger</div></div>
          <div><div className="k">Bank says</div><div className="v">{bankSays === null ? "—" : formatCents(bankSays)}</div><div className="d">{conn ? `statement balance from the feed${conn.openingOn ? ` since ${conn.openingOn}` : ""}` : "no feed connected"}</div></div>
          <div><div className="k">Difference</div><div className={`v${diff === null ? "" : diff ? " fig warn" : " fig good"}`}>{diff === null ? "—" : formatCents(diff)}</div>
            <div className="d">{unmatched.length} bank line{unmatched.length === 1 ? "" : "s"} unposted · {inTransit.length} entr{inTransit.length === 1 ? "y" : "ies"} not yet at the bank</div></div>
          <div><div className="k">In Stripe</div><div className="v"><Figure cents={f.positions.stripe} filter={{ acct: "stripe" }} /></div><div className="d">{f.positions.stripe > 0 ? "collected by pay link, waiting for a payout" : "nothing waiting"}</div></div>
        </div>
        <div className="note">Reconciled means every bank line has an entry and every cash entry has a bank line. The difference is not a rounding error to absorb; it is the list below.</div>
      </div>

      <div className="panel">
        <div className="ph">
          <h2>Bank feed</h2>
          <span className="t-meta mut">{unmatched.length ? `${unmatched.length} need a home` : conn ? "everything has a home" : "connect a bank, or paste a statement"} · read-only feed, no money moves from here</span>
        </div>
        <div className="tblwrap">
          <table className="list">
            <thead><tr><th>Date</th><th>Bank description</th><th className="r">Amount</th><th>Books</th><th></th></tr></thead>
            <tbody>
              {feed.length === 0 && <tr><td colSpan={5} className="nothing">No bank lines yet.</td></tr>}
              {feed.map((t) => {
                const e = t.matchedEntryId !== null ? entryById.get(t.matchedEntryId) : undefined;
                if (t.matchedEntryId !== null) {
                  return (
                    <tr key={t.id}>
                      <td className="num" style={{ textAlign: "left" }}>{t.on}</td>
                      <td className="docno">{t.description}</td>
                      <td className={`num${t.amountCents > 0 ? " fig good" : ""}`}>{formatCents(t.amountCents)}</td>
                      <td colSpan={2}><Pill tone="good">matched</Pill> <span className="t-meta mut">#{t.matchedEntryId} · {e?.memo ?? ""}</span> {isOwner && <UnmatchButton txnId={t.id} />}</td>
                    </tr>
                  );
                }
                const s = suggestFor({ id: t.id, on: t.on, description: t.description, amountCents: t.amountCents, matchedEntryId: null }, cash, openInvoices);
                const first = s[0];
                return (
                  <tr key={t.id}>
                    <td className="num" style={{ textAlign: "left" }}>{t.on}</td>
                    <td className="docno">{t.description}</td>
                    <td className={`num${t.amountCents > 0 ? " fig good" : ""}`}>{formatCents(t.amountCents)}</td>
                    <td><Pill tone="warn">no entry</Pill>{first?.kind === "invoice" ? <span className="t-meta mut"> equals the balance on {first.number}</span> : first?.kind === "entry" ? <span className="t-meta mut"> looks like #{first.entryId}</span> : null}</td>
                    <td className="acts"><BankLineActions txnId={t.id} suggestions={s} moneyIn={t.amountCents > 0} memo={memoFromDescription(t.description)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {inTransit.length > 0 && (
          <div className="note">
            Not yet at the bank: {inTransit.slice(0, 8).map((e) => `#${e.id} ${e.memo} (${formatCents(Math.abs(e.bankCents))})`).join(" · ")}{inTransit.length > 8 ? ` · and ${inTransit.length - 8} more` : ""}. A check in the mail is still a fact in the books; the bank just has not seen it.
          </div>
        )}
        {isOwner && (
          <div className="pb" style={{ borderTop: "1px solid var(--line)" }}>
            <div className="inline-form" style={{ marginBottom: 12 }}>
              <BankConnectButton configured={plaidConfigured()} />
              {conn && <span className="t-meta mut">{conn.provider === "manual" ? "statements pasted by hand" : `${conn.institution || conn.provider}${conn.lastSyncAt ? ` · last pulled ${conn.lastSyncAt.toISOString().slice(0, 16).replace("T", " ")}` : ""}${conn.lastError ? ` · ${conn.lastError}` : ""}`}</span>}
            </div>
            <BankOpeningForm today={today} openingCents={conn?.openingCents ?? 0} openingOn={conn?.openingOn ?? ""} />
            <div style={{ marginTop: 12 }}><BankImportForm /></div>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="ph"><h2>Next eight weeks</h2><span className="t-meta mut">from what is committed: invoices by due date, bills, payroll, orders, claims, tax · quotes and unbilled work deliberately excluded</span></div>
        <div className="tblwrap">
          <table className="list fc">
            <thead><tr><th>Week</th><th className="r">In</th><th className="r">Out</th><th className="r">Ending cash</th></tr></thead>
            <tbody>
              {fc.weeks.map((w, i) => (
                <tr key={w.from} className={w.endingCents < 0 ? "neg" : i === fc.lowWeek && fc.lowCents < f.cashCents ? "low" : ""}>
                  <td className="wk">{w.from} – {w.to}{i === 0 ? <span className="why">this week</span> : null}</td>
                  <td className="num in">{w.inCents ? `+${formatCents(w.inCents)}` : ""}{w.ins.map((c, j) => <span key={j} className="why">{c.label}</span>)}</td>
                  <td className="num out">{w.outCents ? `−${formatCents(w.outCents)}` : ""}{w.outs.map((c, j) => <span key={j} className="why">{c.label}</span>)}</td>
                  <td className="num"><b>{formatCents(w.endingCents)}</b>{i === fc.lowWeek && fc.lowCents < f.cashCents ? <span className="why">low point</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note">
          Low point {formatCents(fc.lowCents)} in the week of {fc.weeks[fc.lowWeek]?.from}. If that number is too close, the levers are all on this page&apos;s neighbours: <Link href="/money/receivables?stage=pastdue">chase what is past due</Link>, <Link href="/money/receivables?stage=unbilled">draft what is unbilled</Link>, hold an order.
        </div>
      </div>

      <div className="panel ghost">
        <div className="pb">
          <b>Not until Craton.</b> Everything above works with a read-only bank feed and Stripe Connect: the bank is someone else&apos;s, the books are ours, and reconciling is how the two agree. What needs Stripe Treasury is the other half - an operating account that <em>is</em> the ledger (no reconciliation, because there is no second book), cards for engineers and jobs, funded pockets for allowances, and escrow for broker deals. Those are drawn here as the line, not as rooms.
        </div>
      </div>
    </FinanceShell>
  );
}

/** Sales tax is due a month after the quarter ends. */
function quarterEndPlus(quarterEnd: string): string {
  const t = Date.parse(`${quarterEnd}T00:00:00Z`);
  return new Date(t + 30 * 86400000).toISOString().slice(0, 10);
}
