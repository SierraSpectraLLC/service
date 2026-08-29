import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopTime } from "@/lib/shopday";
import InboxPanel from "@/components/InboxPanel";

export const dynamic = "force-dynamic";

/**
 * Everything the platform has told this person. Scoped by sign-in email -
 * there is no id or query param, so there is nothing to probe.
 *
 * It used to carry three other things as well: the email switches, the sign-in
 * controls and a staff member's home base. All three were here because the app
 * had no user-level settings area at all, so a person's own name and password
 * lived under their mail. They are rooms of /account now - the inbox is the
 * mail, which is the only thing its name ever promised.
 */
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ kind?: string; unread?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const filter = await searchParams;
  const email = user.email.toLowerCase();

  const items = await db.select().from(notifications)
    .where(eq(notifications.email, email))
    .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(100);

  return (
    <div className="container page">
      <InboxPanel
        items={items.map((n) => ({
          id: n.id, kind: n.kind, title: n.title, href: n.href,
          when: shopTime(n.createdAt), read: n.readAt !== null,
        }))}
        filter={{ kind: filter.kind, unread: filter.unread }}
      />
    </div>
  );
}
