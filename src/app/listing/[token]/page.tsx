import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments, assets, tasks, parts, attachments } from "@/db/schema";
import { composeSystemLabel } from "@/lib/systemLabel";
import { getBrand } from "@/lib/brand";
import { shopMonthDay } from "@/lib/shopday";

export const dynamic = "force-dynamic";

// Shareable, not indexable: buyers get the link from the seller.
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The public face of a system that is for sale. No sign-in - the token in the
 * URL is the whole key, minted unguessable and dead the moment the listing
 * ends. Everything here is deliberately curated for an outside buyer:
 * what the system is, what work was completed, what parts were fitted, and
 * the files the seller chose to publish. Location, client identity, internal
 * notes, discussions, pricing and people never render - this page must not
 * use the session or tenancy helpers at all, so nothing can leak by accident.
 */
export default async function ListingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length < 12) notFound();
  // A token names either a whole system or a single asset - resolve in that order.
  const [inst] = await db.select().from(instruments)
    .where(and(eq(instruments.listingToken, token), eq(instruments.forSale, true)));
  const [soloAsset] = inst ? [] : await db.select().from(assets)
    .where(and(eq(assets.listingToken, token), eq(assets.forSale, true)));
  if (!inst && !soloAsset) notFound();

  const [brand, assetRows, taskRows, partRows, fileRows] = await Promise.all([
    getBrand(),
    inst
      ? db.select().from(assets).where(eq(assets.instrumentId, inst.id)).orderBy(asc(assets.sortOrder), asc(assets.id))
      : [soloAsset],
    inst
      ? db.select().from(tasks).where(and(eq(tasks.instrumentId, inst.id), eq(tasks.state, "Done"))).orderBy(asc(tasks.completedAt))
      : db.select().from(tasks).where(and(eq(tasks.assetId, soloAsset.id), eq(tasks.state, "Done"))).orderBy(asc(tasks.completedAt)),
    inst
      ? db.select().from(parts).where(eq(parts.instrumentId, inst.id)).orderBy(asc(parts.id))
      : db.select().from(parts).where(eq(parts.assetId, soloAsset.id)).orderBy(asc(parts.id)),
    db.select().from(attachments)
      .where(and(
        inst ? eq(attachments.instrumentId, inst.id) : eq(attachments.assetId, soloAsset.id),
        eq(attachments.showOnListing, true)))
      .orderBy(asc(attachments.fileName)),
  ]);
  // Only parts that ended up in (or came out of) the machine tell a buyer
  // anything; the procurement pipeline is internal.
  const fitted = partRows.filter((p) => p.status === "Installed" || p.status === "Removed");
  const label = inst
    ? composeSystemLabel(assetRows, inst.model)
    : `${soloAsset.kind}${soloAsset.model ? ` — ${soloAsset.model}` : ""}`;
  const category = inst?.category ?? "";
  const saleNote = inst?.saleNote ?? soloAsset?.saleNote ?? "";

  // The root layout already draws the platform header (it renders for
  // anonymous viewers too), so this page starts straight at the listing.
  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <div className="mut" style={{ fontSize: 12, padding: "2px 2px 8px" }}>Instrument listing</div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "var(--navy)" }}>{label || "Instrument system"}</div>
          {category && <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{category}</span>}
          <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>For sale</span>
        </div>
        {saleNote && <div style={{ fontSize: 14, marginTop: 8, whiteSpace: "pre-wrap" }}>{saleNote}</div>}

        {assetRows.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>{inst ? "What's in the system" : "The unit"}</div>
            {assetRows.map((a) => (
              <div key={a.id} style={{ padding: "6px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
                <b>{a.kind}</b>{a.model ? ` — ${a.model}` : ""}{a.manufacturer ? ` · ${a.manufacturer}` : ""}
                {a.serial && <span className="mono mut"> · SN {a.serial}</span>}
              </div>
            ))}
          </>
        )}
      </div>

      {taskRows.length > 0 && (
        <div className="card">
          <div className="card-title">Completed work ({taskRows.length})</div>
          {taskRows.map((t) => (
            <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
              <span>{t.title}</span>
              {t.origin === "checkout" && <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>checkout</span>}
              {t.completedAt && <span className="mut" style={{ fontSize: 11, marginLeft: "auto", whiteSpace: "nowrap" }}>{shopMonthDay(t.completedAt)}</span>}
            </div>
          ))}
        </div>
      )}

      {fitted.length > 0 && (
        <div className="card">
          <div className="card-title">Parts fitted &amp; pulled ({fitted.length})</div>
          {fitted.map((p) => (
            <div key={p.id} style={{ padding: "5px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
              <b>{p.name}</b>
              {p.partNumber && <span className="mono mut"> PN {p.partNumber}</span>}
              {p.serial && <span className="mono mut"> SN {p.serial}</span>}
              <span className="mut" style={{ fontSize: 12 }}>
                {p.status === "Installed" ? ` · installed${p.installedAt ? ` ${p.installedAt}` : ""}` : ` · removed${p.removedAt ? ` ${p.removedAt}` : ""}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {fileRows.length > 0 && (
        <div className="card">
          <div className="card-title">Documentation</div>
          {fileRows.map((a) => (
            <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
              <a href={`/api/files/${a.id}`} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{a.fileName}</a>
              <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{a.kind}</span>
              {a.description && <span className="mut" style={{ fontSize: 12 }}>{a.description}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="mut" style={{ fontSize: 11, padding: "0 2px 24px" }}>
        Listed on {brand.name}. History shown as recorded.
      </div>
    </div>
  );
}
