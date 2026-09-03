import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { engagementRecords } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { tenantOfOrg, tenantOfSystem } from "@/lib/tenancy";
import { houseOfRecord } from "@/lib/tenants";
import { buildZip, zipNames, type ZipEntry } from "@/lib/zip";
import { canonical } from "@/lib/custody/hash";
import { createHash } from "node:crypto";
import type { SystemDossier } from "@/lib/dossier";

export const dynamic = "force-dynamic";

/**
 * A frozen record, as a file you can keep.
 *
 * The whole point of a sealed bundle is that it outlives the platform: the
 * org it was frozen for can take it away, forever, and prove it has not
 * changed. So this is the stored JSON byte-for-byte (record.json), every file
 * the dossier named that can still be fetched, and a manifest carrying the
 * sha256 the record stored at seal time - the same number the recipient of
 * the machine was given. X-Bundle-SHA256 carries it in the response too.
 *
 * Same gate as the page: yours, or staff of the workspace that wrote it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return new NextResponse(null, { status: 404 });
  const { id } = await ctx.params;
  const recId = parseInt(id);
  if (isNaN(recId)) return new NextResponse(null, { status: 404 });
  const [rec] = await db.select().from(engagementRecords).where(eq(engagementRecords.id, recId));
  if (!rec) return new NextResponse(null, { status: 404 });
  const recTenant = rec.instrumentId !== null ? await tenantOfSystem(rec.instrumentId) : await tenantOfOrg(rec.orgId);
  if (!houseOfRecord(u, recTenant) && rec.orgId !== u.orgId) return new NextResponse(null, { status: 404 });

  const json = canonical(rec.data);
  // The stored hash wins where there is one; older kinds never had one, and
  // computing it now is still a checksum somebody can verify against tomorrow.
  const sha256 = rec.bundleHash || createHash("sha256").update(json, "utf8").digest("hex");

  const dossier: SystemDossier | undefined = rec.kind === "sealed"
    ? (rec.data as { dossier?: SystemDossier }).dossier
    : (rec.data as SystemDossier);
  const wanted = dossier?.attachments ?? [];
  const files: ZipEntry[] = [];
  const missing: string[] = [];
  const names = zipNames(wanted.map((a) => `files/${a.fileName}`));
  for (const [i, a] of wanted.entries()) {
    // A blob that has gone is reported, not hidden: silence about a missing
    // file would read as "got everything".
    try {
      const res = await fetch(a.url);
      if (!res.ok) { missing.push(a.fileName); continue; }
      files.push({ name: names[i], data: new Uint8Array(await res.arrayBuffer()) });
    } catch { missing.push(a.fileName); }
  }

  const manifest = {
    recordId: rec.id, kind: rec.kind, externalId: rec.externalId, label: rec.label,
    frozenAt: rec.revokedAt.toISOString(), sha256, files: files.length, missing,
    note: "record.json is the frozen record exactly as stored; sha256 is of its canonical form (sorted keys, no whitespace).",
  };
  const zip = buildZip([
    { name: "record.json", data: new TextEncoder().encode(json) },
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
    ...files,
  ]);
  return new NextResponse(Buffer.from(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${rec.externalId || "record"}-${rec.kind}-${rec.id}.zip"`,
      "content-length": String(zip.length),
      "x-bundle-sha256": sha256,
      "cache-control": "private, no-store",
    },
  });
}
