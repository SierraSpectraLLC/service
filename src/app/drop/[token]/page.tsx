import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dropLinks, folders, orgs } from "@/db/schema";
import { getBrand } from "@/lib/brand";
import { linkState } from "@/lib/dropShare";
import { shopToday } from "@/lib/shopday";
import DropUploader from "@/components/DropUploader";

export const dynamic = "force-dynamic";

/**
 * The public face of a drop link: where somebody with no account sends files.
 *
 * Public like /listing - the unguessable token is the credential. A dead link
 * says WHY it is dead in the owner's terms ("this ran out" vs "this was turned
 * off") but never what it pointed at: the page mentions the receiving company
 * only while the link works, because a revoked token should stop being
 * informative the moment it stops being useful.
 */
export default async function DropPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [link] = token.length >= 12
    ? await db.select().from(dropLinks).where(eq(dropLinks.token, token)).catch(() => [])
    : [];
  const brand = await getBrand();
  const state = link ? linkState(link, shopToday()) : null;

  if (!link || state !== "active") {
    return (
      <div className="container" style={{ maxWidth: 520, paddingTop: 60, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>
          {state === "expired" ? "This link has expired" : "This link is no longer active"}
        </h1>
        <p className="mut" style={{ fontSize: 13 }}>
          Ask whoever sent it to you for a new one.
        </p>
      </div>
    );
  }

  const [org] = link.orgId !== null
    ? await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, link.orgId))
    : [];
  const [folder] = link.folderId !== null
    ? await db.select({ name: folders.name }).from(folders).where(eq(folders.id, link.folderId))
    : [];
  const receiver = org?.name || brand.operatorName || brand.name;

  return (
    <div className="container" style={{ maxWidth: 560, paddingTop: 48 }}>
      <div className="card">
        <div className="eyebrow" style={{ marginBottom: 4 }}>{brand.name}</div>
        <h1 style={{ fontSize: 19, margin: "0 0 6px" }}>Send files to {receiver}</h1>
        <p className="mut" style={{ fontSize: 13, marginBottom: 14 }}>
          Files go straight to {receiver}&apos;s storage{folder ? <> (into <b style={{ fontWeight: 700 }}>{folder.name}</b>)</> : ""} and
          they are told when something arrives. This link works until {link.expiresOn}.
        </p>
        <DropUploader token={token} />
      </div>
    </div>
  );
}
