import { redirect } from "next/navigation";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { assets, attachments, instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isHouse, scopeFor, visibleAssetIds } from "@/lib/tenancy";
import { assetAccess } from "@/lib/tenancy";
import PdfStudio from "@/components/PdfStudio";
import { myCloudConnection } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * The PDF studio: every PDF this person may read, offered as source material;
 * every record they may edit, offered as a destination. The heavy lifting
 * (thumbnails, page edits, assembly) all happens in the browser - this page
 * just draws the map of what they're allowed to touch.
 *
 * Open to everyone signed in, including read-only viewers: assembling a packet
 * out of documents you can already read and downloading it is reading, not
 * writing. What a viewer doesn't get is a destination - the picker below only
 * offers records they may edit, and their own shelf only if they may write to
 * it - so the studio degrades to "build it and download it".
 */
export default async function PdfStudioPage({ searchParams }: { searchParams: Promise<{ cloud?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const house = isHouse(user.role);
  const canWrite = user.role !== "client_viewer";

  const [scope, seeAssets] = await Promise.all([scopeFor(user), visibleAssetIds(user)]);

  // Source material: PDF attachments on anything visible, plus this person's own
  // document library. The same rows the download proxy would allow - scoped here
  // in one query rather than per-file round trips.
  const pdfRows = await db.select({
    id: attachments.id, fileName: attachments.fileName, kind: attachments.kind,
    size: attachments.size, instrumentId: attachments.instrumentId, assetId: attachments.assetId,
    orgId: attachments.orgId, createdAt: attachments.createdAt,
  }).from(attachments)
    .where(and(
      ilike(attachments.fileName, "%.pdf"),
      house ? undefined : or(
        scope.all ? undefined : scope.ids.length ? inArray(attachments.instrumentId, scope.ids) : sql`false`,
        seeAssets === null ? undefined : seeAssets.length ? inArray(attachments.assetId, seeAssets) : sql`false`,
        // The org's own shelf: homeless files stamped to it.
        user.orgId === null ? sql`false` : and(
          isNull(attachments.instrumentId), isNull(attachments.assetId), eq(attachments.orgId, user.orgId),
        ),
      ),
    ))
    .orderBy(desc(attachments.createdAt))
    .limit(400);

  const instIds = [...new Set(pdfRows.flatMap((r) => (r.instrumentId !== null ? [r.instrumentId] : [])))];
  const assetIds = [...new Set(pdfRows.flatMap((r) => (r.assetId !== null ? [r.assetId] : [])))];
  const [instRows, assetRows] = await Promise.all([
    instIds.length ? db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments).where(inArray(instruments.id, instIds)) : [],
    assetIds.length ? db.select({ id: assets.id, kind: assets.kind, model: assets.model, serial: assets.serial }).from(assets).where(inArray(assets.id, assetIds)) : [],
  ]);
  const instName = new Map(instRows.map((i) => [i.id, i.externalId]));
  const assetName = new Map(assetRows.map((a) => [a.id, `${a.kind}${a.model ? ` ${a.model}` : ""}${a.serial ? ` SN ${a.serial}` : ""}`]));

  const sources = pdfRows.map((r) => ({
    id: r.id, fileName: r.fileName, kind: r.kind, size: r.size,
    home: r.instrumentId !== null
      ? instName.get(r.instrumentId) ?? "a system"
      : r.assetId !== null
        ? assetName.get(r.assetId) ?? "a unit"
        : "Shelf",
  }));

  // Destinations: what this person may attach the result to. A read-only viewer
  // gets none, and the studio says so rather than offering a button that fails.
  const editableSystems = !canWrite ? [] : (await db.select({ id: instruments.id, externalId: instruments.externalId, client: instruments.client })
    .from(instruments)
    .where(and(
      sql`${instruments.archived} = false`,
      scope.all ? undefined : scope.ids.length ? inArray(instruments.id, scope.ids) : sql`false`,
    ))
    .orderBy(asc(instruments.externalId)))
    .filter((s) => scope.all ? user.role !== "client_viewer" : scope.editable.has(s.id));

  const shelf = !canWrite ? [] : await db.select({ id: assets.id, kind: assets.kind, model: assets.model, serial: assets.serial })
    .from(assets)
    .where(and(
      isNull(assets.instrumentId),
      sql`${assets.status} <> 'Decommissioned'`,
      seeAssets === null ? undefined : seeAssets.length ? inArray(assets.id, seeAssets) : sql`false`,
    ))
    .orderBy(asc(assets.kind));
  const editableShelf: typeof shelf = [];
  for (const a of shelf) {
    if (house || (await assetAccess(user, a.id)).edit) editableShelf.push(a);
  }

  const cloud = await myCloudConnection()
    .catch(() => ({ configured: false, account: "", brokenReason: "", setupProblem: "" }));
  // Whatever the Microsoft handshake reported on its way back. Read here rather
  // than left in the URL: the callback's only way to speak is this parameter,
  // and until something showed it a refused connection looked like nothing.
  const { cloud: cloudNote } = await searchParams;

  return (
    <div className="container split">
      <PdfStudio
        sources={sources}
        destinations={[
          ...editableSystems.map((s) => ({ key: `i:${s.id}`, label: `${s.externalId}${s.client ? ` · ${s.client}` : ""}` })),
          ...editableShelf.map((a) => ({ key: `a:${a.id}`, label: `${a.kind}${a.model ? ` ${a.model}` : ""}${a.serial ? ` SN ${a.serial}` : ""} (shelf)` })),
        ]}
        // Anyone who may write has a shelf of their own to save to.
        canUseLibrary={canWrite}
        libraryLabel={house ? "Document library" : "Our file shelf"}
        // This person's own outside file store. Read here so the studio arrives
        // knowing whether to offer it, rather than flashing a Connect button at
        // somebody who connected months ago.
        cloud={cloud}
        cloudNote={(cloudNote ?? "").slice(0, 300)}
      />
    </div>
  );
}
