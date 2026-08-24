import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { orgs, shareLinks } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopMonthDay, shopToday } from "@/lib/shopday";
import { asStatementRow, invoiceForOrg, qtyOf } from "@/lib/invoiceData";
import { invoiceView, METHOD_LABEL } from "@/lib/statement";
import { invoiceOrderStatus, invoiceSteps } from "@/lib/clientOrders";
import OrderSteps from "@/components/OrderSteps";
import { Id, PageHead, Panel, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * One order, as its client reads it: the step rail derived from the invoice's
 * own dates, the lines, and the one door that matters right now (pay, when
 * there is something to pay). Access is the org-scoped loader - the id in the
 * URL buys nothing without the org behind the login.
 */
export default async function ClientOrderPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (isStaffRole(user.role) && user.orgId === null) redirect("/money");
  if (user.orgId === null) redirect("/");
  const [org] = await db.select().from(orgs).where(eq(orgs.id, user.orgId));
  if (!org || org.kind !== "client") redirect("/");
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) notFound();

  const full = await invoiceForOrg(id, org.id);
  if (!full) notFound();
  const { row } = full;
  const today = shopToday();
  const v = invoiceView(asStatementRow(full), today);
  const status = invoiceOrderStatus(row, v);
  const placedOn = shopMonthDay(row.createdAt);
  const [link] = await db.select({ token: shareLinks.token }).from(shareLinks)
    .where(and(eq(shareLinks.invoiceId, id), isNull(shareLinks.revokedAt)));

  return (
    <div className="container">
      <div className="crumb"><Link href="/orders">Orders</Link> › <b>{row.number}</b></div>
      <PageHead
        title={<>Order <Id>{row.number}</Id></>}
        sub={`Placed ${placedOn}${row.poNumber ? ` · PO ${row.poNumber}` : ""}`}
        actions={
          <>
            <Pill tone={status.tone}>{status.label}</Pill>
            {status.needsYou && link && (
              <Link className="btn sm primary" href={`/share/${link.token}`} style={{ textDecoration: "none" }}>
                Pay {formatCents(v.balanceCents)}
              </Link>
            )}
            {!status.needsYou && link && (
              <Link className="btn sm" href={`/share/${link.token}`} style={{ textDecoration: "none" }}>Invoice</Link>
            )}
          </>
        }
      />

      <div className="card">
        <OrderSteps steps={invoiceSteps(row, v, placedOn)} />
      </div>

      <Panel title="Items" count={full.lines.length}>
        {full.lines.map((l) => (
          <div key={l.id} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="t-body" style={{ fontWeight: 600 }}>{l.description}</span>
              {l.detail && <span className="mut t-meta" style={{ display: "block" }}>{l.detail}</span>}
            </span>
            {qtyOf(l) !== 1 && <span className="mut t-small">× {qtyOf(l)}</span>}
            <b className="mono t-body" style={{ width: 90, textAlign: "right" }}>
              {l.covered ? formatCents(0) : formatCents(Math.round(qtyOf(l) * l.unitCents))}
            </b>
          </div>
        ))}
        <div className="row-2" style={{ alignItems: "baseline", padding: "9px 0 0", borderTop: "2px solid var(--line)" }}>
          <span className="t-body" style={{ fontWeight: 700, flex: 1 }}>
            Total{row.dueOn && v.balanceCents > 0 ? ` · due ${row.dueOn}` : ""}
          </span>
          <b className="mono t-body">{formatCents(v.linesCents + v.feesCents)}</b>
        </div>
      </Panel>

      {full.payments.length > 0 && (
        <Panel title="Payments" count={full.payments.length}>
          {full.payments.map((p) => (
            <div key={p.id} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <b className="mono t-body" style={{ width: 90 }}>{formatCents(p.amountCents)}</b>
              <span className="pill neutral">{METHOD_LABEL[p.method] ?? p.method}</span>
              <span className="mut t-small">{p.receivedOn}</span>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
