import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agreements, orgs } from "@/db/schema";
import { KIND_LABEL, allowance, needsAttention, renewalLine, standing } from "@/lib/agreements";
import { usageFor } from "@/lib/agreementUsage";
import { houseEmails } from "@/lib/house";
import { formatCents } from "@/lib/money";
import { notifyRenewalDue } from "@/lib/notify";
import { shopToday } from "@/lib/shopday";

/**
 * Tell the shop about contracts running out.
 *
 * Like PM generation, this is core rather than an optional module: an instance
 * with no agreements on file does nothing here, so there is nothing to switch
 * off. Expired ones are included as well as expiring: a contract that lapsed
 * three weeks ago is a more urgent conversation than one lapsing in six, and it
 * is exactly the one nobody notices.
 *
 * Runs weekly, and deliberately repeats while the window is open rather than
 * firing once. See notifyRenewalDue.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const today = shopToday();
    const all = await db.select().from(agreements);
    const due = needsAttention(all, today);
    if (!due.length) return NextResponse.json({ sent: 0, checked: all.length });

    const orgIds = [...new Set(due.map((a) => a.orgId))];
    const orgRows = orgIds.length
      ? await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(inArray(orgs.id, orgIds))
      : [];

    let sent = 0;
    for (const a of due) {
      // Whoever services them - the agreement's own workspace, not the
      // instance's. On a two-operator instance each company chases its own.
      const to = await houseEmails(a.tenantOrgId);
      if (!to.length) continue;
      const used = await usageFor(a, a.orgId).catch(() => ({ partsCents: 0, visits: 0, laborMinutes: 0 }));
      const parts = allowance(a.partsAllowanceCents, used.partsCents);
      const visits = allowance(a.visitsIncluded, used.visits);
      await notifyRenewalDue({
        to, orgId: a.orgId,
        orgName: orgRows.find((o) => o.id === a.orgId)?.name ?? "a client",
        label: [a.number, a.title].filter(Boolean).join(" ") || KIND_LABEL[a.kind],
        line: `${standing(a, today) === "expired" ? "Expired" : "Up for renewal"}. ${renewalLine(a, today)}`,
        parts: parts.tracked ? `${formatCents(parts.used)} of ${formatCents(parts.included)} parts` : "",
        visits: visits.tracked ? `${visits.used} of ${visits.included} visits` : "",
      });
      sent++;
    }
    return NextResponse.json({ sent, checked: all.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
