import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { attachments, shareLinks, shareLinkFiles } from "@/db/schema";
import { getBrand } from "@/lib/brand";
import { linkState } from "@/lib/dropShare";
import { fmtBytes } from "@/lib/storage";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

/**
 * What a share link shows the person holding it: the named files, and nothing
 * about the store they came from. Dead links say why in one sentence and stop
 * - see the drop page for the reasoning; it is the same posture.
 */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [link] = token.length >= 12
    ? await db.select().from(shareLinks).where(eq(shareLinks.token, token)).catch(() => [])
    : [];
  const state = link ? linkState(link, shopToday()) : null;
  const brand = await getBrand();

  if (!link || state !== "active") {
    return (
      <div className="container" style={{ maxWidth: 520, paddingTop: 60, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>
          {state === "expired" ? "This link has expired" : "This link is no longer active"}
        </h1>
        <p className="mut" style={{ fontSize: 13 }}>Ask whoever sent it to you for a new one.</p>
      </div>
    );
  }

  const fileIds = (await db.select({ attachmentId: shareLinkFiles.attachmentId })
    .from(shareLinkFiles).where(eq(shareLinkFiles.shareId, link.id))).map((r) => r.attachmentId);
  const files = fileIds.length
    ? await db.select({ id: attachments.id, fileName: attachments.fileName, size: attachments.size })
        .from(attachments).where(inArray(attachments.id, fileIds))
    : [];

  return (
    <div className="container" style={{ maxWidth: 560, paddingTop: 48 }}>
      <div className="card">
        <div className="eyebrow" style={{ marginBottom: 4 }}>{brand.name}</div>
        <h1 style={{ fontSize: 19, margin: "0 0 6px" }}>{link.label || "Files shared with you"}</h1>
        <p className="mut" style={{ fontSize: 13, marginBottom: 12 }}>
          {files.length} file{files.length === 1 ? "" : "s"} · available until {link.expiresOn}
        </p>
        {files.map((f) => (
          <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
            <a href={`/api/share/${token}/file/${f.id}`} style={{ fontSize: 13, fontWeight: 600, textDecoration: "none", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
              {f.fileName}
            </a>
            <span className="mut" style={{ fontSize: 12, flexShrink: 0 }}>{fmtBytes(f.size)}</span>
          </div>
        ))}
        {files.length === 0 && <div className="mut" style={{ fontSize: 13 }}>The shared files are gone.</div>}
        {files.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <a className="btn sm primary" href={`/api/share/${token}/zip`} style={{ textDecoration: "none" }}>
              Download all (.zip)
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
