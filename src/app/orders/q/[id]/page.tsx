import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { maySeeOrgMoney } from "@/lib/tenancy";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopMonthDay, shopToday } from "@/lib/shopday";
import { qtyOf, quoteForOrg, quoteSubtotal, quoteTotal } from "@/lib/invoiceData";
import { descriptionLines } from "@/lib/billing";
import { discountLabel, discountOf, greetingLine, quoteStanding, specRows } from "@/lib/quotes";
import { quoteOrderStatus, quoteSteps } from "@/lib/clientOrders";
import OrderSteps from "@/components/OrderSteps";
import ClientApprove from "@/components/ClientApprove";
import { Id, PageHead, Panel, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

/** A special order at the quoted-first stage, as its client reads it. */
export default async function ClientQuotePage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (isStaffRole(user.role) && user.orgId === null) redirect("/money");
  if (user.orgId === null) redirect("/");
  const [org] = await db.select().from(orgs).where(eq(orgs.id, user.orgId));
  if (!org || org.kind !== "client") redirect("/");
  /* What their organization has been quoted and billed is their organization's
     money, not everybody's who can sign in to it. See maySeeOrgMoney. */
  if (!(await maySeeOrgMoney(user, org.id))) redirect("/");
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) notFound();

  const full = await quoteForOrg(id, org.id);
  if (!full) notFound();
  const { row } = full;
  const today = shopToday();
  const standing = quoteStanding(row, today);
  const status = quoteOrderStatus(row, standing);
  const placedOn = shopMonthDay(row.createdAt);
  const subtotal = quoteSubtotal(full);
  const off = discountOf(subtotal, row);
  const total = quoteTotal(full);

  return (
    <div className="container">
      <div className="crumb"><Link href="/orders">Orders</Link> › <b>{row.number}</b></div>
      <PageHead
        title={<>Quote <Id>{row.number}</Id></>}
        sub={`Placed ${placedOn}${row.expiresOn && standing === "awaiting" ? ` · good to ${row.expiresOn}` : ""}`}
        actions={
          <>
            <Pill tone={status.tone}>{status.label}</Pill>
            {/* Answered here, in session. This used to be a link out to the
                PUBLIC share page - and it only appeared at all if somebody had
                minted a share link that nobody had since revoked, so a client
                could be looking at a quote with no way to answer it. */}
            {status.needsYou && (
              <ClientApprove
                quoteId={row.id}
                number={row.number}
                total={formatCents(total)}
                canApprove={user.role === "client_editor"}
                suggestedName={user.name || ""}
              />
            )}
          </>
        }
      />

      <div className="card">
        <OrderSteps steps={quoteSteps(row, standing, placedOn)} />
        {row.status === "draft" && (
          <div className="mut t-small" style={{ marginTop: 8 }}>
            We are confirming price and lead time. You approve before anything moves - nothing is charged.
          </div>
        )}
      </div>

      {(row.attn || row.specsLeft.trim() || row.specsRight.trim()) && (
        <div className="card">
          {row.attn && (
            <div className="t-body" style={{ fontWeight: 600 }}>{greetingLine(row)}</div>
          )}
          {/* What the offer covers, before a single price. */}
          <div className="pf2" style={{ marginTop: row.attn ? 8 : 0 }}>
            {[specRows(row.specsLeft), specRows(row.specsRight)].map((col, i) => (
              <div key={i} className="t-body">
                {col.map((r, j) => (
                  <div key={j} style={{ fontWeight: r.sub ? 400 : 700, paddingLeft: r.sub ? 12 : 0 }}>
                    {r.sub ? `- ${r.text}` : r.text}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <Panel title="Items" count={full.lines.length}>
        {full.lines.map((l) => (
          <div key={l.id} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              {/* The number they would raise a PO against. */}
              {l.partNumber && (
                <span className="mono t-small" style={{ fontWeight: 700, color: "var(--navy)", marginRight: 8 }}>
                  {l.partNumber}
                </span>
              )}
              <span className="t-body" style={{ fontWeight: 600 }}>{descriptionLines(l.description).head}</span>
              {descriptionLines(l.description).rest.map((r, i) => (
                <span key={i} className="mut t-meta"
                  style={{ display: "block", paddingLeft: 12, fontStyle: "italic" }}>{r}</span>
              ))}
              {l.detail && <span className="mut t-meta" style={{ display: "block" }}>{l.detail}</span>}
            </span>
            {qtyOf(l) !== 1 && <span className="mut t-small">× {qtyOf(l)}</span>}
            {/* A covered line says so. It used to price at LIST here while
                quoteTotal zeroed it below, so the items did not add up to the
                total on the client's own page - and the client had no way to
                tell which lines their agreement was paying for. */}
            <b className="mono t-body" style={{ width: 90, textAlign: "right" }}>
              {l.covered
                ? <span className="t-small" style={{ color: "var(--t-good-fg)" }}>covered</span>
                : l.unitCents > 0 ? formatCents(Math.round(qtyOf(l) * l.unitCents)) : "quote"}
            </b>
          </div>
        ))}
        {off > 0 && (
          <>
            <div className="row-2" style={{ alignItems: "baseline", padding: "9px 0 0", borderTop: "2px solid var(--line)" }}>
              <span className="mut t-body" style={{ flex: 1 }}>Subtotal</span>
              <span className="mut t-body">{formatCents(subtotal)}</span>
            </div>
            <div className="row-2" style={{ alignItems: "baseline", padding: "3px 0 0" }}>
              <span className="t-body" style={{ flex: 1, color: "var(--t-good-fg)" }}>{discountLabel(row)}</span>
              <b className="mono t-body" style={{ color: "var(--t-good-fg)" }}>-{formatCents(off)}</b>
            </div>
          </>
        )}
        {total > 0 && (
          <div className="row-2" style={{
            alignItems: "baseline", padding: "9px 0 0",
            borderTop: off > 0 ? "1px solid var(--line)" : "2px solid var(--line)",
          }}>
            <span className="t-body" style={{ fontWeight: 700, flex: 1 }}>Total</span>
            <b className="mono t-body">{formatCents(total)}</b>
          </div>
        )}
      </Panel>

      {row.note.trim() && (
        <Panel title="Comments or special instructions">
          <div className="t-body" style={{ whiteSpace: "pre-wrap" }}>{row.note}</div>
        </Panel>
      )}
    </div>
  );
}
