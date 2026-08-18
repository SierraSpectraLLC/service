import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { folders as foldersTable, orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getBrand } from "@/lib/brand";
import { shopTime } from "@/lib/shopday";
import { storeFiles, storeQuota, visibleNotOwnedFiles } from "@/lib/storeUsage";
import { groupStoredFiles, totalBytes } from "@/lib/storeGroup";
import { fmtBytes } from "@/lib/storage";
import { visibleOrgs } from "@/lib/tenancy";
import StoreFileList from "@/components/StoreFileList";
import LibraryUpload from "@/components/LibraryUpload";
import StorageMeter from "@/components/StorageMeter";
import CloudLibraryCard from "@/components/CloudLibraryCard";
import { getFileColumns, myCloudConnection } from "@/app/actions";

export const dynamic = "force-dynamic";

const CAP = 500;
/** Mirrors the token mint in /api/upload. Named here so the page can say it
    before somebody spends a transfer finding out. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

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
export default async function DocumentsPage(
  { searchParams }: { searchParams: Promise<{ store?: string; cloud?: string; folder?: string }> },
) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const isHouseUser = user.role === "owner" || user.role === "staff";

  // `cloud` is whatever the Microsoft handshake reported on its way back. Read
  // here rather than left in the URL: the callback's only way to speak is this
  // parameter, and until something showed it a refused connection looked like
  // nothing at all happening.
  const { store: storeParam, cloud: cloudNote, folder: folderParam } = await searchParams;
  const wanted = storeParam && /^\d+$/.test(storeParam) ? parseInt(storeParam) : null;
  // Only the house may look at another store; everyone else gets their own,
  // whatever the query string says.
  const viewing = isHouseUser ? wanted : user.orgId;
  const isOwnStore = viewing === user.orgId;

  const [rows, quota, orgRows, brand, guestRows, cloud] = await Promise.all([
    storeFiles(viewing, CAP).catch(() => []),
    storeQuota(viewing),
    isHouseUser ? visibleOrgs(user).catch(() => []) : [],
    getBrand(),
    // Readable, but somebody else's - a system shared with them, or one they
    // sold and stayed on as a viewer. These are why the PDF studio can offer
    // PDFs this page used to omit without explaining itself.
    isOwnStore ? visibleNotOwnedFiles(user).catch(() => []) : [],
    // This person's own outside store. Never fatal to the page: a Microsoft
    // outage must not take somebody's own files down with it.
    myCloudConnection().catch(() => ({ configured: false, account: "", brokenReason: "", setupProblem: "" })),
  ]);
  // The store's folders. Loose files only - a file on a system is already
  // filed where it belongs; see lib/folders.
  const folderRows = await db.select({ id: foldersTable.id, name: foldersTable.name, parentId: foldersTable.parentId })
    .from(foldersTable)
    .where(viewing === null ? isNull(foldersTable.orgId) : eq(foldersTable.orgId, viewing))
    .orderBy(asc(foldersTable.name))
    .catch(() => []);
  // A folder id from the URL only counts if it is one of this store's - a
  // stale link after switching stores lands at the top level rather than in an
  // empty folder that appears to have eaten everything.
  const wantFolder = folderParam && /^\d+$/.test(folderParam) ? parseInt(folderParam) : null;
  const openFolder = folderRows.find((f) => f.id === wantFolder) ?? null;
  // How this person likes their columns. Read here so the table renders at
  // their widths on the first frame instead of snapping after hydration.
  const savedCols = await getFileColumns().catch(() => null);

  const files = groupStoredFiles(rows);
  const guests = groupStoredFiles(guestRows);
  const shown = totalBytes(files);
  const truncated = rows.length >= CAP;
  const canEdit = user.role !== "client_viewer";

  return (
    <div className="container page">
      <div className="page-head">
        <h1 className="page-title">Files</h1>
        <span className="mut" style={{ fontSize: 12 }}>
          {files.length === 0 ? "empty"
            : `${files.length} file${files.length === 1 ? "" : "s"} · ${fmtBytes(shown)}${truncated ? ` (newest ${CAP})` : ""}`}
        </span>
        <span className="page-actions">
          {/* The meter used to be a card of its own at the top, which made a
              file store open on a gauge. It is a number now, and it moves out
              of the way. */}
          <StorageMeter quota={quota} name={quota.storeName} compact />
          <Link href="/pdf" className="btn sm" style={{ textDecoration: "none" }}>PDF studio</Link>
        </span>
      </div>
      {/* The sentence a client needed and did not get: they declined to upload
          anything here because the page looked like filing something would
          clutter their systems. It never would. */}
      {isOwnStore && (
        <div className="mut" style={{ fontSize: 12.5, marginTop: -4, marginBottom: 10 }}>
          Your organization&apos;s storage. A file put here belongs to
          {" "}{quota.storeName} and is attached to no system, no unit and no job -
          it is somewhere to keep things. Filing one onto a record is a separate,
          deliberate act done from that record.
        </div>
      )}
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
        {!isOwnStore && (
          <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
            Everything {quota.storeName} is storing.
          </div>
        )}
        {canEdit && isOwnStore && (
          <LibraryUpload full={quota.state === "full"} maxBytes={MAX_FILE_BYTES}
            folderId={openFolder?.id ?? null} folderName={openFolder?.name ?? ""} />
        )}
        <StoreFileList
          files={files.map((f) => ({
            url: f.url, size: f.size, fileName: f.fileName, description: f.description,
            kind: f.kind, uploadedBy: f.uploadedBy, when: shopTime(f.newest.createdAt),
            at: new Date(f.newest.createdAt).getTime(),
            folderId: f.newest.folderId ?? null,
            places: f.places,
            // Mirrors deleteAttachment exactly: a shelf file is its own org's to
            // remove, a file on a record is the house's. Showing a button the
            // server would refuse is worse than showing none.
            shelfOwnerId: f.newest.orgId,
          }))}
          folders={folderRows}
          storeOrgId={viewing}
          openFolderId={openFolder?.id ?? null}
          columnWidths={savedCols}
          canOrganise={canEdit && (isOwnStore || isHouseUser)}
          canRemoveShelf={canEdit && isOwnStore}
          canRemoveRecord={isHouseUser}
        />
        {truncated && (
          <div className="mut" style={{ fontSize: 11, marginTop: 8 }}>
            Only the newest {CAP} rows are listed; the meter above counts everything.
          </div>
        )}
      </div>

      {/* Somewhere else the org's documents already live. Only on your own
          store, and only if you may write to it: copying a file in is a filing
          act, and nobody files into somebody else's shelf. */}
      {canEdit && isOwnStore && cloud.configured && (
        <CloudLibraryCard
          account={cloud.account} brokenReason={cloud.brokenReason}
          note={(cloudNote ?? "").slice(0, 300)}
          full={quota.state === "full"} />
      )}
      {/* Half-configured says so rather than vanishing. Staff only - the message
          names environment variables. */}
      {canEdit && isOwnStore && !cloud.configured && cloud.setupProblem && (
        <div className="card" style={{ fontSize: 12, color: "#8A5410", background: "#FAF0DC",
          border: "1px solid #F0C9A0" }}>
          {cloud.setupProblem}
        </div>
      )}

      {/* The half that was missing. Files you can open that live in someone
          else's store - which is exactly the set the PDF studio offers and this
          page used to leave out without saying why. */}
      {guests.length > 0 && (
        <div className="card">
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <div className="card-title">Shared with you</div>
            <span className="mut" style={{ fontSize: 12 }}>
              {guests.length} file{guests.length === 1 ? "" : "s"} · {fmtBytes(totalBytes(guests))}
            </span>
          </div>
          <StoreFileList
            files={guests.map((f) => ({
              url: f.url, size: f.size, fileName: f.fileName, description: f.description,
              kind: f.kind, uploadedBy: f.uploadedBy, when: shopTime(f.newest.createdAt),
              at: new Date(f.newest.createdAt).getTime(),
              folderId: null,
              places: f.places, shelfOwnerId: f.newest.orgId,
            }))}
            // Not yours to delete. The buttons are simply absent.
            canRemoveShelf={false} canRemoveRecord={false}
            columnWidths={savedCols}
            emptyNote="Nothing shared with you yet."
          />
        </div>
      )}
    </div>
  );
}
