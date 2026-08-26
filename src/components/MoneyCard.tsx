import Link from "next/link";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { allInvoices, asStatementRow, unbilledJobs } from "@/lib/invoiceData";
import { invoiceView, isOpen } from "@/lib/statement";

/**
 * Money, whose move.
 *
 * Three lines on the page everybody lands on, each naming whose move it is:
 * work we have not billed is ours, an invoice inside terms is theirs, an
 * overdue one is ours again. Staff only, and computed - there is no cached
 * figure here to go stale overnight.
 */
export default async function MoneyCard({ tenantOrgId }: { tenantOrgId: number | null }) {
  const today = shopToday();
  const [full, unbilled] = await Promise.all([allInvoices(tenantOrgId), unbilledJobs(tenantOrgId, 12)]);
  const views = full.map((f) => invoiceView(asStatementRow(f), today)).filter(isOpen);

  const unbilledCents = unbilled.reduce((n, j) => n + j.valueCents, 0);
  const overdue = views.filter((v) => v.daysLate > 0);
  const current = views.filter((v) => v.daysLate <= 0);
  const sum = (xs: typeof views) => xs.reduce((n, v) => n + v.balanceCents, 0);

  if (!unbilled.length && !views.length) return null;

  const lines: { move: string; tone: string; text: string; href: string }[] = [
    ...(unbilled.length ? [{
      move: "Ours", tone: "warn", href: "/money",
      text: `${unbilled.length} closed job${unbilled.length === 1 ? "" : "s"} unbilled, ${formatCents(unbilledCents)}`,
    }] : []),
    ...(overdue.length ? [{
      move: "Ours", tone: "bad", href: "/money/invoices?standing=overdue",
      text: `${overdue.length} invoice${overdue.length === 1 ? "" : "s"} past due, ${formatCents(sum(overdue))}`
        + ` - oldest ${Math.max(...overdue.map((v) => v.daysLate))}d`,
    }] : []),
    ...(current.length ? [{
      move: "Theirs", tone: "info", href: "/money/invoices",
      text: `${formatCents(sum(current))} out and inside terms`,
    }] : []),
  ];

  return (
    <div className="container" style={{ paddingBottom: 0 }}>
      <div className="card">
        <div className="row-2" style={{ alignItems: "baseline", marginBottom: 4 }}>
          <span className="card-title">Money, whose move</span>
          <span className="sp" />
          <Link href="/money" className="btn link t-meta">Billing →</Link>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: i ? "1px solid var(--line)" : undefined }}>
            <span className={`pill ${l.tone}`}>{l.move}</span>
            <Link href={l.href} className="t-body" style={{ textDecoration: "none", flex: 1, minWidth: 0 }}>{l.text}</Link>
          </div>
        ))}
      </div>
    </div>
  );
}
