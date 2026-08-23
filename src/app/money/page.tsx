import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs, payments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { allInvoices, asStatementRow, unbilledJobs } from "@/lib/invoiceData";
import {
  aging, AGING_BUCKETS, BUCKET_LABEL, BUCKET_TONE, invoiceView, isOpen, loopBar,
  STANDING_LABEL, STANDING_TONE,
} from "@/lib/statement";
import MoneyTabs from "@/components/MoneyTabs";
import DraftInvoiceButton from "@/components/DraftInvoiceButton";
import { EmptyState, Id, PageHead, Panel, Pill, type Tone } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Whose move is it, in money.
 *
 * Every figure on this page is a sum over rows taken at render: the loop bar,
 * the aging bands, what a closed job would invoice for. Nothing is read from a
 * column, so there is no state for this page to be out of date with.
 */
export default async function MoneyPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");

  const today = shopToday();
  const [full, unbilled, orgRows, payRows] = await Promise.all([
    allInvoices(),
    unbilledJobs(),
    db.select({ id: orgs.id, name: orgs.name }).from(orgs),
    db.select().from(payments).orderBy(desc(payments.receivedOn)).limit(200),
  ]);
  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const views = full.map((f) => invoiceView(asStatementRow(f), today));
  const byId = new Map(full.map((f) => [f.row.id, f.row]));

  // "This month" is the calendar month, because that is the window an operator
  // reconciles against a bank statement.
  const monthStart = `${today.slice(0, 7)}-01`;
  const bar = loopBar({
    quoted: [], approved: [],
    unbilled: unbilled.map((j) => j.valueCents),
    views,
    paid: payRows.filter((p) => p.receivedOn >= monthStart).map((p) => p.amountCents),
  });
  const bands = aging(views);
  const open = views.filter(isOpen);
  const waiting = open
    .sort((a, b) => b.daysLate - a.daysLate)
    .slice(0, 8);

  const overdue = open.filter((v) => v.daysLate > 0);
  const tiles: { label: string; cents: number; note: string; tone?: Tone }[] = [
    { label: "Quoted", cents: bar.quotedCents, note: "quotes land in a later stage" },
    { label: "Worked, unbilled", cents: bar.unbilledCents, tone: "warn", note: `${unbilled.length} closed job${unbilled.length === 1 ? "" : "s"} - the leak` },
    { label: "Invoiced, current", cents: bar.currentCents, tone: "info", note: "inside terms" },
    { label: "Past due", cents: bar.pastDueCents, tone: overdue.length ? "bad" : undefined, note: `${overdue.length} in collections` },
    { label: "Paid this month", cents: bar.paidCents, tone: "good", note: "ACH, card, check" },
  ];

  return (
    <div className="container wide">
      <PageHead
        title="Billing"
        sub="Whose move is it, in money. Every number here is summed from the work and the payments when you load the page - nothing is stored."
      />
      <MoneyTabs active="overview" counts={{
        invoices: full.filter((f) => f.row.status !== "void").length,
        collections: open.filter((v) => v.daysLate > 0).length,
      }} />

      {/* The loop bar: where money is sitting, in the order it moves. */}
      <div className="metric-grid" style={{ margin: "12px 0" }}>
        {tiles.map((t) => (
          <div key={t.label} className="card" style={{ padding: "12px 14px", marginBottom: 0 }}>
            <div className="mut t-small">{t.label}</div>
            <div className="t-page" style={{ fontWeight: 700, color: t.tone ? `var(--t-${t.tone}-fg)` : "var(--navy)" }}>
              {formatCents(t.cents)}
            </div>
            <div className="mut t-meta">{t.note}</div>
          </div>
        ))}
      </div>

      <Panel
        title="Needs an invoice"
        count={unbilled.length}
        hint="Closed work with nothing billed against it. A covered job still gets an invoice - at $0, naming the agreement - because the visit belongs on the record."
        empty="Everything closed has been billed."
      >
        {unbilled.length > 0 && unbilled.map((j) => (
          <div key={j.woId} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
            <Link href={`/work/${j.woId}`} className="t-body" style={{ textDecoration: "none", fontWeight: 600 }}>
              <Id>{j.number}</Id> {j.title}
            </Link>
            <span className="mut t-meta">
              {j.orgName}
              {j.closedOn ? ` · closed ${j.daysClosed}d ago` : ""}
              {j.coveredBy ? ` · ${j.allCovered ? "covered by" : "partly covered by"} ${j.coveredBy}` : ""}
            </span>
            <span className="sp" />
            <b className="t-body">{formatCents(j.valueCents)}</b>
            <DraftInvoiceButton workOrderId={j.woId} number={j.number} />
          </div>
        ))}
      </Panel>

      <Panel
        title="Waiting on clients"
        count={waiting.length}
        hint="Sent and not yet settled, oldest first."
        empty="Nothing is outstanding."
      >
        {waiting.length > 0 && waiting.map((v) => {
          const row = byId.get(v.id);
          return (
            <div key={v.id} className="row-2" style={{ alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
              <Link href={`/money/invoices/${v.id}`} className="t-body" style={{ textDecoration: "none", fontWeight: 600 }}>
                <Id>{v.number}</Id>
              </Link>
              <span className="mut t-meta">
                {orgName.get(row?.orgId ?? -1) ?? ""}
                {v.daysLate > 0 ? ` · ${v.daysLate}d overdue` : row?.dueOn ? ` · due ${row.dueOn}` : ""}
              </span>
              <span className="sp" />
              <Pill tone={STANDING_TONE[v.standing]}>{STANDING_LABEL[v.standing]}</Pill>
              <b className="t-body">{formatCents(v.balanceCents)}</b>
            </div>
          );
        })}
      </Panel>

      <Panel title="Aging" hint={`${formatCents(bands.total)} open across ${open.length} invoice${open.length === 1 ? "" : "s"}.`}>
        {bands.total === 0
          ? <EmptyState title="Nothing is aging." />
          : (
            <div className="metric-grid">
              {AGING_BUCKETS.map((b) => (
                <div key={b} className="row-2" style={{ alignItems: "baseline" }}>
                  <Pill tone={BUCKET_TONE[b]}>{BUCKET_LABEL[b]}</Pill>
                  <b className="t-body">{formatCents(bands.buckets[b])}</b>
                </div>
              ))}
            </div>
          )}
      </Panel>
    </div>
  );
}
