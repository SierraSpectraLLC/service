// The rows behind a generated document, assembled once for both renderers.
//
// A quote and its proposal are each one DocSpec: the words as blocks, and the
// frame around them - the tag in the header, the client on the
// confidentiality line, the contact line in the footer. The Word route, the
// PDF route and the print page all ask here, so a change to what a quote
// says on paper is made once.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments, orgs, workOrders } from "@/db/schema";
import { brandForTenant } from "@/lib/brand";
import { longDate } from "@/lib/demandLetter";
import { quoteById, quoteSubtotal, quoteTotal, qtyOf } from "@/lib/invoiceData";
import { proposalBlocks } from "@/lib/proposal";
import { proposalForQuote, sectionRows, systemRows, tierRows } from "@/lib/proposalData";
import { addressedTo, depositCents, discountLabel, discountOf, greetingLine, specRows } from "@/lib/quotes";
import { shopToday } from "@/lib/shopday";
import { docContactLine } from "@/lib/xlsxDocData";
import { docTag, type DocSpec } from "@/lib/docStyle";
import { quoteDocument } from "@/lib/quoteDoc";

export type DocOf = { spec: DocSpec; tenantOrgId: number | null };

/** The quote as paper: Service Quote, the summary block, scope, pricing, terms. */
export async function quoteDocSpec(quoteId: number): Promise<DocOf | null> {
  const full = await quoteById(quoteId);
  if (!full) return null;
  const [org, brand, wo] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, full.row.orgId)).then((r) => r[0] ?? null),
    brandForTenant(full.row.tenantOrgId),
    full.row.workOrderId !== null
      ? db.select({ instrumentId: workOrders.instrumentId }).from(workOrders).where(eq(workOrders.id, full.row.workOrderId)).then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);
  const inst = wo?.instrumentId != null
    ? await db.select({ name: instruments.name, model: instruments.model, tag: instruments.externalId })
        .from(instruments).where(eq(instruments.id, wo.instrumentId)).then((r) => r[0] ?? null)
    : null;
  const to = addressedTo(full.row, org);
  const subtotal = quoteSubtotal(full);
  const total = quoteTotal(full);
  const blocks = quoteDocument({
    number: full.row.number,
    title: full.row.title,
    customer: to.name,
    contact: full.row.attn,
    date: longDate(full.row.sentOn || shopToday()),
    pricingValid: full.row.expiresOn ? `through ${longDate(full.row.expiresOn)}` : "",
    greeting: greetingLine(full.row),
    specs: { left: specRows(full.row.specsLeft), right: specRows(full.row.specsRight) },
    systems: inst ? [{ name: inst.name, model: inst.model, tag: inst.tag }] : [],
    lines: full.lines.map((l) => ({
      description: l.description, detail: l.detail, partNumber: l.partNumber,
      qty: qtyOf(l), unit: l.unit, unitCents: l.unitCents, covered: l.covered, coveredBy: l.coveredBy,
    })),
    subtotalCents: subtotal,
    discountCents: discountOf(subtotal, full.row),
    discountLabel: discountLabel(full.row),
    totalCents: total,
    depositPct: full.row.depositPct,
    depositCents: depositCents(total, full.row.depositPct),
    note: full.row.note,
    expiresOn: full.row.expiresOn ? longDate(full.row.expiresOn) : "",
  });
  return {
    tenantOrgId: full.row.tenantOrgId,
    spec: {
      type: "Quote",
      tag: docTag("Quote", { number: full.row.number }),
      client: to.name,
      number: full.row.number,
      operatorName: brand.operatorName || brand.name,
      contactLine: docContactLine(brand),
      blocks,
    },
  };
}

/** The proposal as paper. Null when the quote exists but nobody has started one. */
export async function proposalDocSpec(quoteId: number): Promise<DocOf | null> {
  const full = await quoteById(quoteId);
  if (!full) return null;
  const p = await proposalForQuote(quoteId);
  if (!p) return null;
  const [org, brand] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, full.row.orgId)).then((r) => r[0] ?? null),
    brandForTenant(full.row.tenantOrgId),
  ]);
  const to = addressedTo(full.row, org);
  const operator = brand.operatorName || brand.name;
  const blocks = proposalBlocks({
    title: p.row.title,
    subtitle: p.row.subtitle,
    customer: to.name,
    contact: full.row.attn,
    date: longDate(full.row.sentOn || shopToday()),
    quoteNumber: full.row.number,
    pricingValid: p.row.pricingValid,
    systems: systemRows(p),
    tiers: tierRows(p),
    recommendedTier: p.row.recommendedTier,
    sections: sectionRows(p),
  });
  // The closing contact block the print page has always ended on.
  blocks.push({ kind: "head", text: "Contact" });
  blocks.push({ kind: "para", text: [operator, brand.contactEmail].filter(Boolean).join("\n") });
  return {
    tenantOrgId: full.row.tenantOrgId,
    spec: {
      type: "Proposal",
      tag: docTag("Proposal", { client: to.name }),
      client: to.name,
      number: p.row.number || full.row.number,
      operatorName: operator,
      contactLine: docContactLine(brand),
      // The long document: title and summary block are its cover, and each
      // section is read on a page of its own. See docStyle.DocSpec.
      sectionBreaks: true,
      blocks,
    },
  };
}
