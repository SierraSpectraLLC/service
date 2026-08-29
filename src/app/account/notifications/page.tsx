import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notificationPrefs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { navSection } from "@/lib/navData";
import SectionShell from "@/components/SectionShell";
import NotificationPrefs from "@/components/NotificationPrefs";

export const dynamic = "force-dynamic";

/**
 * Which events reach you, and on which channel.
 *
 * These switches were at the foot of the inbox, under the mail they govern,
 * and the account menu's "Notifications & email" pointed at that same inbox -
 * so the one word that named the preference opened the letters instead. The
 * preference is its own room now; the inbox is the mail.
 */
export default async function AccountNotificationsPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const section = await navSection("account");
  const prefs = await db.select({ kind: notificationPrefs.kind, emailOn: notificationPrefs.emailOn })
    .from(notificationPrefs).where(eq(notificationPrefs.email, user.email.toLowerCase()))
    .catch(() => []);

  return (
    <SectionShell section={section} active="/account/notifications"
      title="Notifications"
      sub={<>Everything reaches your <Link href="/inbox">inbox</Link> either way; these decide what else happens.</>}>
      <NotificationPrefs prefs={prefs} isStaff={isStaffRole(user.role)} />
    </SectionShell>
  );
}
