import Link from "next/link";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getBrand } from "@/lib/brand";
import { shopTime } from "@/lib/shopday";
import { storeFiles, storeQuota, visibleNotOwnedFiles } from "@/lib/storeUsage";
import { groupStoredFiles, totalBytes } from "@/lib/storeGroup";
import { fmtBytes } from "@/lib/storage";
import StoreFileList from "@/components/StoreFileList";
import LibraryUpload from "@/components/LibraryUpload";
import StorageMeter from "@/components/StorageMeter";

export const dynamic = "force-dynamic";

const CAP = 500;

/**
 * An organization's file store - everything in it, which is the fix for a page
 * that used to be called storage while listing one drawer of it. A store is:
 *
 *   - its shelf: documents belonging to no system or unit
 *   - the paperwork on every system and unit it owns
 *
 * Both count toward the quota, so both belong here. Files are grouped by the
 * stored file rather than by row, because one document filed onto four records
 * is one upload charged once - and the total at the bottom has to match the
 * meter at the top or neither can be trusted.
 *
 * The operator can look at any organization's store: they set the limits, so
 * "what is LabZen actually holding" has to be answerable.
 */
export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const isHouseUser = user.role === "owner" || user.role === "staff";

  const { store: storeParam } = await searchParams;
  const wanted = storeParam && /^\d+$/.test(storeParam) ? parseInt(storeParam) : null;
  // Only the house may look at another store; everyone else gets their own,
  // whatever the query string says.
  const viewing = isHouseUser ? wanted : user.orgId;
  const isOwnStore = viewing === user.orgId;

  const [rows, quota, orgRows, brand, guestRows] = await Promise.all([
    storeFiles(viewing, CAP).catch(() => []),
    storeQuota(viewing),
    isHouseUser ? db.select({ id: orgs.id, name: orgs.name }).from(orgs).orderBy(asc(orgs.name)).catch(() => []) : [],
    getBrand(),
    // Readable, but somebody else's - a system shared with them, or one they
    // sold and stayed on as a viewer. These are why the PDF studio can offer
    // PDFs this page used to omit without explaining itself.
    isOwnStore ? visibleNotOwnedFiles(user).catch(() => []) : [],
  ]);

  const files = groupStoredFiles(rows);
  const guests = groupStoredFiles(guestRows);
  const shown = totalBytes(files);
  const truncated = rows.length >= CAP;
  const canEdit = user.role !== "client_viewer";

  return (
    <div className="container page">
      {orgRows.length > 0 && (
        <div className="card" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="mut" style={{ fontSize: 12, marginRight: 4 }}>Store</span>
          {[{ id: null as number | null, name: `${brand.operatorName || brand.name} (own work)` },
            ...orgRows.map((o) => ({ id: o.id as number | null, name: o.name }))].map((s) => (
            <Link key={s.id ?? "own"} href={s.id === null ? "/documents" : `/documents?store=${s.id}`}
              className={`btn sm${viewing === s.id ? " primary" : ""}`} style={{ textDecoration: "none" }}>
              {s.name}
            </Link>
          ))}
        </div>
      )}

      <div className="card">
        <StorageMeter
          quota={quota}
          name={quota.storeName}
          hint="This organization's own shelf plus the files on every system and unit it owns. A document filed onto several records is stored - and counted - once."
        />
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          <div className="card-title">Files</div>
          <span className="mut" style={{ fontSize: 12 }}>
            {files.length === 0 ? "nothing stored yet"
              : `${files.length} file${files.length === 1 ? "" : "s"} · ${fmtBytes(shown)}${truncated ? ` (newest ${CAP} rows)` : ""}`}
          </span>
          <Link href="/pdf" className="btn sm" style={{ marginLeft: "auto", textDecoration: "none" }}>
            Open PDF studio
          </Link>
        </div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          {isOwnStore
            ? "Your shelf, plus the paperwork on every system and unit you own."
            : `Everything ${quota.storeName} is storing.`}
        </div>
        {canEdit && isOwnStore && <LibraryUpload full={quota.state === "full"} />}
        <StoreFileList
          files={files.map((f) => ({
            url: f.url, size: f.size, fileName: f.fileName, description: f.description,
            kind: f.kind, uploadedBy: f.uploadedBy, when: shopTime(f.newest.createdAt),
            places: f.places,
            // Mirrors deleteAttachment exactly: a shelf file is its own org's to
            // remove, a file on a record is the house's. Showing a button the
            // server would refuse is worse than showing none.
            shelfOwnerId: f.newest.orgId,
          }))}
          canRemoveShelf={canEdit && isOwnStore}
          canRemoveRecord={isHouseUser}
        />
        {truncated && (
          <div className="mut" style={{ fontSize: 11, marginTop: 8 }}>
            Only the newest {CAP} rows are listed; the meter above counts everything.
          </div>
        )}
      </div>

      {/* The half that was missing. Files you can open that live in someone
          else's store - which is exactly the set the PDF studio offers and this
          page used to leave out without saying why. */}
      {guests.length > 0 && (
        <div className="card">
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <div className="card-title">Shared with you</div>
            <span className="mut" style={{ fontSize: 12 }}>
              {guests.length} file{guests.length === 1 ? "" : "s"} · {fmtBytes(totalBytes(guests))} · not counted against your storage
            </span>
          </div>
          <StoreFileList
            files={guests.map((f) => ({
              url: f.url, size: f.size, fileName: f.fileName, description: f.description,
              kind: f.kind, uploadedBy: f.uploadedBy, when: shopTime(f.newest.createdAt),
              places: f.places, shelfOwnerId: f.newest.orgId,
            }))}
            // Not yours to delete. The buttons are simply absent.
            canRemoveShelf={false} canRemoveRecord={false}
          />
        </div>
      )}
    </div>
  );
}
