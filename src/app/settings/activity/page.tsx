import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { clientAllowlist, orgs, users } from "@/db/schema";
import { currentUser } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { visibleOrgs } from "@/lib/tenancy";
import { daysAgo, rollup, shortAgent, type Account } from "@/lib/loginLog";
import { loginsSince } from "@/lib/loginLogData";
import { listHouseMembers } from "@/app/actions";
import UsagePanel from "@/components/UsagePanel";

export const dynamic = "force-dynamic";

/** How far back the page reads. Enough to call somebody dormant honestly. */
const WINDOW_DAYS = 120;

/**
 * Settings > Access > Usage: who signs in, how often, and who never has.
 *
 * The page exists because the password door (lib/passwordAuth) is silent - no
 * mail goes out, so an operator watching their own inbox could not tell whether
 * the portal they pay for is being opened. See lib/loginLog for why sign-ins
 * and "last seen" are two separate columns rather than one number.
 */
export default async function ActivitySettingsPage({ searchParams }: { searchParams: Promise<{ q?: string; f?: string; feed?: string }> }) {
  const filterParams = await searchParams;
  const user = await currentUser();
  if (!user) redirect("/login");
  // Owner only: this is everybody's movements, which is not a staff privilege.
  if (user.role !== "owner") redirect("/settings/catalog");
  const platform = isPlatformStaff(tenantViewer(user));

  const now = new Date();
  const [allEvents, userRows, orgRows, houseRows] = await Promise.all([
    loginsSince(daysAgo(now, WINDOW_DAYS), 5000),
    db.select({
      email: users.email, name: users.name, role: users.role,
      lastSeenAt: users.lastSeenAt, passwordHash: users.passwordHash,
      onboardedAt: users.onboardedAt,
    }).from(users).orderBy(asc(users.email)),
    visibleOrgs(user),
    listHouseMembers(),
  ]);

  // One service company's owner sees their own people, never another's. The
  // platform operator's own staff see the instance, which is theirs to run.
  const myOrgIds = new Set(orgRows.map((o) => o.id));
  const events = platform
    ? allEvents
    : allEvents.filter((e) =>
        e.operatorOrgId === user.operatorOrgId || (e.orgId !== null && myOrgIds.has(e.orgId)));
  const seen = new Set(events.map((e) => e.email.toLowerCase()));

  // Everyone with a way in, whether or not they have ever used it. An account
  // exists only after a first sign-in, so the allowlist is the only place an
  // invitation nobody accepted is visible at all - and that is the single most
  // useful line on this page.
  const allowRows = await db.select({ entry: clientAllowlist.entry, orgId: clientAllowlist.orgId, name: orgs.name })
    .from(clientAllowlist).leftJoin(orgs, eq(orgs.id, clientAllowlist.orgId));
  const knownEmails = new Set(userRows.map((u) => u.email.toLowerCase()));
  const houseEmailSet = new Set(houseRows.map((h) => h.email.toLowerCase()));

  const accounts: Account[] = [
    ...userRows
      .filter((u) => platform || seen.has(u.email.toLowerCase()) || houseEmailSet.has(u.email.toLowerCase()))
      .map((u) => ({
        email: u.email, name: u.name, role: u.role,
        lastSeenAt: u.lastSeenAt, hasPassword: !!u.passwordHash, onboardedAt: u.onboardedAt,
      })),
    // Exact addresses only: an "@acme.com" rule is a door, not a person, and
    // listing it as somebody who never signed in would be a lie about a domain.
    ...allowRows
      .filter((a) => !a.entry.trim().startsWith("@"))
      .filter((a) => !knownEmails.has(a.entry.trim().toLowerCase()))
      .filter((a) => platform || (a.orgId !== null && myOrgIds.has(a.orgId)))
      .map((a) => ({ email: a.entry.trim(), orgName: a.name ?? "", onboardedAt: null })),
  ];

  const orgById = new Map(orgRows.map((o) => [o.id, o.name]));
  const rows = rollup(accounts, events, now);
  // The org an account belongs to is only on its login events; fill it in for
  // anybody whose name we know from the allowlist instead.
  for (const r of rows) {
    if (r.orgName) continue;
    const ev = events.find((e) => e.email.toLowerCase() === r.email.toLowerCase() && e.orgId !== null);
    if (ev?.orgId != null) r.orgName = orgById.get(ev.orgId) ?? "";
  }

  return (
    <div>
      <UsagePanel
        rows={rows.map((r) => ({
          ...r,
          lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
          lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
        }))}
        recent={events.slice(0, 60).map((e) => ({
          id: e.id, email: e.email, method: e.method, orgName: e.orgName,
          role: e.role, device: shortAgent(e.userAgent), ip: e.ip,
          at: e.createdAt.toISOString(),
        }))}
        windowDays={WINDOW_DAYS}
        filter={{ q: filterParams.q ?? "", f: filterParams.f ?? "", feed: filterParams.feed ?? "" }}
      />
    </div>
  );
}
