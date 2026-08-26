import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, dropLinks, folders as foldersTable, instruments, orgs, shareLinks, shareLinkFiles } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getBrand } from "@/lib/brand";
import { shopTime, shopToday } from "@/lib/shopday";
import { storeFiles, storeQuota, visibleNotOwnedFiles } from "@/lib/storeUsage";
import { groupStoredFiles, totalBytes } from "@/lib/storeGroup";
import { fmtBytes } from "@/lib/storage";
import { forTenant, readTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import StoreFileList from "@/components/StoreFileList";
import FileLinksCard, { type StoreLink } from "@/components/FileLinksCard";
import LibraryUpload from "@/components/LibraryUpload";
import CloudLibraryCard from "@/components/CloudLibraryCard";
import { FacetStrip } from "@/components/ui";
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
  /*
   * Only the house may look at another store; everyone else gets their own,
   * whatever the query string says. And "another store" means one of THIS
   * workspace's organizations: the id arrives in the URL, so without checking
   * it against the reachable set a staff member could type another service
   * company's client id and read their files. visibleOrgs already answers
   * exactly that question, and platform staff still see everything through it.
   */
  const reachable = isHouseUser ? await visibleOrgs(user).catch(() => []) : [];
  const viewing = isHouseUser
    ? (wanted !== null && reachable.some((o) => o.id === wanted) ? wanted : null)
    : user.orgId;
  const isOwnStore = viewing === user.orgId;

  const [rows, quota, orgRows, brand, guestRows, cloud] = await Promise.all([
    storeFiles(viewing, readTenant(user), CAP).catch(() => []),
    storeQuota(viewing, readTenant(user)),
    reachable,
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
  // Scoped by tenant as well as by org, because the house shelf is org_id NULL
  // in every workspace - so "the folders with no org" is otherwise everybody's.
  const storeTenant = readTenant(user);
  const folderRows = await db.select({ id: foldersTable.id, name: foldersTable.name, parentId: foldersTable.parentId })
    .from(foldersTable)
    .where(and(
      viewing === null ? isNull(foldersTable.orgId) : eq(foldersTable.orgId, viewing),
      forTenant(foldersTable.tenantOrgId, storeTenant),
    ))
    .orderBy(asc(foldersTable.name))
    .catch(() => []);
  // A folder id from the URL only counts if it is one of this store's - a
  // stale link after switching stores lands at the top level rather than in an
  // empty folder that appears to have eaten everything.
  const wantFolder = folderParam && /^\d+$/.test(folderParam) ? parseInt(folderParam) : null;
  const openFolder = folderRows.find((f) => f.id === wantFolder) ?? null;
  // How this person likes their columns. Read here so the table renders at
  // their widths on the first frame instead of snapping after hydration.
  const canEdit = user.role !== "client_viewer";
  const savedCols = await getFileColumns().catch(() => null);
  // Where a loose file can be filed from here: the systems this person can
  // see. attachLibraryFile still checks edit rights on the target, so the
  // picker being generous costs a sentence, never a leak.
  const visSystems = isOwnStore && canEdit ? await visibleSystemIds(user) : [];
  const systemRows = isOwnStore && canEdit
    ? await db.select({ id: instruments.id, externalId: instruments.externalId, model: instruments.model })
        .from(instruments)
        .where(and(eq(instruments.archived, false),
          visSystems === null ? undefined : visSystems.length ? inArray(instruments.id, visSystems) : sql`false`))
        .orderBy(asc(instruments.externalId)).catch(() => [])
    : [];
  // The store's open doors: drop links into it, plus share links this person
  // made. Staff browsing another org's store see that store's drop links -
  // they administer it - but only their own shares, which are personal.
  const canOrganise = canEdit && (isOwnStore || isHouseUser);
  const [dropRows, shareRows] = await Promise.all([
    canOrganise
      // A drop link row carries its TOKEN, and that token is the whole
      // credential: /api/drop/[token] mints a Blob upload against nothing else.
      // Unscoped, the house-shelf branch handed one operator every other
      // operator's live upload tokens.
      ? db.select().from(dropLinks)
          .where(and(
            viewing === null ? isNull(dropLinks.orgId) : eq(dropLinks.orgId, viewing),
            forTenant(dropLinks.tenantOrgId, storeTenant),
          ))
          .orderBy(desc(dropLinks.createdAt)).limit(30).catch(() => [])
      : [],
    isOwnStore && canEdit
      ? db.select().from(shareLinks).where(eq(shareLinks.createdBy, user.email))
          .orderBy(desc(shareLinks.createdAt)).limit(30).catch(() => [])
      : [],
  ]);
  const shareCounts = shareRows.length
    ? await db.select({ shareId: shareLinkFiles.shareId, n: sql<number>`count(*)` })
        .from(shareLinkFiles).where(inArray(shareLinkFiles.shareId, shareRows.map((r) => r.id)))
        .groupBy(shareLinkFiles.shareId).catch(() => [])
    : [];
  const storeLinks: StoreLink[] = [
    ...dropRows.map((l) => ({
      id: l.id, kind: "drop" as const, label: l.label, token: l.token, expiresOn: l.expiresOn,
      revokedAt: l.revokedAt?.toISOString() ?? null, count: l.usedCount,
      folderName: folderRows.find((f) => f.id === l.folderId)?.name,
    })),
    ...shareRows.map((l) => ({
      id: l.id, kind: "share" as const, label: l.label, token: l.token, expiresOn: l.expiresOn,
      revokedAt: l.revokedAt?.toISOString() ?? null,
      count: Number(shareCounts.find((c) => c.shareId === l.id)?.n ?? 0),
    })),
  ];

  const files = groupStoredFiles(rows);
  const guests = groupStoredFiles(guestRows);
  const shown = totalBytes(files);
  const truncated = rows.length >= CAP;

  const quotaTone = quota.state === "full" ? "bad" : quota.state === "warn" ? "warn" : quota.state === "ok" ? "good" : "neutral";

  return (
    <div className="container fluid">
      <div className="crumb">Library › <b>Files</b></div>
      <div className="page-head">
        <h1 className="page-title">Files</h1>
        <span className="page-actions">
          <Link href="/pdf" className="btn sm" style={{ textDecoration: "none" }}>PDF studio</Link>
        </span>
      </div>

      {/* Whose store is on screen. Staff only - everybody else has exactly
          one store and sees no strip. */}
      {orgRows.length > 0 && (
        <FacetStrip facets={[
          { key: "own", label: `${brand.operatorName || brand.name} (own work)`, on: viewing === null, href: "/documents" },
          ...orgRows.map((o) => ({
            key: String(o.id), label: o.name, on: viewing === o.id, href: `/documents?store=${o.id}`,
          })),
        ]} />
      )}

      {/* The store at a glance. The meter used to be a gauge card, then a
          header line; it is a metric tile now, alongside the counts. */}
      <div className="metric-grid" style={{ margin: "10px 0 12px" }}>
        {([
          ["Files", files.length === 0 ? "0" : `${files.length}${truncated ? `+` : ""}`, undefined],
          ["Stored", fmtBytes(shown), undefined],
          ["Storage",
            quota.limitBytes === null
              ? "No limit"
              : `${fmtBytes(quota.usedBytes)} of ${fmtBytes(quota.limitBytes)}`
                + (quota.state === "full" ? " · full" : quota.state === "warn" ? " · low" : ""),
            quotaTone === "good" || quotaTone === "neutral" ? undefined : quotaTone],
          ["Folders", String(folderRows.length), undefined],
        ] as [string, string, string | undefined][]).map(([label, n, tone]) => (
          <div key={label} className="card" style={{ padding: "12px 14px", marginBottom: 0 }}>
            <div className="mut t-small">{label}</div>
            <div className="t-page" style={{ fontWeight: 700, color: tone ? `var(--t-${tone}-fg)` : "var(--navy)" }}>{n}</div>
            {label === "Storage" && quota.limitBytes !== null && (
              <div style={{ height: 5, borderRadius: 999, background: "#E2E8F0", overflow: "hidden", marginTop: 6 }}
                role="img" aria-label={`${quota.pct}% of file storage used`}>
                <div style={{ width: `${Math.max(quota.pct, quota.usedBytes > 0 ? 3 : 0)}%`, height: "100%", background: `var(--t-${quotaTone}-fg)` }} />
              </div>
            )}
          </div>
        ))}
      </div>
      {/* The sentence a client needed and did not get: they declined to upload
          anything here because the page looked like filing something would
          clutter their systems. It never would. */}
      {isOwnStore && (
        <div className="mut" style={{ fontSize: 13, marginTop: -4, marginBottom: 10 }}>
          Your organization&apos;s storage. A file put here belongs to
          {" "}{quota.storeName} and is attached to no system, no unit and no job -
          it is somewhere to keep things. Filing one onto a record is a separate,
          deliberate act done from that record.
        </div>
      )}
      <div className="card">
        {!isOwnStore && (
          <div className="mut t-small" style={{ marginBottom: 10 }}>
            Everything {quota.storeName} is storing.
          </div>
        )}
        {canEdit && isOwnStore && (
          <LibraryUpload full={quota.state === "full"} maxBytes={MAX_FILE_BYTES}
            folderId={openFolder?.id ?? null} folderName={openFolder?.name ?? ""} />
        )}
        <FileLinksCard links={storeLinks} storeOrgId={viewing}
          openFolderId={openFolder?.id ?? null} openFolderName={openFolder?.name ?? ""}
          today={shopToday()} canManage={canOrganise} />
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
          systems={systemRows}
          canOrganise={canOrganise}
          canRemoveShelf={canEdit && isOwnStore}
          canRemoveRecord={isHouseUser}
        />
        {truncated && (
          <div className="mut t-meta" style={{ marginTop: 8 }}>
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
        <div className="card t-small" style={{ color: "var(--t-warn-fg)", background: "#FAF0DC",
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
            <span className="mut t-small">
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
