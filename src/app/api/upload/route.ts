import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { list } from "@vercel/blob";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/authz";
import { overQuotaMessage } from "@/lib/storage";
import { storeQuota } from "@/lib/storeUsage";

/**
 * Storage health check. Proves whether the server can talk to Blob with the
 * configured token. If this is OK but a browser upload still fails, the problem
 * is the browser->Blob transfer (network/carrier), not the token/store config.
 */
export async function GET(): Promise<NextResponse> {
  const u = await currentUser();
  if (!u || u.role === "client_viewer") {
    return NextResponse.json({ ok: false, error: "not allowed" }, { status: 403 });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ ok: false, error: "BLOB_READ_WRITE_TOKEN is not set in this environment" });
  }
  try {
    await list({ limit: 1 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}

// Client-side uploads go straight to Vercel Blob; this route only mints the token.
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        const u = await currentUser();
        if (!u || u.role === "client_viewer") throw new Error("Not allowed to upload");
        // Storage ceiling, checked BEFORE the browser starts pushing bytes. A
        // full store that only failed at the record step would waste the whole
        // transfer and leave an orphaned blob nobody has a row for.
        //
        // Charged to the uploader's own store. The token can't know which record
        // the file is headed for, so a house upload onto a client's system is
        // checked against the house here and against the client in
        // recordAttachments - the strictest of the two wins, which is the safe
        // direction to be wrong in.
        const q = await storeQuota(u.orgId);
        if (q.state === "full") throw new Error(overQuotaMessage(q.storeName, q, 0));
        const headroom = q.remainingBytes === null ? Infinity : q.remainingBytes;
        return {
          // 100 MB - tune files can be chunky - or whatever is left, if less.
          maximumSizeInBytes: Math.max(1, Math.min(100 * 1024 * 1024, headroom)),
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // Metadata is recorded via the recordAttachment server action from the client.
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
