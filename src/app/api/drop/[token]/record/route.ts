import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, dropLinks } from "@/db/schema";
import { audit } from "@/lib/audit";
import { linkLabel, linkUsable } from "@/lib/dropShare";
import { notifyDropReceived } from "@/lib/notify";
import { fits } from "@/lib/storage";
import { storeQuota } from "@/lib/storeUsage";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

const MB = 1024 * 1024;

/**
 * Files sent through a drop link become rows in the link's store.
 *
 * The quota is re-checked here even though the mint checked it: two senders
 * can hold live tokens at once, and the mint cannot see what the other one is
 * mid-transfer with. This is the check that cannot be raced past into an
 * over-full store - the same belt-and-braces the logged-in path uses.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;
  const [link] = await db.select().from(dropLinks).where(eq(dropLinks.token, token));
  if (!link || !linkUsable(link, shopToday())) {
    return NextResponse.json({ error: "This link is no longer active" }, { status: 404 });
  }
  let body: { sender?: string; files?: { fileName?: string; url?: string; size?: number }[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }
  const files = (body.files ?? [])
    .map((f) => ({
      fileName: String(f.fileName ?? "").trim().slice(0, 200),
      url: String(f.url ?? ""),
      size: Math.max(0, Math.floor(Number(f.size) || 0)),
    }))
    // Only blobs this app's store minted - a record call cannot point rows at
    // arbitrary URLs and make them look like received files.
    .filter((f) => f.fileName && /^https:\/\/[^/]*blob\.vercel-storage\.com\//.test(f.url))
    .slice(0, 30);
  if (!files.length) return NextResponse.json({ error: "Nothing to record" }, { status: 400 });

  const q = await storeQuota(link.orgId, link.tenantOrgId);
  const addBytes = files.reduce((n, f) => n + f.size, 0);
  if (!fits(q.usedBytes, addBytes, q.limitBytes === null ? 0 : Math.round(q.limitBytes / MB))) {
    return NextResponse.json({ error: "The store this link points to is full" }, { status: 400 });
  }

  const sender = String(body.sender ?? "").trim().slice(0, 80);
  const label = linkLabel(link);
  await db.insert(attachments).values(files.map((f) => ({
    ...f, kind: "Other",
    description: `arrived via drop link "${label}"${sender ? ` from ${sender}` : ""}`,
    tenantOrgId: link.tenantOrgId, orgId: link.orgId, folderId: link.folderId,
    instrumentId: null, assetId: null,
    uploadedBy: sender || "Drop link",
  })));
  await db.update(dropLinks)
    .set({ usedCount: sql`${dropLinks.usedCount} + ${files.length}`, lastUploadAt: new Date() })
    .where(eq(dropLinks.id, link.id));
  await audit({
    actor: sender || "drop link", entityType: "drop_link", entityId: link.id, tenantOrgId: link.tenantOrgId,
    action: `${files.length} file${files.length === 1 ? "" : "s"} arrived via drop link "${label}"`,
  });
  await notifyDropReceived({
    to: link.createdBy, label, count: files.length, names: files.map((f) => f.fileName),
  });
  return NextResponse.json({ ok: true });
}
