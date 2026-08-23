import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { brandForTenant } from "@/lib/brand";
import { formatCents } from "@/lib/money";
import { shopMonthDay, shopToday } from "@/lib/shopday";
import { feeClause } from "@/lib/billingPolicy";
import { asStatementRow, billingContext, invoiceById, qtyOf } from "@/lib/invoiceData";
import { invoiceView } from "@/lib/statement";
import PrintButton from "@/components/PrintButton";
import { PrintHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The invoice as paper.
 *
 * The letterhead is the OPERATOR's, resolved through brandForTenant - a client
 * is buying service from a service company, and the software they never chose
 * has no business signing their bill. The fee clause prints because a late
 * charge is only collectable if the terms rode the paper.
 */
export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) notFound();

  const full = await invoiceById(id);
  if (!full) notFound();
  const { row } = full;

  const [org, wo, brand, ctx] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, row.orgId)).then((r) => r[0] ?? null),
    row.workOrderId === null ? Promise.resolve(null)
      : db.select().from(workOrders).where(eq(workOrders.id, row.workOrderId)).then((r) => r[0] ?? null),
    brandForTenant(row.tenantOrgId),
    billingContext(row.orgId),
  ]);
  const v = invoiceView(asStatementRow(full), shopToday());
  const clause = feeClause(ctx.policy);

  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <PrintButton />
      <PrintHeader
        logoUrl={brand.operatorLogoUrl}
        operator={brand.operatorName || brand.name}
        title={wo ? `Invoice · ${wo.title}` : "Invoice"}
        date={row.issuedOn || shopMonthDay(row.createdAt)}
        docId={row.number}
      />

      <div style={{ display: "flex", gap: 24, marginBottom: 14 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="eyebrow">Bill to</div>
          <div className="t-body" style={{ fontWeight: 700 }}>{org?.name ?? "-"}</div>
          {org?.apEmail && <div className="mut t-small">{org.apEmail}</div>}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="eyebrow">Terms</div>
          <div className="t-body">
            Net {org?.termsDays ?? 30}{row.dueOn ? ` · due ${row.dueOn}` : ""}
          </div>
          <div className="mut t-small">{row.poNumber ? `PO ${row.poNumber}` : "no PO on file"}</div>
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Item", "Qty", "Unit", "Amount"].map((h, i) => (
              <th key={h} className="mut t-meta"
                style={{ textAlign: i === 0 ? "left" : "right", padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {full.lines.map((l) => (
            <tr key={l.id}>
              <td style={{ padding: "6px 8px 6px 0", borderBottom: "1px solid var(--line)" }}>
                <span className="t-body" style={{ fontWeight: 600 }}>{l.description}</span>
                {(l.detail || l.covered) && (
                  <span className="mut t-meta" style={{ display: "block" }}>
                    {l.detail}
                    {l.covered && `${l.detail ? " · " : ""}covered by ${l.coveredBy || "the agreement"}`}
                  </span>
                )}
              </td>
              <td className="t-body" style={{ textAlign: "right", padding: "6px 8px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
                {qtyOf(l) === 1 ? "" : qtyOf(l)}
              </td>
              <td className="t-body" style={{ textAlign: "right", padding: "6px 8px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
                {formatCents(l.unitCents)}
              </td>
              <td className="t-body" style={{ textAlign: "right", padding: "6px 0", borderBottom: "1px solid var(--line)", fontWeight: 600, whiteSpace: "nowrap" }}>
                {l.covered ? formatCents(0) : formatCents(Math.round(qtyOf(l) * l.unitCents))}
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={3} className="t-body" style={{ textAlign: "right", padding: "10px 8px 0", fontWeight: 700 }}>
              {v.paidCents > 0 ? "Balance due" : "Total due"}
            </td>
            <td className="t-page" style={{ textAlign: "right", padding: "10px 0 0", fontWeight: 700, whiteSpace: "nowrap" }}>
              {formatCents(v.balanceCents)}
            </td>
          </tr>
        </tbody>
      </table>

      {row.note && <p className="t-body" style={{ marginTop: 14 }}>{row.note}</p>}
      {clause && <p className="mut t-small" style={{ marginTop: 14 }}>{clause}</p>}
      <p className="mut t-meta" style={{ marginTop: 10 }}>
        {`Service by ${brand.operatorName || brand.name}. `}
        Questions about a line? Reply and we will pause that line while we sort it out; the rest stays due.
      </p>
    </div>
  );
}
