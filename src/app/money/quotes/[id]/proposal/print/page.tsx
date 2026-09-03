import { Fragment } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { brandForTenant } from "@/lib/brand";
import { shopToday } from "@/lib/shopday";
import { quoteById } from "@/lib/invoiceData";
import { addressedTo } from "@/lib/quotes";
import { longDate } from "@/lib/demandLetter";
import { proposalBlocks } from "@/lib/proposal";
import { proposalForQuote, sectionRows, systemRows, tierRows } from "@/lib/proposalData";
import { docContactLine } from "@/lib/xlsxDocData";
import PrintButton from "@/components/PrintButton";
import { PrintHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The proposal, as paper.
 *
 * Every word in it is a row: the sections in their order, the systems the shop
 * added, the tiers it priced, the recommendation it put its name to. Nothing
 * is composed here that lib/proposal does not compose - this file is a
 * renderer, so the day this becomes a PDF the words do not move.
 */
export default async function ProposalPrintPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) notFound();

  const full = await quoteById(id);
  if (!full) notFound();
  const p = await proposalForQuote(id);
  if (!p) redirect(`/money/quotes/${id}/proposal`);

  const [org, brand] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, full.row.orgId)).then((r) => r[0] ?? null),
    brandForTenant(full.row.tenantOrgId),
  ]);
  const to = addressedTo(full.row, org);
  const today = shopToday();

  const blocks = proposalBlocks({
    title: p.row.title,
    subtitle: p.row.subtitle,
    customer: to.name,
    contact: full.row.attn,
    date: longDate(full.row.sentOn || today),
    quoteNumber: full.row.number,
    pricingValid: p.row.pricingValid,
    systems: systemRows(p),
    tiers: tierRows(p),
    recommendedTier: p.row.recommendedTier,
    sections: sectionRows(p),
  });

  return (
    <div className="container doc">
      <div className="crumb no-print">
        <Link href="/money/quotes">Quotes</Link> ›{" "}
        <Link href={`/money/quotes/${id}`}>{full.row.number}</Link> ›{" "}
        <Link href={`/money/quotes/${id}/proposal`}>Proposal</Link> › <b>Print</b>
      </div>
      <PrintButton />
      <PrintHeader
        logoUrl={brand.operatorLogoUrl}
        operator={brand.operatorName || brand.name}
        title={brand.tagline || "Instrument service"}
        date={longDate(today)}
        docId={p.row.number}
      />

      {blocks.map((b, i) => {
        if (b.kind === "title") {
          return (
            <div key={i}>
              <h1 className="doc-title">{b.text}</h1>
              {b.sub && <div className="doc-subtitle">{b.sub}</div>}
            </div>
          );
        }
        if (b.kind === "facts") {
          return (
            <table key={i} className="doc-facts">
              <tbody>
                {/* Two pairs to a row, the way the shop's own header table reads. */}
                {Array.from({ length: Math.ceil(b.rows.length / 2) }, (_, r) => (
                  <tr key={r}>
                    {[b.rows[r * 2], b.rows[r * 2 + 1]].map((cell, c) =>
                      cell ? (
                        <Fragment key={c}>
                          <td className="k">{cell[0]}</td>
                          <td>{cell[1]}</td>
                        </Fragment>
                      ) : <Fragment key={c}><td className="k" /><td /></Fragment>,
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        if (b.kind === "head") return <h2 key={i} className="doc-head">{b.text}</h2>;
        if (b.kind === "sub") return <h3 key={i} className="doc-subhead">{b.text}</h3>;
        // A caption for the table under it prints smaller and italic; the
        // assembler decides which paragraphs those are, not this file.
        if (b.kind === "para") {
          return (
            <p key={i} className={b.lead ? "doc-lead" : b.strong ? "strong" : undefined}>{b.text}</p>
          );
        }
        if (b.kind === "list") {
          return <ul key={i}>{b.items.map((it, j) => <li key={j}>{it}</li>)}</ul>;
        }
        if (b.kind === "callout") {
          return (
            <div key={i} className="doc-callout">
              <div className="h">{b.text}</div>
              {b.body.map((t, j) => <p key={j}>{t}</p>)}
            </div>
          );
        }
        return (
          <table key={i} className="doc-table">
            <thead>
              <tr>{b.head.map((h, j) => <th key={j}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j} className={b.lead && j === 0 ? "lead" : undefined}>
                  {r.map((c, k) => <td key={k}>{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}

      <h2 className="doc-head">Contact</h2>
      <p>
        {brand.operatorName || brand.name}
        {brand.contactEmail ? <><br />{brand.contactEmail}</> : null}
      </p>

      {/* Repeated on every printed page - see .doc-foot. A confidentiality
          line on page one and nowhere else is not a confidentiality line. */}
      <div className="doc-foot">
        <div>{docContactLine(brand)}</div>
        <div>CONFIDENTIAL{to.name ? ` - Prepared for ${to.name}` : ""}</div>
      </div>

      <p className="mut t-meta no-print">
        Print to PDF and send it, or <Link href={`/money/quotes/${id}/proposal`}>go back and edit it</Link>.
      </p>
    </div>
  );
}
