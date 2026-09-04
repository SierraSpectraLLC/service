import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { houseOwnerEmails } from "@/lib/house";
import { ACTIVE_DAYS, QUIET_DAYS, daysAgo, rollup } from "@/lib/loginLog";
import { loginsSince } from "@/lib/loginLogData";
import { notifyUsageReport } from "@/lib/notify";

/**
 * The weekly "is anybody using this" mail.
 *
 * Core rather than an optional module, like renewals: an instance nobody has
 * signed into produces no report, so there is nothing to switch off. Weekly
 * because usage is a trend - a daily version would be a graph drawn one pixel
 * at a time, and the interesting movement (somebody stopped coming) takes
 * weeks to be real.
 *
 * One report per operator: on a multi-tenant instance each service company is
 * told about its own people, never about another company's.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const now = new Date();
    // A quarter back, so "dormant" is measured against a real history rather
    // than against the width of the window we happened to read.
    const events = await loginsSince(daysAgo(now, 120), 5000);
    const accounts = await db.select({
      email: users.email, name: users.name, role: users.role,
      lastSeenAt: users.lastSeenAt, passwordHash: users.passwordHash,
      onboardedAt: users.onboardedAt,
    }).from(users);

    // Group by the operator each login was recorded against. Accounts carry no
    // operator of their own, so they join through their events; anybody with no
    // event at all is nobody's report to send.
    const operators = [...new Set(events.map((e) => e.operatorOrgId))];
    if (!operators.length) return NextResponse.json({ sent: 0, reason: "no sign-ins on record" });

    let sent = 0;
    for (const operatorOrgId of operators) {
      const mine = events.filter((e) => e.operatorOrgId === operatorOrgId);
      const emails = new Set(mine.map((e) => e.email.toLowerCase()));
      const rows = rollup(
        accounts
          .filter((a) => emails.has(a.email.toLowerCase()))
          .map((a) => ({ ...a, hasPassword: !!a.passwordHash })),
        mine,
        now,
      );
      // The owners: who is using the portal is theirs to watch, not the shop's.
      const to = await houseOwnerEmails(operatorOrgId);
      if (!to.length) continue;
      await notifyUsageReport({
        to,
        active: rows.filter((r) => r.status === "active"),
        dormant: rows.filter((r) => r.status === "dormant"),
        logins: mine.filter((e) => e.createdAt >= daysAgo(now, ACTIVE_DAYS)).length,
        now,
      });
      sent++;
    }
    return NextResponse.json({ sent, people: accounts.length, activeWindowDays: ACTIVE_DAYS, quietAfterDays: QUIET_DAYS });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
