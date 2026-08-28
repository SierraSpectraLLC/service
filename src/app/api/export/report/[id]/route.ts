import { NextResponse } from "next/server";
import { currentUser } from "@/lib/authz";
import { exportName, reportsCsv, packetName } from "@/lib/reportExport";
import { exportableReport } from "@/lib/reportExportData";
import { reportPdf, type ReceiptBlob } from "@/lib/reportPdf";
import { buildZip, zipNames } from "@/lib/zip";

export const dynamic = "force-dynamic";

/**
 * One expense report, downloaded - the thing that gets forwarded to a
 * bookkeeper.
 *
 *   ?format=pdf    the claim, its rows, and every receipt on the pages after
 *   ?format=csv    one row per expense, in dollars, for a spreadsheet
 *   ?format=zip    the CSV plus the receipt files, numbered to match it
 *
 * Three formats because accountants ask for different things and none of them
 * is a superset: the PDF is what you attach to an email, the CSV is what gets
 * imported, and the packet is what a firm's document system wants.
 *
 * WHO. lib/reportExportData.exportableReport, which runs the same gate the
 * record page does - whose claim it is, inside the tenant. A download is a
 * read, and a laxer rule here is how a claim nobody may open leaves the
 * building as a PDF.
 */
const MAX_RECEIPT_BYTES = 60 * 1024 * 1024;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return new NextResponse(null, { status: 404 });
  const id = parseInt((await params).id, 10);
  if (!Number.isInteger(id)) return new NextResponse(null, { status: 400 });

  const found = await exportableReport(u, id);
  // The same words for "no such report" and "not yours". Whether a claim
  // exists in somebody else's company is not a fact to confirm by the shape of
  // a refusal - the rule app/actions.workableReport states, restated here.
  if (!found) return new NextResponse(null, { status: 404 });
  const { report, receipts } = found;
  const format = new URL(req.url).searchParams.get("format") ?? "pdf";
  const stem = `expense-report-${report.id}-${report.person}`;

  if (format === "csv") {
    return new NextResponse(reportsCsv([report]), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${exportName(stem, "csv")}"`,
      },
    });
  }

  /* The receipts, fetched once for whichever format wants them. A blob that
     will not come back is skipped rather than sinking the download: the claim
     is still worth sending, and the row keeps its MISSING in the table, which
     is the column an auditor sorts on. fetch() THROWS on a bad scheme rather
     than returning !ok, so both have to be caught. */
  const fetched: { index: number; name: string; contentType: string; bytes: Uint8Array }[] = [];
  let budget = MAX_RECEIPT_BYTES;
  for (const r of receipts) {
    if (budget <= 0) break;
    try {
      const res = await fetch(r.url);
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > budget) continue;
      budget -= bytes.length;
      fetched.push({
        index: r.index, name: r.name,
        contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
        bytes,
      });
    } catch { continue; }
  }

  if (format === "zip") {
    // Named in the report's own row order, so the archive sorts the way the
    // sheet reads and the "Receipt file" column can be matched by eye.
    const wanted = fetched.map((f) => {
      const e = report.expenses[f.index];
      return e ? packetName(f.index, e) : f.name;
    });
    const entries = zipNames(wanted).map((name, i) => ({ name, data: fetched[i].bytes }));
    entries.unshift({
      name: exportName(stem, "csv"),
      data: new TextEncoder().encode(reportsCsv([report])),
    });
    const zip = buildZip(entries);
    return new NextResponse(Buffer.from(zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${exportName(stem, "zip")}"`,
        "content-length": String(zip.length),
      },
    });
  }

  const blobs: ReceiptBlob[] = fetched.map((f) => ({
    expenseIndex: f.index, name: f.name, contentType: f.contentType, bytes: f.bytes,
  }));
  const pdf = await reportPdf(report, blobs);
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${exportName(stem, "pdf")}"`,
      "content-length": String(pdf.length),
    },
  });
}
