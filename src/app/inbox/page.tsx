import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { notifications, notificationPrefs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopTime } from "@/lib/shopday";
import InboxPanel from "@/components/InboxPanel";

export const dynamic = "force-dynamic";

/**
 * Everything the platform has told this person, plus the switches for which
 * of it also emails them. Scoped by sign-in email - there is no id or query
 * param, so there is nothing to probe.
 */
export default async function InboxPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const email = user.email.toLowerCase();

  const [items, prefs] = await Promise.all([
    db.select().from(notifications)
      .where(eq(notifications.email, email))
      .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(100),
    db.select({ kind: notificationPrefs.kind, emailOn: notificationPrefs.emailOn })
      .from(notificationPrefs).where(eq(notificationPrefs.email, email)),
  ]);

  return (
    <div className="container page">
      <InboxPanel
        items={items.map((n) => ({
          id: n.id, kind: n.kind, title: n.title, href: n.href,
          when: shopTime(n.createdAt), read: n.readAt !== null,
        }))}
        prefs={prefs}
      />
    </div>
  );
}
