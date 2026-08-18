import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dropLinks } from "@/db/schema";
import { linkUsable } from "@/lib/dropShare";
import { overQuotaMessage } from "@/lib/storage";
import { storeQuota } from "@/lib/storeUsage";
import { shopToday } from "@/lib/shopday";

export const dynamic = "force-dynamic";

/**
 * Token mint for a DROP LINK upload - the anonymous twin of /api/upload.
 *
 * No user: the link token in the path is the whole credential, checked the
 * same way at both steps (here, and again when rows are recorded) because a
 * link can be revoked mid-upload. Size and quota are enforced at mint time so
 * a doomed transfer never starts, and they are the STORE's limits - a drop
 * link spends the storage of whoever created it, not the sender's.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;
  const body = (await req.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => {
        const [link] = await db.select().from(dropLinks).where(eq(dropLinks.token, token));
        if (!link || !linkUsable(link, shopToday())) throw new Error("This link is no longer active");
        const q = await storeQuota(link.orgId);
        if (q.state === "full") throw new Error(overQuotaMessage(q.storeName, q, 0));
        const headroom = q.remainingBytes === null ? Infinity : q.remainingBytes;
        return {
          maximumSizeInBytes: Math.max(1, Math.min(100 * 1024 * 1024, headroom)),
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // Rows are recorded by the /record call from the sender's browser.
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
