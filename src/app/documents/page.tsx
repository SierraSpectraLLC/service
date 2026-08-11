import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopTime } from "@/lib/shopday";
import { storeQuota } from "@/lib/storeUsage";
import LibraryList from "@/components/LibraryList";
import LibraryUpload from "@/components/LibraryUpload";
import StorageMeter from "@/components/StorageMeter";

export const dynamic = "force-dynamic";

/**
 * A file store, one per organization: documents belonging to no system or unit -
 * packets the studio assembled for later, SOPs, blank templates, reference
 * sheets. Everyone signed in has one; the house's is the operator's own shelf.
 *
 * The shelf is private to its organization. What is NOT on this page but does
 * count toward the same quota is the paperwork on the systems and units the
 * organization owns - that lives on those records, and follows them when they
 * change hands. lib/storage explains the accounting.
 */
export default async function DocumentsPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }

  const [rows, quota] = await Promise.all([
    db.select().from(attachments)
      .where(and(
        isNull(attachments.instrumentId), isNull(attachments.assetId),
        user.orgId === null ? isNull(attachments.orgId) : eq(attachments.orgId, user.orgId),
      ))
      .orderBy(desc(attachments.createdAt))
      .catch(() => []),
    storeQuota(user.orgId),
  ]);
  const canEdit = user.role !== "client_viewer";

  return (
    <div className="container page">
      <div className="card">
        <StorageMeter
          quota={quota}
          name={quota.storeName}
          hint="Counts this shelf plus the files on every system and unit you own. One document filed onto several records is stored once."
        />
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          <div className="card-title">Files</div>
          <Link href="/pdf" className="btn sm" style={{ marginLeft: "auto", textDecoration: "none" }}>
            Open PDF studio
          </Link>
        </div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          {user.orgId === null
            ? "The shop's own shelf - files attached to no system or unit."
            : `${quota.storeName}'s own shelf - files attached to no system or unit. Nobody outside your organization can read these.`}
          {" "}To put one on a record, open its Files panel and choose &ldquo;From library&rdquo;; the shelf keeps its copy.
        </div>
        {canEdit && <LibraryUpload full={quota.state === "full"} />}
        <LibraryList files={rows.map((r) => ({
          id: r.id, fileName: r.fileName, size: r.size, description: r.description,
          uploadedBy: r.uploadedBy, when: shopTime(r.createdAt),
        }))} canEdit={canEdit} />
      </div>
    </div>
  );
}
