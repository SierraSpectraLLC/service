import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, orgs, shareLinks, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { viewTenant } from "@/lib/tenancy";
import { modelOptions } from "@/lib/pmKitData";
import { awardOfQuote, quoteHasPeriods } from "@/lib/awardData";
import { formatCents } from "@/lib/money";
import { shopMonthDay, shopToday } from "@/lib/shopday";
import { billingContext, quoteById, quoteSubtotal, quoteTotal } from "@/lib/invoiceData";
import { feeClause } from "@/lib/billingPolicy";
import {
  daysToExpiry, depositCents, discountLabel, discountOf, quoteStanding,
  STANDING_LABEL, STANDING_TONE,
} from "@/lib/quotes";
import QuoteActions from "@/components/QuoteActions";
import QuoteLetterCard from "@/components/QuoteLetterCard";
import CoverageEstimateBuilder from "@/components/CoverageEstimateBuilder";
import AwardQuoteButton from "@/components/AwardQuoteButton";
import InvoiceLineList from "@/components/InvoiceLineList";
import { Id, Panel, Pill, RecordHero } from "@/components/ui";
import type { HeroStat } from "@/components/ui";

export const dynamic = "force-dynamic";

/** One price, what it is made of, and what happened after it went out. */
export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) notFound();

  const full = await quoteById(id);
  if (!full) notFound();
  const { row } = full;
  const today = shopToday();

  const [org, wo, link, history, ctx, models, award, coveragePeriods] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, row.orgId)).then((r) => r[0] ?? null),
    row.workOrderId === null ? Promise.resolve(null)
      : db.select().from(workOrders).where(eq(workOrders.id, row.workOrderId)).then((r) => r[0] ?? null),
    db.select().from(shareLinks)
      .where(and(eq(shareLinks.quoteId, id), isNull(shareLinks.revokedAt))).then((r) => r[0] ?? null),
    db.select().from(auditLog)
      .where(and(eq(auditLog.entityType, "quote"), eq(auditLog.entityId, String(id))))
      .orderBy(desc(auditLog.createdAt)).limit(50),
    billingContext(row.orgId),
    // Only a draft can take lines, so only a draft pays for the catalog read.
    row.status === "draft" ? viewTenant(user).then(modelOptions) : Promise.resolve([]),
    awardOfQuote(id),
    quoteHasPeriods(id),
  ]);

  const standing = quoteStanding(row, today);
  const subtotal = quoteSubtotal(full);
  const total = quoteTotal(full);
  const off = discountOf(subtotal, row);
  const deposit = depositCents(total, row.depositPct);
  const left = daysToExpiry(row.expiresOn, today);
  const clause = feeClause(ctx.policy);

  const stats: HeroStat[] = [
    { label: "total", value: formatCents(total) },
    ...(off > 0 ? [{ label: `${discountLabel(row).toLowerCase()} off ${formatCents(subtotal)}`, value: `-${formatCents(off)}`, tone: "good" as const }] : []),
    ...(deposit > 0 ? [{ label: `deposit on approval (${row.depositPct}%)`, value: formatCents(deposit) }] : []),
    ...(standing === "awaiting" && left !== null
      ? [{ label: left >= 0 ? "days left" : "days past expiry", value: Math.abs(left), tone: left <= 7 ? "warn" as const : undefined }]
      : []),
    ...(link?.openCount ? [{ label: `viewed${link.openCount > 1 ? ` ${link.openCount}x` : ""}`, value: link.openedAt ? shopMonthDay(link.openedAt) : "yes" }] : []),
  ];

  return (
    <div className="container">
      <div className="crumb">
        <Link href="/money">Financial</Link> › <Link href="/money/quotes">Quotes</Link> › <b>{row.number}</b>
      </div>
      <RecordHero
        eyebrow={<>Quote · {org?.name ?? "client gone"}</>}
        id={row.number}
        title={row.title || wo?.title || "Quote"}
        meta={
          <>
            {wo && <><Link href={`/work/${wo.id}`}><Id>{wo.number}</Id></Link> · </>}
            {row.attn ? `attn ${row.attn} · ` : ""}
            {row.sentOn ? `sent ${row.sentOn}` : "not sent yet"}
            {row.expiresOn ? ` · expires ${row.expiresOn}` : ""}
            {row.answeredOn ? ` · ${standing} ${row.answeredOn} by ${row.answeredBy}` : ""}
          </>
        }
        stats={stats}
        actions={<QuoteActions id={id} number={row.number} status={row.status} canDelete={user.role === "owner"} />}
      />

      <div className="row-2" style={{ marginBottom: 10 }}>
        <Pill tone={STANDING_TONE[standing]}>{STANDING_LABEL[standing]}</Pill>
        {/* The shop's own Excel layout, filled - templates/QuoteTemplate.xlsx. */}
        <a className="btn sm" href={`/api/export/quote/${id}`} download>
          Excel
        </a>
        {link && (
          <Link className="btn sm" href={`/share/${link.token}`} style={{ textDecoration: "none" }}>
            Open as the client
          </Link>
        )}
        {/* Only once it has gone out, and only once. A draft has not been
            anywhere, and a quote already awarded links to what it became. */}
        {row.status !== "draft" && coveragePeriods > 0 && !award && (
          <AwardQuoteButton quoteId={id} periods={coveragePeriods} today={today}
            defaultNumber="" />
        )}
        {award && (
          <Link className="btn sm" href="/money/contracts" style={{ textDecoration: "none" }}>
            Awarded{award.number ? ` as ${award.number}` : ""}
          </Link>
        )}
        {row.depositInvoiceId && (
          <Link className="btn sm" href={`/money/invoices/${row.depositInvoiceId}`} style={{ textDecoration: "none" }}>
            The deposit invoice
          </Link>
        )}
      </div>

      {/* Everything on the quote that is not a line item: who it is addressed
          to, the sentence at the top, what came off the price, and the shop's
          own notes at the bottom. See lib/quotes. */}
      <QuoteLetterCard
        quoteId={id}
        editable={row.status === "draft"}
        subtotalCents={subtotal}
        orgName={org?.name ?? ""}
        billingAddress={org?.billingAddress ?? ""}
        letter={{
          attn: row.attn, greeting: row.greeting, clientAddress: row.clientAddress,
          note: row.note, discountPct: row.discountPct, discountCents: row.discountCents,
          discountLabel: row.discountLabel,
        }}
      />

      <InvoiceLineList
        editable={row.status === "draft"}
        target={{ kind: "quote", id }}
        /* So a part picked out of the book arrives priced the way the invoice
           after it will price the same part: cost plus the shop's markup, one
           formula (lib/billing.sellPrice), read off this client's policy. */
        partsMarkupBps={ctx.policy.partsMarkupBps}
        {...(off > 0 ? { discount: { label: discountLabel(row), cents: off } } : {})}
        lines={full.lines.map((l) => ({
          id: l.id, kind: l.kind, description: l.description, detail: l.detail,
          partNumber: l.partNumber, unit: l.unit,
          qty: l.qty / 1000, unitCents: l.unitCents, covered: l.covered, coveredBy: l.coveredBy,
        }))}
        totalCents={total}
      />

      {row.status === "draft" && (
        /* Priced off a plan rather than off history - lib/coveragePrice. Draft
           only, for the same reason the line editor is: a quote that has gone
           out reads as sent, and repricing it behind the client is not an edit
           anybody should be able to make quietly. */
        <CoverageEstimateBuilder quoteId={id} models={models} defaultStart={today} />
      )}

      {row.answerNote && (
        <Panel title={standing === "declined" ? "Why they said no" : "What they said"}>
          <div className="t-body">{row.answerNote}</div>
          <div className="mut t-meta" style={{ marginTop: 4 }}>
            {row.answeredBy}{row.answeredOn ? ` · ${row.answeredOn}` : ""}
            {wo ? " · also posted to the job, where the engineer will read it" : ""}
          </div>
        </Panel>
      )}

      {clause && (
        <Panel title="Terms">
          <div className="t-body">{clause}</div>
        </Panel>
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
