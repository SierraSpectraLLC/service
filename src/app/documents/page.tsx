import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { shopTime } from "@/lib/shopday";
import LibraryList from "@/components/LibraryList";

export const dynamic = "force-dynamic";

/**
 * The document library: files that belong to no system or unit - packets the
 * studio assembled for later, blank templates, reference sheets. Staff-only,
 * matching the download gate: a homeless file is readable by the house alone.
 */
export default async function DocumentsPage() {
  try { await requireStaff(); } catch { redirect("/"); }

  const rows = await db.select().from(attachments)
    .where(and(isNull(attachments.instrumentId), isNull(attachments.assetId)))
    .orderBy(desc(attachments.createdAt))
    .catch(() => []);

  return (
    <div className="container page">
      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          <div className="card-title">Document library</div>
          <Link href="/pdf" className="btn sm" style={{ marginLeft: "auto", textDecoration: "none" }}>
            Open PDF studio
          </Link>
        </div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          The shop&apos;s own shelf - files attached to no system or unit. Only staff see
          these; move one onto a record by rebuilding it in the studio with that
          destination.
        </div>
        <LibraryList files={rows.map((r) => ({
          id: r.id, fileName: r.fileName, size: r.size, description: r.description,
          uploadedBy: r.uploadedBy, when: shopTime(r.createdAt),
        }))} />
      </div>
    </div>
  );
}
