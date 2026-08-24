import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { houseMembers, notifications, notificationPrefs, users } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopTime } from "@/lib/shopday";
import InboxPanel from "@/components/InboxPanel";
import SignInSettings from "@/components/SignInSettings";
import HomeBaseCard from "@/components/HomeBaseCard";
import { isStaffRole } from "@/lib/tenants";
import { smsConfigured } from "@/lib/sms";

export const dynamic = "force-dynamic";

/**
 * Everything the platform has told this person, plus the switches for which
 * of it also emails them. Scoped by sign-in email - there is no id or query
 * param, so there is nothing to probe.
 */
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ kind?: string; unread?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const filter = await searchParams;
  const email = user.email.toLowerCase();

  const [items, prefs, [me]] = await Promise.all([
    db.select().from(notifications)
      .where(eq(notifications.email, email))
      .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(100),
    db.select({ kind: notificationPrefs.kind, emailOn: notificationPrefs.emailOn })
      .from(notificationPrefs).where(eq(notificationPrefs.email, email)),
    // How this person gets in, which belongs on the one page that is already
    // theirs rather than in Settings, which is about the instance.
    db.select({ hash: users.passwordHash, phone: users.phone }).from(users).where(eq(users.email, email)),
  ]);
  // The trip's starting point, for staff who drive. A client login has no
  // house row and no trips, so the card simply is not there for them.
  const [mine] = isStaffRole(user.role)
    ? await db.select({ homeAddress: houseMembers.homeAddress, homeLat: houseMembers.homeLat })
        .from(houseMembers).where(eq(houseMembers.email, email))
    : [];

  return (
    <div className="container page">
      <InboxPanel
        items={items.map((n) => ({
          id: n.id, kind: n.kind, title: n.title, href: n.href,
          when: shopTime(n.createdAt), read: n.readAt !== null,
        }))}
        prefs={prefs}
        filter={{ kind: filter.kind, unread: filter.unread }}
      />
      {mine && <HomeBaseCard address={mine.homeAddress} placed={mine.homeLat !== null} />}
      <SignInSettings
        name={user.name} email={user.email}
        hasPassword={!!me?.hash}
        phone={me?.phone ?? ""}
        smsConfigured={smsConfigured()}
      />
    </div>
  );
}
