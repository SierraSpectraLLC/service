import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, instrumentGases, instruments, orgs, parts } from "@/db/schema";
import { GAS_COLOR, gasAttention, partOpen } from "@/lib/stages";
import { houseEmails } from "@/lib/house";
import { sendEmail } from "@/lib/email";
import { brandForTenant } from "@/lib/brand";
import { emailShell, esc } from "@/lib/emailTheme";

const pill = (text: string, bg: string, fg: string) =>
  `<span style="display:inline-block;font-size:11px;font-weight:bold;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-family:Helvetica,Arial,sans-serif;">${esc(text)}</span>`;

/**
 * Compose the daily fleet-status email: every system with stages, gas
 * statuses, and open parts; anything needing gas gets called out on top.
 */
export async function composeDigest(tenantOrgId: number | null = null): Promise<{ subject: string; html: string }> {
  // The digest is one service company's own status report, so it carries that
  // company's name and covers only its fleet - not the instance's.
  const brand = await brandForTenant(tenantOrgId);
  const mine = tenantOrgId === null ? undefined : eq(instruments.tenantOrgId, tenantOrgId);
  const rows = await db.select().from(instruments)
    .where(and(eq(instruments.archived, false), mine))
    .orderBy(asc(instruments.priority), asc(instruments.externalId));
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

  const today = new Date().toLocaleDateString("en-US", { timeZone: process.env.SHOP_TZ || "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
  const preheader = attention.length
    ? `${attention.length} gas issue${attention.length === 1 ? "" : "s"} across ${rows.length} system${rows.length === 1 ? "" : "s"}.`
    : `All gas requirements OK across ${rows.length} system${rows.length === 1 ? "" : "s"}.`;
  const html = emailShell({
    brand: brand.operatorName,
    logoUrl: brand.operatorLogoUrl || undefined,
    tagline: `Daily system status · ${today}`,
    preheader,
    width: 680,
    body: `${attentionBlock}
      <table width="100%" border="0" cellspacing="0" cellpadding="0">
        <tr>
          ${["ID", "System", "Stages", "Gases", "Parts"].map((h) => `<th align="left" style="padding:6px 10px;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:0.5px;">${h}</th>`).join("")}
        </tr>
        ${body}
      </table>`,
    footer: `Sent daily by ${esc(brand.name)}. Statuses live on each system's page.`,
  });

  const subject = attention.length
    ? `System status: ${attention.length} gas issue${attention.length === 1 ? "" : "s"} - ${today}`
    : `System status: all clear - ${today}`;
  return { subject, html };
}

/** Compose and email the digest to all staff via Resend. */
export async function runDailyDigest(): Promise<{ sent: number; skipped: string[] }> {
  // One digest per service company on the instance, each to its own staff about
  // its own fleet. A single instance-wide digest would tell every operator the
  // state of every other operator's equipment.
  const operators = await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(eq(orgs.isOperator, true));
  const workspaces: (number | null)[] = operators.length ? operators.map((o) => o.id) : [null];
  let sent = 0;
  const skipped: string[] = [];
  for (const tenantOrgId of workspaces) {
    const to = await houseEmails(tenantOrgId);
    const who = operators.find((o) => o.id === tenantOrgId)?.name ?? "this instance";
    if (!to.length) { skipped.push(`${who}: nobody to send to`); continue; }
    const { subject, html } = await composeDigest(tenantOrgId);
    await sendEmail(to, subject, html);
    sent++;
  }
  if (!sent && !skipped.length) throw new Error("No house members configured (STAFF_EMAILS or Settings > Admin)");
  return { sent, skipped };
}
