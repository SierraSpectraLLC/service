import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { requireEditor } from "@/lib/authz";
import { mayReadAttachment } from "@/lib/fileAccess";
import { tenantOfAsset, tenantOfSystem } from "@/lib/tenancy";
import { combinePdfs, looksLikePdf } from "@/lib/pdfCombine";
import { audit } from "@/lib/audit";
import { getBrand } from "@/lib/brand";
import { shopTime } from "@/lib/shopday";

export const dynamic = "force-dynamic";
// Combining a validation binder is real work for a function; give it room.
export const maxDuration = 60;

const MAX_ITEMS = 25;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024; // Blob fetches + pdf-lib copies fit comfortably in memory

type Body = {
  items: { attachmentId: number; title: string }[];
  coverTitle?: string;
  coverLines?: string[];
  pageNumbers?: boolean;
  headers?: boolean;
  /** Save the result back as an attachment instead of downloading it. */
  saveAs?: { fileName: string; instrumentId: number | null; assetId: number | null } | null;
};

/**
 * Merge chosen PDF attachments into one packet. Editors only (viewers can
 * read the sources individually; composing a new document is authoring), and
 * every source file passes the same per-file gate the download proxy uses -
 * a combiner that skipped it would be a way to read files by id.
 */
export async function POST(req: Request) {
  let user;
  try { user = await requireEditor(); } catch { return NextResponse.json({ error: "Not found" }, { status: 404 }); }

  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }
  const items = (body.items ?? []).filter((i) => Number.isInteger(i.attachmentId));
  if (!items.length) return NextResponse.json({ error: "Pick at least one PDF" }, { status: 400 });
  if (items.length > MAX_ITEMS) return NextResponse.json({ error: `Combine up to ${MAX_ITEMS} files at a time` }, { status: 400 });

  const rows = await db.select().from(attachments)
    .where(inArray(attachments.id, items.map((i) => i.attachmentId)));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const sources: { bytes: Uint8Array; title: string; name: string }[] = [];
  let totalBytes = 0;
  for (const item of items) {
    const file = byId.get(item.attachmentId);
    // Missing and forbidden answer identically - a file's existence is
    // itself information (same posture as the download proxy).
    if (!file || !(await mayReadAttachment(file))) {
      return NextResponse.json({ error: "One of the selected files is not available" }, { status: 404 });
    }
    const res = await fetch(file.url);
    if (!res.ok) return NextResponse.json({ error: `${file.fileName} could not be fetched from storage` }, { status: 502 });
    const bytes = new Uint8Array(await res.arrayBuffer());
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: "Those files add up past 40MB - combine them in two passes" }, { status: 413 });
    }
    if (!looksLikePdf(bytes)) {
      return NextResponse.json({ error: `${file.fileName} isn't a PDF` }, { status: 400 });
    }
    sources.push({ bytes, title: (item.title ?? "").trim().slice(0, 120), name: file.fileName });
  }

  let combined: Uint8Array;
  try {
    combined = await combinePdfs(sources, {
      coverTitle: (body.coverTitle ?? "").trim().slice(0, 120),
      coverLines: (body.coverLines ?? []).map((l) => String(l).trim().slice(0, 120)).filter(Boolean).slice(0, 8),
      pageNumbers: body.pageNumbers !== false,
      headers: body.headers !== false,
    });
  } catch (e) {
    // Encrypted or corrupt sources land here; name the failure, not a stack.
    return NextResponse.json({ error: `Couldn't combine: ${(e as Error).message}` }, { status: 422 });
  }

  if (body.saveAs) {
    // The packet becomes an ordinary attachment on the system or unit it
    // documents, so it shows in Files and can be evidence like anything else.
    const home = body.saveAs.instrumentId ?? body.saveAs.assetId;
    if (home === null) return NextResponse.json({ error: "Say which system or unit the packet belongs to" }, { status: 400 });
    const { put } = await import("@vercel/blob");
    const fileName = (body.saveAs.fileName || "combined.pdf").replace(/[^\w.\- ]/g, "").slice(0, 80) || "combined.pdf";
    const blob = await put(fileName, Buffer.from(combined), { access: "public", addRandomSuffix: true });
    // The packet belongs to the workspace of the record it documents, not to
    // whoever combined it - see lib/tenants.
    const tenantOrgId = body.saveAs.instrumentId !== null
      ? await tenantOfSystem(body.saveAs.instrumentId)
      : await tenantOfAsset(body.saveAs.assetId!);
    const [row] = await db.insert(attachments).values({
      tenantOrgId,
      instrumentId: body.saveAs.instrumentId, assetId: body.saveAs.assetId,
      fileName, kind: "Report", url: blob.url, size: combined.byteLength,
      uploadedBy: user.email,
      description: `Combined packet: ${sources.map((s) => s.name).join(", ")}`.slice(0, 300),
    }).returning();
    await audit({
      actor: user.email, instrumentId: body.saveAs.instrumentId, assetId: body.saveAs.assetId,
      entityType: "attachment", entityId: row.id,
      action: `combined ${sources.length} PDF${sources.length === 1 ? "" : "s"} into '${fileName}'`,
    });
    return NextResponse.json({ saved: true, attachmentId: row.id });
  }

  const brand = await getBrand();
  const stamp = shopTime(new Date()).replace(/[,:]/g, "").replace(/\s+/g, "-");
  return new NextResponse(Buffer.from(combined), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${brand.name.replace(/[^\w]+/g, "-")}-packet-${stamp}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
