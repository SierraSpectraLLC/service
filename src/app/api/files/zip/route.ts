import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { mayReadAttachment } from "@/lib/fileAccess";
import { buildZip } from "@/lib/zip";

export const dynamic = "force-dynamic";

/**
 * A selection, downloaded as one archive.
 *
 * Per-file authorization is mayReadAttachment - the exact gate /api/files runs
 * for singles - so zipping is never a wider door than downloading one at a
 * time, just a shorter queue. One unauthorized id fails the WHOLE request
 * rather than shipping a partial archive: silence about a skipped file would
 * read as "got everything".
 */
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_FILES = 100;

export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return new NextResponse(null, { status: 404 });
  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => parseInt(s)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length || ids.length > MAX_ZIP_FILES) return new NextResponse(null, { status: 400 });
  const files = await db.select().from(attachments).where(inArray(attachments.id, ids));
  if (files.length !== ids.length) return new NextResponse(null, { status: 404 });
  for (const f of files) {
    if (!(await mayReadAttachment(f))) return new NextResponse(null, { status: 404 });
  }
  if (files.reduce((n, f) => n + f.size, 0) > MAX_ZIP_BYTES) {
    return NextResponse.json({ error: "Selection is too large for one zip" }, { status: 413 });
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
      "content-disposition": `attachment; filename="files.zip"`,
      "content-length": String(zip.length),
    },
  });
}
