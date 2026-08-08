import { redirect } from "next/navigation";
import { and, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { assets, accessRequests, instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { assetAccess, canSeeSystem } from "@/lib/tenancy";
import { normalizeSerial, serialSearchable } from "@/lib/serial";
import { MODULE_KINDS } from "@/lib/stages";
import { RequestAccessCard, CreateSystemForm } from "@/components/LookupPanels";

export const dynamic = "force-dynamic";

/**
 * Find an instrument by its exact serial number. Three outcomes:
 *  - it's on something you can already see: a link;
 *  - it's on a system in another workspace: a minimal card (unit type and
 *    model only, no owner, no ID) with a request-access flow;
 *  - nobody has it: create it as a new system and start its history.
 * Matching is exact and case-insensitive, never prefix or fuzzy - a serial is
 * a key you must already hold, not a way to browse other people's inventory.
 * Another org's shelf spares are never disclosed at all.
 */
export default async function LookupPage({ searchParams }: { searchParams: Promise<{ sn?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { sn = "" } = await searchParams;
  const norm = normalizeSerial(sn);
  const searched = serialSearchable(sn);

  const matches = searched
    ? await db.select().from(assets).where(sql`lower(btrim(${assets.serial})) = ${norm}`)
    : [];

  const visible: { assetId: number; instrumentId: number | null; desc: string }[] = [];
  const requestable = new Map<number, string>(); // instrumentId -> asset description
  const assetListings: { desc: string; saleNote: string; listingToken: string }[] = [];
  for (const a of matches) {
    const desc = `${a.kind}${a.model ? ` — ${a.model}` : ""}`;
    const access = await assetAccess(user, a.id);
    if (access.see) {
      visible.push({
        assetId: a.id,
        instrumentId: a.instrumentId !== null && (await canSeeSystem(user, a.instrumentId)) ? a.instrumentId : null,
        desc,
      });
    } else if (a.instrumentId !== null) {
      requestable.set(a.instrumentId, desc);
    } else if (a.forSale) {
      // A hidden shelf spare stays undisclosed - unless its owner put it on
      // the market, in which case the listing is the disclosure.
      assetListings.push({ desc, saleNote: a.saleNote, listingToken: a.listingToken });
    }
  }

  // A hidden match that's on the market shows its public listing - the seller
  // wants buyers to find it. The link is the same one anyone could be handed.
  const listed = requestable.size
    ? await db.select({ id: instruments.id, saleNote: instruments.saleNote, listingToken: instruments.listingToken })
        .from(instruments).where(and(inArray(instruments.id, [...requestable.keys()]), eq(instruments.forSale, true)))
    : [];
  const listedBy = new Map(listed.map((l) => [l.id, l]));

  const pendingIds = user.orgId !== null && requestable.size
    ? (await db.select({ instrumentId: accessRequests.instrumentId }).from(accessRequests).where(and(
        eq(accessRequests.orgId, user.orgId), eq(accessRequests.status, "pending"),
        inArray(accessRequests.instrumentId, [...requestable.keys()]),
      ))).map((r) => r.instrumentId)
    : [];

  const nothingFound = searched && visible.length === 0 && requestable.size === 0 && assetListings.length === 0;
  const mayCreate = user.role !== "client_viewer";
  const kinds = searched && nothingFound && mayCreate
    ? [...new Set([...MODULE_KINDS, ...(await db.selectDistinct({ kind: assets.kind }).from(assets)).map((k) => k.kind)].filter(Boolean))]
    : [];

  return (
    <div className="container">
      <div className="card">
        <div className="card-title">Find an instrument by serial number</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>Exact match only.</div>
        <form method="GET" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="mono" name="sn" defaultValue={sn} placeholder="Serial number, e.g. L20505500123"
            style={{ flex: "1 1 220px", maxWidth: 340 }} autoFocus />
          <button className="btn sm accent" type="submit">Look up</button>
        </form>
        {sn && !searched && (
          <div className="mut" style={{ fontSize: 12, marginTop: 8 }}>Serial numbers are at least 4 characters.</div>
        )}

        {visible.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>In your workspace</div>
            {visible.map((v) => (
              <div key={v.assetId} style={{ padding: "6px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
                <Link href={v.instrumentId !== null ? `/instruments/${v.instrumentId}` : `/assets/${v.assetId}`} style={{ fontWeight: 600 }}>
                  {v.desc}
                </Link>
                <span className="mut" style={{ fontSize: 12 }}> · {v.instrumentId !== null ? "on a system you can open" : "in your asset registry"}</span>
              </div>
            ))}
          </>
        )}

        {requestable.size > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 14, marginBottom: 0 }}>Found, in another workspace</div>
            {[...requestable.entries()].map(([instId, desc]) => {
              const sale = listedBy.get(instId);
              return (
                <div key={instId}>
                  {sale && (
                    <div style={{ border: "1px solid #BFDDBF", background: "#F3FAF3", borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                        <b style={{ fontSize: 14, color: "var(--navy)" }}>{desc}</b>
                        <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>For sale</span>
                      </div>
                      {sale.saleNote && <div className="mut" style={{ fontSize: 12, marginTop: 2, whiteSpace: "pre-wrap" }}>{sale.saleNote}</div>}
                      <a href={`/listing/${sale.listingToken}`} target="_blank" rel="noreferrer" className="btn sm accent"
                        style={{ display: "inline-block", marginTop: 8, textDecoration: "none" }}>View listing</a>
                    </div>
                  )}
                  <RequestAccessCard serial={sn} assetDesc={desc} requested={pendingIds.includes(instId)}
                    canClaim={user.orgKind === "client"} />
                </div>
              );
            })}
          </>
        )}

        {assetListings.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 14, marginBottom: 0 }}>For sale</div>
            {assetListings.map((l, i) => (
              <div key={i} style={{ border: "1px solid #BFDDBF", background: "#F3FAF3", borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <b style={{ fontSize: 14, color: "var(--navy)" }}>{l.desc}</b>
                  <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>For sale</span>
                </div>
                {l.saleNote && <div className="mut" style={{ fontSize: 12, marginTop: 2, whiteSpace: "pre-wrap" }}>{l.saleNote}</div>}
                <a href={`/listing/${l.listingToken}`} target="_blank" rel="noreferrer" className="btn sm accent"
                  style={{ display: "inline-block", marginTop: 8, textDecoration: "none" }}>View listing</a>
              </div>
            ))}
          </>
        )}

        {nothingFound && (
          <>
            <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>No match</div>
            <div className="mut" style={{ fontSize: 13 }}>
              No instrument on the platform carries serial <span className="mono">{sn.trim()}</span>.
            </div>
            {mayCreate && <CreateSystemForm serial={sn.trim()} kinds={kinds} />}
          </>
        )}
      </div>
    </div>
  );
}
