import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/authz";

/**
 * Server-relay upload: the browser POSTs the file to our own domain and the
 * server forwards it to Blob. Exists because some networks (DNS/content
 * blockers, VPNs, middleboxes) block the browser -> blob.vercel-storage.com
 * leg entirely, while same-origin requests and server -> Blob both work.
 * Capped at 4 MB by Vercel's request-body limit - larger files must use the
 * direct client upload.
 */
const MAX_RELAY_BYTES = 4 * 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  const u = await currentUser();
  if (!u || u.role === "client_viewer") {
    return NextResponse.json({ error: "Not allowed to upload" }, { status: 403 });
  }
  const filename = new URL(request.url).searchParams.get("filename")?.trim() || "upload.bin";
  const declared = parseInt(request.headers.get("content-length") || "0", 10);
  if (declared > MAX_RELAY_BYTES) {
    return NextResponse.json({ error: "Relay uploads are limited to 4 MB" }, { status: 413 });
  }
  try {
    const body = await request.arrayBuffer();
    if (!body.byteLength) return NextResponse.json({ error: "Empty file" }, { status: 400 });
    if (body.byteLength > MAX_RELAY_BYTES) {
      return NextResponse.json({ error: "Relay uploads are limited to 4 MB" }, { status: 413 });
    }
    const blob = await put(filename, body, { access: "public", addRandomSuffix: true });
    return NextResponse.json({ url: blob.url });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
