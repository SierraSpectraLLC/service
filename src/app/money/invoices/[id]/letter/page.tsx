import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { orgs, orgSites, shareLinks, signoffs, workOrders } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { brandForTenant } from "@/lib/brand";
import { formatCents } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { addDays } from "@/lib/pm";
import { asStatementRow, billingContext, creditFor, invoiceById, liveFees } from "@/lib/invoiceData";
import { invoiceView } from "@/lib/statement";
import { contactFor, RUNG_BY_KEY } from "@/lib/dunning";
import { demandLetter, exhibitsFor, longDate } from "@/lib/demandLetter";
import PrintButton from "@/components/PrintButton";
import { PrintHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The demand letter, generated from the record.
 *
 * Every claim in it points at a row: the send log for "we have sent three
 * reminders", the share link's open event for "it was opened on the 13th", the
 * promise row for "K. Osei committed to a payment", the fee row for the amount
 * and its basis. Sentences whose rows are missing are dropped rather than
 * fudged - a letter that claims three reminders when two were sent is worse
 * than one that claims two, because this is a document somebody's lawyer may
 * read.
 */
export default async function DemandLetterPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) notFound();

  const full = await invoiceById(id);
  if (!full) notFound();
  const today = shopToday();
  const view = invoiceView(asStatementRow(full), today);

  const [org, wo, brand, ctx, credit, link] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, full.row.orgId)).then((r) => r[0] ?? null),
    full.row.workOrderId === null ? Promise.resolve(null)
      : db.select().from(workOrders).where(eq(workOrders.id, full.row.workOrderId)).then((r) => r[0] ?? null),
    brandForTenant(full.row.tenantOrgId),
    billingContext(full.row.orgId),
    creditFor(full.row.orgId, today),
    db.select().from(shareLinks)
      .where(and(eq(shareLinks.invoiceId, id), isNull(shareLinks.revokedAt))).then((r) => r[0] ?? null),
  ]);
  const [site] = org
    ? await db.select().from(orgSites).where(eq(orgSites.orgId, org.id)).limit(1)
    : [];
  const signed = wo?.instrumentId
    ? (await db.select().from(signoffs).where(eq(signoffs.instrumentId, wo.instrumentId)).limit(1)).length > 0
    : false;

  const fees = liveFees(full);
  const reminders = full.dunning.filter((d) => d.rung === "nudge" || d.rung === "due").length;
  const statements = full.dunning.filter((d) => d.rung === "statement").length;
  const broken = full.promises.find((p) => !p.keptOn && p.promisedOn && p.promisedOn < today) ?? null;
  // The rung this letter IS - the owner letter names the purchasing director,
  // not the contact who has already ignored three reminders.
  const contact = contactFor(RUNG_BY_KEY.owner, ctx.policy);

  const blocks = demandLetter({
    operatorName: brand.operatorName || brand.name,
    operatorLine: brand.tagline || "",
    today,
    clientName: org?.name ?? "",
    clientPlace: site?.address ?? "",
    toName: contact?.name ?? org?.name ?? "",
    toRole: contact?.role ?? "",
    invoiceNumber: full.row.number,
    workOrderNumber: wo?.number ?? "",
    workDescription: wo?.title?.toLowerCase() ?? "",
    issuedOn: full.row.issuedOn,
    dueOn: full.row.dueOn,
    poNumber: full.row.poNumber ? `purchase order ${full.row.poNumber}` : "",
    daysLate: view.daysLate,
    payableCents: view.payableCents - fees.reduce((n, c) => n + c, 0),
    feeCents: fees.reduce((n, c) => n + c, 0),
    feeBasis: full.fees.find((f) => !f.waived)?.basis ?? "",
    remindersSent: reminders,
    statementsSent: statements,
    firstViewedOn: link?.openedAt ? link.openedAt.toISOString().slice(0, 10) : "",
    promise: broken ? { byName: broken.byName, promisedOn: broken.promisedOn } : null,
    onHold: credit.onHold,
    policy: ctx.policy,
    remitBy: addDays(today, 10),
    referOn: addDays(today, 11),
    exhibits: exhibitsFor({
      invoiceNumber: full.row.number,
      workOrderNumber: wo?.number ?? "",
      signedOff: signed,
      noticesSent: full.dunning.length,
    }),
  });

  return (
    <div className="container" style={{ maxWidth: 700 }}>
      <div className="crumb no-print">
        <Link href="/money/collections">Collections</Link> › <b>{full.row.number}</b>
      </div>
      <PrintButton />
      <PrintHeader
        logoUrl={brand.operatorLogoUrl}
        operator={brand.operatorName || brand.name}
        title={brand.tagline || "Instrument service"}
        date={longDate(today)}
        docId={full.row.number}
      />

      <div className="t-body" style={{ marginBottom: 14 }}>
        <div className="mut">Re: {full.row.number}{full.row.poNumber ? ` · PO ${full.row.poNumber}` : " · no PO"}</div>
        <div style={{ fontWeight: 700, marginTop: 8 }}>
          {blocks.length && contact ? `${contact.name}, ${contact.role}` : org?.name}
        </div>
        <div className="mut">{`${org?.name ?? ""}${site?.address ? `, ${site.address}` : ""}`}</div>
      </div>

      {blocks.map((b, i) =>
        b.kind === "head" ? (
          <h2 key={i} className="t-page" style={{ margin: "0 0 12px", fontWeight: 700 }}>{b.text}</h2>
        ) : b.kind === "list" ? (
          <p key={i} className="mut t-small" style={{ marginTop: 16 }}>
            {b.text}: {b.items?.join(", ")}.
          </p>
        ) : (
          <p key={i} className="t-body" style={{ margin: "0 0 12px", lineHeight: 1.7 }}>{b.text}</p>
        ),
      )}

      <p className="t-body" style={{ marginTop: 20 }}>
        {user.name || user.email} - {brand.operatorName || brand.name}
      </p>
      <p className="mut t-meta no-print" style={{ marginTop: 16 }}>
        Generated from the record. Balance quoted: {formatCents(view.payableCents)}.
      </p>
    </div>
  );
}
