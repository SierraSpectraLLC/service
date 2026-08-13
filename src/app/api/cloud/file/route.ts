import { NextResponse } from "next/server";
import { currentUser } from "@/lib/authz";
import { withGraph } from "@/lib/cloudStore";
import { fileStream } from "@/lib/msgraph";

export const dynamic = "force-dynamic";

/**
 * The bytes of one file out of somebody's own OneDrive.
 *
 * The studio reads a record's PDF from /api/files/<id>?raw=1 and parses it in
 * the browser; this is the same door for a file that lives at Microsoft, so the
 * component's fetch-and-parse path stays one path rather than two.
 *
 * Streamed rather than redirected, unlike the record proxy. A redirect would
 * hand the browser a Graph URL that only works with an Authorization header it
 * cannot attach, and the pre-authenticated alternative is a URL that grants the
 * file to anyone holding it - worth avoiding when the whole request is already
 * passing through here.
 *
 * Authorization is the connection itself: it is the signed-in person's own, and
 * it can reach exactly what they can reach. There is nothing to check beyond
 * "are you you", which is why this reads their email and never takes an account
 * from the query string.
 */
export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return new NextResponse(null, { status: 404 });

  const q = new URL(req.url).searchParams;
  const itemId = q.get("item") ?? "";
  const driveId = q.get("drive") ?? "";
  if (!itemId) return new NextResponse(null, { status: 404 });

  const out = await withGraph(u.email, (token) => fileStream(token, driveId, itemId));
  if (out.error) {
    // Plain text, because the only reader is a fetch() in the studio that puts
    // this straight into the source row as the reason it could not be added.
    return new NextResponse(out.error, { status: 502, headers: { "Content-Type": "text/plain" } });
  }
  if (!out.body) return new NextResponse("Microsoft sent no file.", { status: 502 });

  return new NextResponse(out.body, {
    headers: {
      "Content-Type": out.type ?? "application/pdf",
      // Somebody else's file passing through: never let a shared cache keep it.
      "Cache-Control": "private, no-store",
    },
  });
}
