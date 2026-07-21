import { asc, desc } from "drizzle-orm";
import { db } from "@/db";
import { instruments, instrumentGases, parts, auditLog } from "@/db/schema";
import { GAS_COLOR, gasAttention, partOpen } from "@/lib/stages";
import { parseList } from "@/auth";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pill = (text: string, bg: string, fg: string) =>
  `<span style="display:inline-block;font-size:11px;font-weight:bold;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-family:Helvetica,Arial,sans-serif;">${esc(text)}</span>`;

/**
 * Compose the daily fleet-status email: every system with stages, gas
 * statuses, and open parts; anything needing gas gets called out on top.
 */
export async function composeDigest(): Promise<{ subject: string; html: string }> {
  const rows = await db.select().from(instruments).orderBy(asc(instruments.priority), asc(instruments.externalId));
  const gases = await db.select().from(instrumentGases);
  const allParts = await db.select().from(parts);
  const recent = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(300);

  const attention: string[] = [];
  const body = rows.map((i) => {
    const g = gases.filter((x) => x.instrumentId === i.id);
    const openParts = allParts.filter((p) => p.instrumentId === i.id && partOpen(p.status)).length;
    const last = recent.find((a) => a.instrumentId === i.id);
    const issues = g.filter((x) => gasAttention(x.status));
    for (const x of issues) {
      attention.push(`<b>${esc(i.externalId)}</b> - ${esc(x.gas)}: ${esc(x.status)}${x.note ? ` <span style="color:#64748B;">(${esc(x.note)})</span>` : ""}`);
    }
    const gasCells = g.length
      ? g.map((x) => {
          const c = GAS_COLOR[x.status] || { bg: "#EEF1F5", fg: "#475569" };
          return pill(`${x.gas}: ${x.status}`, c.bg, c.fg);
        }).join(" ")
      : `<span style="color:#94A3B8;">-</span>`;
    return `
      <tr>
        <td style="padding:8px 10px;border-top:1px solid #E2E8F0;font-family:Menlo,Consolas,monospace;font-size:12px;font-weight:bold;color:#172A4A;white-space:nowrap;vertical-align:top;">${esc(i.externalId)}</td>
        <td style="padding:8px 10px;border-top:1px solid #E2E8F0;font-family:Helvetica,Arial,sans-serif;font-size:13px;vertical-align:top;">
          ${esc(i.model)}<br/>
          <span style="font-size:11px;color:#64748B;">${esc(i.client)} &middot; P${i.priority}${i.notes ? ` &middot; ${esc(i.notes)}` : ""}</span>
          ${last ? `<br/><span style="font-size:11px;color:#94A3B8;">Last: ${esc(last.action)} - ${esc(last.actor.split("@")[0])}</span>` : ""}
        </td>
        <td style="padding:8px 10px;border-top:1px solid #E2E8F0;font-family:Helvetica,Arial,sans-serif;font-size:12px;vertical-align:top;">${i.stages.map((s) => esc(s)).join(", ")}</td>
        <td style="padding:8px 10px;border-top:1px solid #E2E8F0;vertical-align:top;line-height:1.9;">${gasCells}</td>
        <td style="padding:8px 10px;border-top:1px solid #E2E8F0;font-family:Helvetica,Arial,sans-serif;font-size:12px;vertical-align:top;white-space:nowrap;">${openParts ? `${openParts} open` : `<span style="color:#94A3B8;">-</span>`}</td>
      </tr>`;
  }).join("");

  const attentionBlock = attention.length
    ? `<div style="background:#FBE9E9;border:1px solid #E8B4B4;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#A32D2D;">
         <b>Gas attention (${attention.length})</b><br/>${attention.join("<br/>")}
       </div>`
    : `<div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#0F6E56;margin-bottom:16px;">All gas requirements OK.</div>`;

  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
  const html = `
<body style="background:#F4F6F9;margin:0;padding:20px 0;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:680px;margin:auto;background:#fff;border-radius:12px;border:1px solid #E2E8F0;">
    <tr><td style="height:4px;border-radius:12px 12px 0 0;background:#172A4A;"></td></tr>
    <tr><td style="padding:18px 20px 6px;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-weight:bold;font-size:16px;color:#172A4A;letter-spacing:0.3px;">SIERRA SPECTRA</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#64748B;margin-bottom:14px;">Daily system status &middot; ${today}</div>
      ${attentionBlock}
      <table width="100%" border="0" cellspacing="0" cellpadding="0">
        <tr>
          ${["ID", "System", "Stages", "Gases", "Parts"].map((h) => `<th align="left" style="padding:6px 10px;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:0.5px;">${h}</th>`).join("")}
        </tr>
        ${body}
      </table>
    </td></tr>
    <tr><td style="padding:12px 20px 18px;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#94A3B8;">Sent daily by the instrument tracker. Statuses live on each system's page.</td></tr>
  </table>
</body>`;

  const subject = attention.length
    ? `System status: ${attention.length} gas issue${attention.length === 1 ? "" : "s"} - ${today}`
    : `System status: all clear - ${today}`;
  return { subject, html };
}

/** Compose and email the digest to all staff via Resend. */
export async function runDailyDigest(): Promise<{ sent: boolean; to: string[]; subject: string }> {
  const to = parseList(process.env.STAFF_EMAILS);
  if (!to.length) throw new Error("STAFF_EMAILS is empty");
  const { subject, html } = await composeDigest();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AUTH_RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, html }),
  });
  if (!res.ok) throw new Error("Resend error: " + JSON.stringify(await res.json()));
  return { sent: true, to, subject };
}
