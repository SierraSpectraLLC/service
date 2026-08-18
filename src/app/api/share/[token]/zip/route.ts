import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { attachments, shareLinks, shareLinkFiles } from "@/db/schema";
import { linkUsable } from "@/lib/dropShare";
import { shopToday } from "@/lib/shopday";
import { buildZip } from "@/lib/zip";

export const dynamic = "force-dynamic";

/** Everything a share link names, as one archive. Same cap as the authed zip. */
const MAX_ZIP_BYTES = 200 * 1024 * 1024;

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.token, token));
  if (!link || !linkUsable(link, shopToday())) return new NextResponse(null, { status: 404 });
  const ids = (await db.select({ attachmentId: shareLinkFiles.attachmentId })
    .from(shareLinkFiles).where(eq(shareLinkFiles.shareId, link.id))).map((r) => r.attachmentId);
  const files = ids.length
    ? await db.select().from(attachments).where(inArray(attachments.id, ids))
    : [];
  if (!files.length) return new NextResponse(null, { status: 404 });
  if (files.reduce((n, f) => n + f.size, 0) > MAX_ZIP_BYTES) {
    return NextResponse.json({ error: "Too large for one zip - download the files individually" }, { status: 413 });
  }
  const entries = [];
  for (const f of files) {
    // A missing or malformed blob skips its entry rather than sinking the
    // archive - fetch() THROWS on a bad scheme, it doesn't return !ok, and one
    // corrupt row must not make five good files undownloadable.
    try {
      const res = await fetch(f.url);
      if (!res.ok) continue;
      entries.push({ name: f.fileName, data: new Uint8Array(await res.arrayBuffer()) });
    } catch { continue; }
  }
  if (!entries.length) return new NextResponse(null, { status: 404 });
  const zip = buildZip(entries);
  return new NextResponse(Buffer.from(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${(link.label.trim() || "files").replace(/[^\w.-]+/g, "_").slice(0, 60)}.zip"`,
      "content-length": String(zip.length),
    },
  });
}
