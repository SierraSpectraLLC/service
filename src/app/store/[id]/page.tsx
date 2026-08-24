import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { orgs, partCatalog, partKitLines, partPhotos } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { shelfFor } from "@/lib/storeData";
import { formatCents } from "@/lib/money";
import PartBuyBox from "@/components/PartBuyBox";
import { Id, Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * One part, on its own page, so it can be opened in a tab and sent to a
 * colleague: every photo rather than the row's thumbnail, what it fits, what
 * is in it when it is a kit, and the same buy control the row carries.
 *
 * The item comes from the same shelf the list is built from, so the price and
 * the availability here are the ones the row showed and the ones the order
 * will use. A part that is not on this client's shelf is a 404 to them - the
 * id in the URL buys nothing the shelf did not already offer.
 */
export default async function StorePartPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (isStaffRole(user.role) && user.orgId === null) redirect("/purchasing");
  if (user.orgId === null) redirect("/");
  const [org] = await db.select().from(orgs).where(eq(orgs.id, user.orgId));
  if (!org || org.kind !== "client") redirect("/");
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) notFound();

  const { items, termsDays } = await shelfFor(org);
  const item = items.find((i) => i.id === id);
  if (!item) notFound();

  const [row] = await db.select().from(partCatalog).where(eq(partCatalog.id, id));
  const photos = await db.select({ url: partPhotos.url, caption: partPhotos.caption })
    .from(partPhotos).where(eq(partPhotos.catalogId, id))
    .orderBy(asc(partPhotos.sortOrder), asc(partPhotos.id));
  // A kit is a bag of other numbers; say which, and price the ones we sell.
  const kit = item.kind === "kit"
    ? await db.select().from(partKitLines).where(eq(partKitLines.kitId, id))
    : [];
  const kitPriced = kit.map((k) => ({
    ...k,
    also: items.find((i) => i.partNumber.trim().toLowerCase() === k.partNumber.trim().toLowerCase()) ?? null,
  }));

  // What else suits the same equipment - the aisle this part sits in. Shared
  // model first, then shared kind of machine, because "another part for your
  // 6495C" is a better neighbour than "another vacuum pump part".
  const lc = (v: string) => v.trim().toLowerCase();
  const myModels = new Set((row?.models ?? []).map(lc).filter(Boolean));
  const myTypes = new Set((row?.assetTypes ?? []).map(lc).filter(Boolean));
  const fits = myModels.size || myTypes.size
    ? await db.select({ id: partCatalog.id, models: partCatalog.models, assetTypes: partCatalog.assetTypes })
        .from(partCatalog).where(inArray(partCatalog.id, items.map((i) => i.id)))
    : [];
  const rank = new Map(fits
    .filter((f) => f.id !== id)
    .map((f) => [f.id, f.models.some((m) => myModels.has(lc(m))) ? 2
      : f.assetTypes.some((t) => myTypes.has(lc(t))) ? 1 : 0] as const)
    .filter(([, r]) => r > 0));
  const related = items.filter((i) => rank.has(i.id))
    .sort((a, b) => (rank.get(b.id)! - rank.get(a.id)!) || a.name.localeCompare(b.name))
    .slice(0, 6);

  const spec = (label: string, value: string) => (
    <div key={label} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
      <span className="mut t-small" style={{ width: 130, flexShrink: 0 }}>{label}</span>
      <span className="t-body" style={{ flex: 1, minWidth: 0 }}>{value}</span>
    </div>
  );

  return (
    <div className="container">
      <div className="crumb">
        <Link href="/store">Parts</Link>
        {item.manufacturer ? <> › {item.manufacturer}</> : null} › <b>{item.partNumber}</b>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ flex: "1 1 300px", minWidth: 260 }}>
          {photos.length > 0 ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photos[0].url} alt={photos[0].caption || item.name}
                style={{ width: "100%", maxHeight: 320, objectFit: "cover", borderRadius: 12, border: "1px solid var(--line)", background: "#F7F9FC" }} />
              {photos.length > 1 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 8, marginTop: 8 }}>
                  {photos.slice(1).map((p, n) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={n} src={p.url} alt={p.caption || `${item.name}, view ${n + 2}`}
                      style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)", background: "#F7F9FC" }} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <div aria-hidden style={{ width: "100%", height: 200, borderRadius: 12, border: "1px dashed var(--line)", background: "#F7F9FC", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span className="mut t-small">No photo yet</span>
            </div>
          )}
        </div>

        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          <div className="mut t-meta" style={{ textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700 }}>
            {[item.manufacturer, item.kind === "kit" ? "kit" : item.kind === "consumable" ? "consumable" : ""].filter(Boolean).join(" · ")}
          </div>
          <h1 className="t-page" style={{ margin: "2px 0 4px", color: "var(--navy)" }}>{item.name}</h1>
          <div className="mut t-small"><Id>{item.partNumber}</Id></div>
          {item.fitsLabel && (
            // The shelf's own phrasing, sentence-cased. It already names their
            // unit when it can ("fits your LZ-001") and stays generic when it
            // cannot; green is what says this one suits their fleet.
            <div className="t-body" style={{ marginTop: 8, color: item.fitsYours ? "var(--t-good-fg)" : undefined }}>
              {item.fitsLabel.charAt(0).toUpperCase() + item.fitsLabel.slice(1)}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <PartBuyBox item={item} termsDays={termsDays} />
          </div>
        </div>
      </div>

      {(row?.note || row?.mfrPartNumber || (row?.models ?? []).length > 0 || (row?.assetTypes ?? []).length > 0) && (
        <Panel title="Details">
          {row?.mfrPartNumber ? spec("Maker's number", row.mfrPartNumber) : null}
          {(row?.models ?? []).length > 0 ? spec("Fits models", row!.models.join(", ")) : null}
          {(row?.assetTypes ?? []).length > 0 ? spec("For", row!.assetTypes.join(", ")) : null}
          {row?.note ? spec("Notes", row.note) : null}
        </Panel>
      )}

      {kitPriced.length > 0 && (
        <Panel title="What's in the kit" count={kitPriced.length}>
          {kitPriced.map((k) => (
            <div key={k.id} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="t-body">{k.name || k.partNumber}</span>
                <span className="mut t-meta" style={{ display: "block" }}><Id>{k.partNumber}</Id></span>
              </span>
              {k.qty > 1 && <span className="mut t-small">× {k.qty}</span>}
              {k.also && (
                <Link className="btn sm" href={`/store/${k.also.id}`} style={{ textDecoration: "none" }}>
                  On its own{k.also.priceCents !== null ? ` · ${formatCents(k.also.priceCents)}` : ""}
                </Link>
              )}
            </div>
          ))}
        </Panel>
      )}

      {related.length > 0 && (
        <Panel title="Also for this equipment" count={related.length}>
          {related.map((r) => (
            <Link key={r.id} href={`/store/${r.id}`} className="row-hover"
              style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "7px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="t-body" style={{ fontWeight: 600 }}>{r.name}</span>
                <span className="mut t-meta" style={{ display: "block" }}><Id>{r.partNumber}</Id></span>
              </span>
              <b className="mono t-small">{r.priceCents !== null ? formatCents(r.priceCents) : "quote"}</b>
            </Link>
          ))}
        </Panel>
      )}

      <div style={{ marginTop: 4 }}>
        <Link className="btn sm" href="/store" style={{ textDecoration: "none" }}>← All parts</Link>
      </div>
    </div>
  );
}
