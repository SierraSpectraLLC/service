import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgs } from "@/db/schema";
import { getModules } from "@/lib/flags";
import { myTenantOrgId, requireStaff } from "@/lib/authz";
import { composeDigest, composePartnerDigest } from "@/lib/digest";
import { previewPage } from "@/lib/emailPreview";
import { digestRecipientList } from "@/lib/digest";
import { houseEmails } from "@/lib/house";

export const dynamic = "force-dynamic";

/**
 * The digest, rendered in the browser instead of sent - real data, no email.
 * This is how you find out an edition needs work BEFORE a client reads it.
 *
 *   /api/digest/preview            the internal edition, as staff receive it
 *   /api/digest/preview?org=<id>   that organization's partner edition
 *
 * Staff only, and scoped like the send: a staff member previews their own
 * workspace's digest, and only their own workspace's organizations.
 *
 * The mail is rendered in an iframe at 600px and 320px - the exact bytes that
 * would be sent, not a web-styled restatement of them - with the subject and
 * the real recipient list above, so the preview can never be mistaken for
 * (or leak as) the mail itself.
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
  let to: string[];
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
    to = digestRecipientList(org.digestRecipients);
    note = `Partner edition for ${org.name}.${to.length ? "" : " No recipients configured - this edition is NOT being sent."}`;
  } else {
    composed = await composeDigest(tenant);
    to = await houseEmails(tenant);
    note = "Internal edition - what your own staff receive each morning.";
  }

  return new NextResponse(previewPage({ subject: composed.subject, to, html: composed.html, note }), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
