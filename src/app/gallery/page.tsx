import Link from "next/link";
import { redirect } from "next/navigation";
import { inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getBrand } from "@/lib/brand";
import { shopTime } from "@/lib/shopday";
import { storeFiles } from "@/lib/storeUsage";
import { groupStoredFiles } from "@/lib/storeGroup";
import { isPhotoFile } from "@/lib/photos";
import { visibleOrgs } from "@/lib/tenancy";
import GalleryGrid from "@/components/GalleryGrid";
import { FacetStrip, PageHead, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

const CAP = 500;

/**
 * Every photo an organization holds, in one place.
 *
 * The documents page is the same store read as paperwork; this is the same store
 * read as pictures. Both were always there - photos have never been a separate
 * kind of storage, only attachments a browser can render - but a filename list
 * is a useless way to find a photograph, and "the one of the pump with the
 * cracked fitting" is exactly how somebody remembers it.
 *
 * Scoped like the documents page for the same reasons: your own store unless you
 * are the house, which sets the limits and therefore has to be able to answer
 * "what is this organization actually holding".
 */
export default async function GalleryPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const isHouseUser = user.role === "owner" || user.role === "staff";

  const { store: storeParam } = await searchParams;
  const wanted = storeParam && /^\d+$/.test(storeParam) ? parseInt(storeParam) : null;
  // Only the house may look at another store; everyone else gets their own,
  // whatever the query string says.
  const viewing = isHouseUser ? wanted : user.orgId;

  const [rows, orgRows, brand] = await Promise.all([
    storeFiles(viewing, CAP).catch(() => []),
    isHouseUser ? visibleOrgs(user).catch(() => []) : [],
    getBrand(),
  ]);

  const photos = groupStoredFiles(rows.filter(isPhotoFile));

  // Which of these are the photo that represents its record. Marked rather than
  // filtered: a cover is a preference about one picture, not a category of file.
  const ids = photos.map((p) => p.newest.id);
  const [sysCovers, unitCovers] = ids.length
    ? await Promise.all([
      db.select({ id: instruments.photoAttachmentId }).from(instruments)
        .where(inArray(instruments.photoAttachmentId, ids)).catch(() => []),
      db.select({ id: assets.photoAttachmentId }).from(assets)
        .where(inArray(assets.photoAttachmentId, ids)).catch(() => []),
    ])
    : [[], []];
  const covers = new Set([...sysCovers, ...unitCovers].map((r) => r.id).filter((id): id is number => id != null));

  return (
    <div className="container page">
      <PageHead
        crumb={<>Library › <b>Gallery</b></>}
        title="Gallery"
        sub={photos.length === 0 ? "No photos yet."
          : `${photos.length} photo${photos.length === 1 ? "" : "s"}${rows.length >= CAP ? ` (newest ${CAP} files)` : ""}`}
        actions={<Link href="/documents" className="btn sm" style={{ textDecoration: "none" }}>All files</Link>}
      />
      {orgRows.length > 0 && (
        <Toolbar facets={
          <FacetStrip facets={[{ id: null as number | null, name: `${brand.operatorName || brand.name} (own work)` },
            ...orgRows.map((o) => ({ id: o.id as number | null, name: o.name }))].map((s) => ({
              key: String(s.id ?? "own"), label: s.name, on: viewing === s.id,
              href: s.id === null ? "/gallery" : `/gallery?store=${s.id}`,
            }))} />
        } />
      )}

      <div className="card">
        <GalleryGrid photos={photos.map((p) => ({
          attachmentId: p.newest.id, url: p.url, fileName: p.fileName, description: p.description,
          framing: p.newest.framing, uploadedBy: p.uploadedBy, when: shopTime(p.newest.createdAt),
          places: p.places, isCover: covers.has(p.newest.id),
        }))} />
      </div>
    </div>
  );
}
