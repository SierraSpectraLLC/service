import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { getModules } from "@/lib/flags";
import { myTenantOrgId, requireStaff } from "@/lib/authz";
import { composeDigest, composePartnerDigest } from "@/lib/digest";
import { esc } from "@/lib/emailTheme";

export const dynamic = "force-dynamic";

/**
 * The digest, rendered in the browser instead of sent - real data, no email.
 * This is how you find out an edition needs work BEFORE a client reads it.
 *
 *   /api/digest/preview            the internal edition, as staff receive it
 *   /api/digest/preview?org=<id>   that organization's partner edition
 *
 * Staff only, and scoped like the send: a staff member previews their own
 * workspace's digest, and only their own workspace's organizations. A sticky
 * banner carries the subject line and where the edition would actually go, so
 * the preview can never be mistaken for (or leak as) the mail itself.
 */
export async function GET(req: Request) {
  let user;
  try { user = await requireStaff(); } catch (e) {
    return new NextResponse((e as Error).message, { status: 403 });
  }
  if (!(await getModules()).digest) {
    return new NextResponse("The daily digest module is off for this instance (Settings > Platform).", { status: 404 });
  }
  const tenant = myTenantOrgId(user);
  const orgParam = new URL(req.url).searchParams.get("org");

  let composed: { subject: string; html: string };
  let note: string;
  if (orgParam) {
    const orgId = parseInt(orgParam, 10);
    const [org] = Number.isFinite(orgId)
      ? await db.select().from(orgs).where(eq(orgs.id, orgId))
      : [];
    if (!org || (tenant !== null && org.parentOrgId !== tenant)) {
      return new NextResponse("No such organization in your workspace.", { status: 404 });
    }
    const edition = await composePartnerDigest(tenant, orgId);
    if (!edition) {
      return new NextResponse(`${org.name} has nothing on the board today - no partner edition would be sent.`, { status: 200 });
    }
    composed = edition;
    note = `Partner edition for ${org.name}. ${org.digestRecipients
      ? `Sends daily to: ${org.digestRecipients}`
      : "No recipients configured - this edition is NOT being sent"}`;
  } else {
    composed = await composeDigest(tenant);
    note = "Internal edition - what your own staff receive each morning";
  }

  const banner = `<div style="position:sticky;top:0;z-index:1;background:#172A4A;color:#FFFFFF;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;padding:8px 14px;">
    Preview - nothing has been sent. ${esc(note)}<br/>
    <span style="opacity:0.75;">Subject: ${esc(composed.subject)}</span>
  </div>`;
  return new NextResponse(composed.html.replace(/(<body[^>]*>)/, `$1${banner}`), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
