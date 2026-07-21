import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { list } from "@vercel/blob";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/authz";

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
        return {
          maximumSizeInBytes: 100 * 1024 * 1024, // 100 MB - tune files can be chunky
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
