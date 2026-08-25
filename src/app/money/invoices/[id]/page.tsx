import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, orgs, shareLinks, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { formatCents } from "@/lib/money";
import { shopToday, shopMonthDay } from "@/lib/shopday";
import { jobCost, poCheck } from "@/lib/billing";
import { feeFor } from "@/lib/dunning";
import { asStatementRow, billingContext, draftSourceFor, invoiceById, qtyOf } from "@/lib/invoiceData";
import { invoiceView, METHOD_LABEL, STANDING_LABEL, STANDING_TONE } from "@/lib/statement";
import InvoiceActions from "@/components/InvoiceActions";
import InvoiceLineList from "@/components/InvoiceLineList";
import InvoiceCollections from "@/components/InvoiceCollections";
import { Id, Panel, Pill, RecordHero } from "@/components/ui";
import type { HeroStat } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * One bill, and everything that has happened to it.
 *
 * The three numbers in the hero - total, paid, open - are summed here from the
 * lines and the payment rows. There is no column holding any of them, which is
 * why this page and the client's portal cannot disagree.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) notFound();

  const full = await invoiceById(id);
  if (!full) notFound();
  const { row } = full;

  const [org, wo, links, history] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, row.orgId)).then((r) => r[0] ?? null),
    row.workOrderId === null ? Promise.resolve(null)
      : db.select().from(workOrders).where(eq(workOrders.id, row.workOrderId)).then((r) => r[0] ?? null),
    db.select().from(shareLinks).where(eq(shareLinks.invoiceId, id)),
    db.select().from(auditLog)
      .where(and(eq(auditLog.entityType, "invoice"), eq(auditLog.entityId, String(id))))
      .orderBy(desc(auditLog.createdAt)).limit(50),
  ]);

  const today = shopToday();
  const v = invoiceView(asStatementRow(full), today);
  const total = v.linesCents + v.feesCents;
  const warning = org ? poCheck(org, total) : "";
  const link = links.find((l) => l.revokedAt === null) ?? null;

  // Margin, while the bill is still in front of somebody. Only on a draft:
  // afterwards it belongs in job costing, not on the client-facing record.
  // Loaded labor at zero means nobody has told us what an hour costs, and the
  // panel says so rather than reporting a flattering 100%.
  const src = row.status === "draft" && row.workOrderId !== null ? await draftSourceFor(row.workOrderId) : null;
  const cost = src && src.context.loadedLaborCents > 0
    ? jobCost({
        lines: src.lines, partsCostCents: src.partsCostCents,
        billedMinutes: src.billedMinutes, loadedLaborCents: src.context.loadedLaborCents,
        expensesCents: src.expensesCents,
      })
    : null;

  // What may be charged today, and the sentence saying why not when nothing
  // may. Computed the same way postFee computes it, so the button and the
  // action cannot disagree about whether there is a fee to post.
  const { policy } = await billingContext(row.orgId);
  const quote = feeFor({
    policy, dueOn: row.dueOn, today,
    payableCents: v.payableCents,
    partsCents: full.lines.filter((l) => l.kind === "part" && !l.covered)
      .reduce((n, l) => n + Math.round(qtyOf(l) * l.unitCents), 0),
    postedOn: full.fees.filter((f) => !f.waived).map((f) => f.postedOn),
  });

  const stats: HeroStat[] = [
    { label: "total", value: formatCents(total) },
    ...(v.paidCents > 0 ? [{ label: "paid", value: formatCents(v.paidCents), tone: "good" as const }] : []),
    ...(v.balanceCents > 0 ? [{ label: "open", value: formatCents(v.balanceCents), tone: v.daysLate > 0 ? "bad" as const : undefined }] : []),
    ...(v.daysLate > 0 ? [{ label: "days late", value: v.daysLate, tone: "bad" as const }] : []),
    ...(v.disputedCents > 0 ? [{ label: "paused by a dispute", value: formatCents(v.disputedCents), tone: "warn" as const }] : []),
    ...(link?.openCount ? [{ label: `viewed${link.openCount > 1 ? ` ${link.openCount}x` : ""}`, value: link.openedAt ? shopMonthDay(link.openedAt) : "yes" }] : []),
  ];

  return (
    <div className="container">
      <div className="crumb">
        <Link href="/money">Financial</Link> › <Link href="/money/invoices">Invoices</Link> › <b>{row.number}</b>
      </div>
      <RecordHero
        eyebrow={<>Invoice · {org?.name ?? "client gone"}</>}
        id={row.number}
        title={wo ? wo.title : row.note || "Invoice"}
        meta={
          <>
            {wo && <><Link href={`/work/${wo.id}`}><Id>{wo.number}</Id></Link> · </>}
            {row.issuedOn ? `issued ${row.issuedOn}` : "not issued yet"}
            {row.dueOn ? ` · due ${row.dueOn}` : ""}
            {row.poNumber ? <> · PO <Id>{row.poNumber}</Id></> : " · no PO on file"}
          </>
        }
        stats={stats}
        actions={
          <InvoiceActions
            id={id} number={row.number} status={row.status}
            balanceCents={v.balanceCents} today={today} poWarning={warning}
            canDelete={user.role === "owner"}
          />
        }
      />

      <div className="row-2" style={{ marginBottom: 10 }}>
        <Pill tone={STANDING_TONE[v.standing]}>{STANDING_LABEL[v.standing]}</Pill>
        <Link className="btn sm" href={`/money/invoices/${id}/print`} style={{ textDecoration: "none" }}>
          Preview PDF
        </Link>
        {/* The shop's own Excel layout, filled - templates/InvoiceTemplate.xlsx. */}
        <a className="btn sm" href={`/api/export/invoice/${id}`} download>
          Excel
        </a>
        {link && (
          <Link className="btn sm" href={`/share/${link.token}`} style={{ textDecoration: "none" }}>
            Open as the client
          </Link>
        )}
      </div>

      {warning && row.status === "draft" && (
        <div className="card" style={{ borderLeft: "3px solid var(--t-warn-fg)" }}>
          <div className="t-body">{warning}</div>
        </div>
      )}

      <InvoiceLineList
        editable={row.status === "draft"}
        target={{ kind: "invoice", id }}
        lines={full.lines.map((l) => ({
          id: l.id, kind: l.kind, description: l.description, detail: l.detail,
          qty: qtyOf(l), unitCents: l.unitCents, covered: l.covered, coveredBy: l.coveredBy,
        }))}
        totalCents={v.linesCents}
      />

      {src && (
        <Panel
          title="Job cost"
          hint={cost
            ? `Loaded labor ${formatCents(src.context.loadedLaborCents)}/h`
            : "Set the loaded labor rate in Billing settings to see margin."}
        >
          {cost && (
            <>
              {[
                { label: "Billed", value: formatCents(cost.billedCents) },
                { label: "Parts cost", value: formatCents(src.partsCostCents) },
                { label: "Labor, loaded", value: formatCents(Math.round((src.context.loadedLaborCents * src.billedMinutes) / 60)) },
                { label: "Expenses", value: formatCents(src.expensesCents) },
              ].map((r) => (
                <div key={r.label} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
                  <span className="mut t-small" style={{ flex: 1, minWidth: 0 }}>{r.label}</span>
                  <span className="t-body">{r.value}</span>
                </div>
              ))}
              <div className="row-2" style={{ alignItems: "baseline", padding: "7px 0 0", borderTop: "2px solid var(--line)" }}>
                <span className="t-body" style={{ fontWeight: 700, flex: 1, minWidth: 0 }}>Margin</span>
                <b className="t-body" style={{ color: cost.marginCents >= 0 ? "var(--t-good-fg)" : "var(--t-bad-fg)" }}>
                  {formatCents(cost.marginCents)} · {cost.marginPct}%
                </b>
              </div>
            </>
          )}
        </Panel>
      )}

      <Panel title="Payments" count={full.payments.length} empty="Nothing has arrived yet.">
        {full.payments.length > 0 && full.payments.map((p) => (
          <div key={p.id} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <b className="t-body" style={{ width: 90 }}>{formatCents(p.amountCents)}</b>
            <span className="pill neutral">{METHOD_LABEL[p.method] ?? p.method}</span>
            <span className="mut t-small">{p.receivedOn}</span>
            {p.reference && <span className="mut t-small">{p.reference}</span>}
          </div>
        ))}
      </Panel>

      {row.status !== "draft" && row.status !== "void" && (
        <InvoiceCollections
          invoiceId={id}
          number={row.number}
          today={today}
          feeQuote={{ amountCents: quote.amountCents, basis: quote.basis, blocked: quote.blocked }}
          fees={full.fees.map((f) => ({
            id: f.id, amountCents: f.amountCents, basis: f.basis,
            postedOn: f.postedOn, waived: f.waived, waivedReason: f.waivedReason,
          }))}
          promises={full.promises.map((p) => ({
            id: p.id, promisedOn: p.promisedOn, byName: p.byName, note: p.note, keptOn: p.keptOn,
          }))}
          disputes={full.disputes.map((d) => ({
            id: d.id, lineId: d.lineId, reason: d.reason, openedOn: d.openedOn,
            resolvedOn: d.resolvedOn, resolution: d.resolution,
            lineLabel: full.lines.find((l) => l.id === d.lineId)?.description ?? "",
          }))}
          lines={full.lines.filter((l) => !l.covered && l.kind !== "tax")
            .map((l) => ({ id: l.id, label: l.description }))}
        />
      )}

      <Panel title="History" count={history.length} empty="Nothing yet.">
        {history.length > 0 && history.map((a) => (
          <div key={a.id} className="row-2" style={{ alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
            <span className="mut t-small" style={{ width: 96 }}>{shopMonthDay(a.createdAt)}</span>
            <span className="t-body" style={{ flex: 1, minWidth: 0 }}>{a.action}</span>
            <span className="mut t-meta">{a.actor}</span>
          </div>
        ))}
      </Panel>
    </div>
  );
}
