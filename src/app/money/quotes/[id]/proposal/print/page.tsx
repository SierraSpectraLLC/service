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
import { addressedTo, addressBlock } from "@/lib/quotes";
import { longDate } from "@/lib/demandLetter";
import { proposalBlocks } from "@/lib/proposal";
import { proposalForQuote, sectionRows, systemRows, tierRows } from "@/lib/proposalData";
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
    <div className="container" style={{ maxWidth: 760 }}>
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
            <div key={i} style={{ marginBottom: 16 }}>
              <h1 className="page-title">{b.text}</h1>
              {b.sub && <div className="mut t-body" style={{ marginTop: 4 }}>{b.sub}</div>}
            </div>
          );
        }
        if (b.kind === "facts") {
          return (
            <table key={i} className="t-body"
              style={{ width: "100%", borderCollapse: "collapse", marginBottom: 24 }}>
              <tbody>
                {/* Two pairs to a row, the way the shop's own header table reads. */}
                {Array.from({ length: Math.ceil(b.rows.length / 2) }, (_, r) => (
                  <tr key={r}>
                    {[b.rows[r * 2], b.rows[r * 2 + 1]].map((cell, c) => (
                      <ProposalFact key={c} label={cell?.[0] ?? ""} value={cell?.[1] ?? ""} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        if (b.kind === "head") {
          return (
            <h2 key={i} className="t-page"
              style={{ margin: "24px 0 8px", fontWeight: 700, borderBottom: "2px solid var(--navy)", paddingBottom: 4 }}>
              {b.text}
            </h2>
          );
        }
        if (b.kind === "sub") {
          return (
            <h3 key={i} className="t-body" style={{ margin: "16px 0 4px", fontWeight: 700 }}>{b.text}</h3>
          );
        }
        if (b.kind === "para") {
          return (
            <p key={i} className="t-body" style={{ margin: "0 0 8px", lineHeight: 1.7 }}>{b.text}</p>
          );
        }
        if (b.kind === "list") {
          return (
            <ul key={i} className="t-body" style={{ margin: "0 0 8px 16px", lineHeight: 1.7 }}>
              {b.items.map((it, j) => <li key={j}>{it}</li>)}
            </ul>
          );
        }
        if (b.kind === "callout") {
          return (
            <div key={i} className="card tone-accent" style={{ marginBottom: 12 }}>
              <div className="t-body" style={{ fontWeight: 700, marginBottom: 4 }}>{b.text}</div>
              {b.body.map((t, j) => (
                <p key={j} className="t-body" style={{ margin: "0 0 8px", lineHeight: 1.7 }}>{t}</p>
              ))}
            </div>
          );
        }
        return (
          <div key={i} style={{ overflowX: "auto", marginBottom: 12 }}>
            <table className="t-small" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {b.head.map((h, j) => (
                    <th key={j} style={{
                      textAlign: j === 0 ? "left" : "center", padding: "4px 8px",
                      borderBottom: "2px solid var(--navy)", fontWeight: 700, whiteSpace: "nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k} style={{
                        textAlign: k === 0 ? "left" : "center", padding: "4px 8px",
                        borderBottom: "1px solid var(--line)",
                        fontWeight: k === 0 ? 600 : 400,
                      }}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      <h2 className="t-page" style={{ margin: "24px 0 8px", fontWeight: 700, borderBottom: "2px solid var(--navy)", paddingBottom: 4 }}>
        Contact
      </h2>
      <p className="t-body" style={{ margin: "0 0 8px", lineHeight: 1.7 }}>
        {brand.operatorName || brand.name}
        {brand.contactEmail ? <><br />{brand.contactEmail}</> : null}
        {to.address ? <><br /><span className="mut">Prepared for {to.name}, {addressBlock(to.address).join(", ")}</span></> : null}
      </p>

      <p className="mut t-meta no-print" style={{ marginTop: 16 }}>
        Print to PDF and send it, or <Link href={`/money/quotes/${id}/proposal`}>go back and edit it</Link>.
      </p>
    </div>
  );
}

/** One label/value pair of the header table. */
function ProposalFact({ label, value }: { label: string; value: string }) {
  if (!label) return <td style={{ width: "50%" }} />;
  return (
    <td style={{ width: "50%", padding: "4px 8px 4px 0", borderBottom: "1px solid var(--line)" }}>
      <span className="mut t-meta" style={{ display: "inline-block", width: 96 }}>{label}</span>
      <span className="t-body" style={{ fontWeight: 600 }}>{value}</span>
    </td>
  );
}
