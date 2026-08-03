// Server-side composition of the EOD client email - same template the EOD
// page previews (MM/DD/YY - Daily Updates, separators, renumbered around
// skipped systems), with each system heading linking back to its portal page
// so replies migrate into discussions instead of reply-all email.
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments, eodUpdates, people } from "@/db/schema";

const SEP = "-".repeat(50);
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const appUrl = () =>
  process.env.APP_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");

export async function composeEodEmail(date: string, dateMDY: string): Promise<{
  subject: string; html: string; filled: number; total: number;
}> {
  const [rows, saved, roster] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.archived, false)).orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(eodUpdates).where(eq(eodUpdates.date, date)),
    db.select().from(people),
  ]);
  // Sierra's report covers Sierra-led work; LabZen-led systems are theirs.
  const labzenLed = new Set(roster.filter((p) => p.org === "labzen").map((p) => p.name));
  const active = rows.filter((i) => !i.stages.includes("Shipped") && !labzenLed.has(i.lead));
  const included = active.filter((i) => !saved.find((s) => s.instrumentId === i.id)?.skipped);
  const url = appUrl();

  let filled = 0;
  const blocks = included.map((i, idx) => {
    const u = saved.find((s) => s.instrumentId === i.id);
    if (u?.systemUpdate || u?.actionItem) filled++;
    const label = esc(`${i.externalId} - ${i.model}`);
    const heading = url
      ? `<a href="${url}/instruments/${i.id}" style="color:#1D6396;">System ${idx + 1}: ${label}</a>`
      : `System ${idx + 1}: ${label}`;
    return `${heading}\n\nSystem Update: ${esc(u?.systemUpdate ?? "")}\nAction Item: ${esc(u?.actionItem ?? "")}\n\n${SEP}`;
  });

  const body = [`${dateMDY} - Daily Updates`, "", SEP, ...blocks].join("\n");
  const html = `
    <pre style="font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;color:#172A4A;margin:0;">${body}</pre>
    ${url ? `<div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#64748B;margin-top:16px;">Questions on a system? Tap its heading and reply in the portal - it keeps everyone on the same page. General topics: <a href="${url}/discussions">${url.replace(/^https?:\/\//, "")}/discussions</a></div>` : ""}`;

  return { subject: `Sierra Spectra - Daily Updates ${dateMDY}`, html, filled, total: included.length };
}
