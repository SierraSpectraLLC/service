import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/authz";

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
