import { NextResponse } from "next/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { agreements, orgs, quoteLines, quotes, rateCards } from "@/db/schema";
import { KIND_LABEL, allowance, needsAttention, renewalLine, standing } from "@/lib/agreements";
import { usageFor } from "@/lib/agreementUsage";
import { houseEmails } from "@/lib/house";
import { formatCents } from "@/lib/money";
import { notifyRenewalDue } from "@/lib/notify";
import { shopToday } from "@/lib/shopday";
import { addDays } from "@/lib/pm";
import { audit } from "@/lib/audit";
import { forTenant } from "@/lib/tenancy";
import { nextWoNumber } from "@/lib/workOrders";
import { resolveRate } from "@/lib/rates";
import { renewalFromBurn } from "@/lib/quotes";

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

    const orgIds = [...new Set(due.flatMap(
      (a) => [a.orgId, a.providerOrgId].filter((x): x is number => x !== null)))];
    const orgRows = orgIds.length
      ? await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(inArray(orgs.id, orgIds))
      : [];

    let sent = 0;
    let drafted = 0;
    for (const a of due) {
      // Whoever services them - the agreement's own workspace, not the
      // instance's. On a two-operator instance each company chases its own.
      const to = await houseEmails(a.tenantOrgId);
      if (!to.length) continue;
      const used = await usageFor(a, a.orgId).catch(
        () => ({ partsCents: 0, visits: 0, laborMinutes: 0 }),
      );
      const parts = allowance(a.partsAllowanceCents, used.partsCents);
      const visits = allowance(a.visitsIncluded, used.visits);
      await notifyRenewalDue({
        to, orgId: a.orgId,
        orgName: orgRows.find((o) => o.id === a.orgId)?.name ?? "a client",
        label: [a.number, a.title].filter(Boolean).join(" ") || KIND_LABEL[a.kind],
        // Whose paper, when it is not ours - otherwise a notice about a
        // manufacturer's contract reads as a notice about one of ours.
        line: `${standing(a, today) === "expired" ? "Expired" : "Up for renewal"}${
          a.providerOrgId === null ? "" : ` (held by ${
            orgRows.find((o) => o.id === a.providerOrgId)?.name ?? "another company"})`
        }. ${renewalLine(a, today)}`,
        parts: parts.tracked ? `${formatCents(parts.used)} of ${formatCents(parts.included)} parts` : "",
        visits: visits.tracked ? `${visits.used} of ${visits.included} visits` : "",
      });
      sent++;

      /* And draft the renewal itself, prefilled from what the term actually
         cost to serve. The argument for a price is the burn - "you used six
         visits and $4,900 of parts" is a conversation, and "our rates went up"
         is not. Once per agreement: a second draft every week would bury the
         first one nobody has sent yet.

         Never for somebody else's paper. The NOTICE above is worth sending -
         a client whose manufacturer contract lapses in sixty days is the best
         lead this workspace will get all quarter, and it goes to our own staff
         rather than to them. Quoting a renewal of it is not ours to do: the
         burn would be zero (none of that work is in this record) and the quote
         would be an offer to renew a contract we do not hold. */
      if (a.providerOrgId === null && await draftRenewalQuote(a, used).catch(() => false)) drafted++;
    }
    return NextResponse.json({ sent, drafted, checked: all.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * The renewal draft, priced off the term's actual burn.
 *
 * A quote rather than a notification, because the thing that gets renewals
 * signed is a number somebody can say yes to, and the thing that stops them is
 * having to build one. It is left as a DRAFT: what to charge for next year is
 * a decision, and a cron that mails a client a price nobody looked at is a
 * cron that will eventually mail the wrong one.
 */
async function draftRenewalQuote(
  a: typeof agreements.$inferSelect,
  used: { partsCents: number; visits: number; laborMinutes: number },
): Promise<boolean> {
  const existing = await db.select().from(quotes)
    .where(and(eq(quotes.agreementId, a.id), ne(quotes.status, "declined")));
  if (existing.length) return false;

  const cards = await db.select().from(rateCards);
  const rate = resolveRate(cards, { orgId: a.orgId, agreementId: a.id });
  const burn = renewalFromBurn({
    visitsUsed: used.visits,
    partsCents: used.partsCents,
    laborMinutes: used.laborMinutes,
    hourlyCents: rate.hourlyCents,
  });
  if (burn.valueCents <= 0) return false;

  const today = shopToday();
  for (let attempt = 0; attempt < 4; attempt++) {
    const inUse = await db.select({ number: quotes.number }).from(quotes)
      .where(forTenant(quotes.tenantOrgId, a.tenantOrgId));
    const number = nextWoNumber(inUse.map((r) => r.number), "Q-");
    try {
      const [q] = await db.insert(quotes).values({
        tenantOrgId: a.tenantOrgId, orgId: a.orgId, agreementId: a.id,
        number, status: "draft",
        title: `Renewal of ${[a.number, a.title].filter(Boolean).join(" ") || "the service agreement"}`,
        expiresOn: addDays(today, 45),
        note: `Prefilled from the term's actual burn: ${burn.basis}.`,
        createdBy: "renewals cron",
      }).returning();
      await db.insert(quoteLines).values([
        {
          // A bundled charge, not an hour: rendering this as labor would put
          // "1 h" beside a year of scheduled service.
          quoteId: q.id, kind: "fee_ref",
          description: `${burn.visits} visit${burn.visits === 1 ? "" : "s"} of scheduled service`,
          detail: burn.basis,
          qty: 1000, unitCents: burn.valueCents - burn.partsCents, covered: false, position: 0,
        },
        ...(burn.partsCents > 0 ? [{
          quoteId: q.id, kind: "part",
          description: "Parts allowance",
          detail: `matched to last term's ${formatCents(burn.partsCents)} of parts`,
          qty: 1000, unitCents: burn.partsCents, covered: false, position: 1,
        }] : []),
      ]);
      await audit({
        actor: "renewals cron", entityType: "quote", entityId: q.id, tenantOrgId: a.tenantOrgId,
        action: `drafted ${number}, a renewal of ${a.number || "the agreement"} at ${formatCents(burn.valueCents)}`
          + ` - prefilled from ${burn.basis}`,
      });
      return true;
    } catch { /* number raced; take the next one */ }
  }
  return false;
}
