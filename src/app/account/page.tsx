import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications, users } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { navSection } from "@/lib/navData";
import SectionShell from "@/components/SectionShell";
import { HubCard, HubGrid } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * A person's own settings - the area the app did not have.
 *
 * /settings/* is entirely organizational: the catalog, the tenants, the
 * billing, the procedures, the trail. So "Settings" in the account menu opened
 * the company's configuration, "Notifications & email" opened the inbox, and
 * somebody looking for their own name, their own password or their own
 * paystubs had three different wrong answers and no right one. This is the
 * right one, and it exists for every signed-in role.
 */
const BLURB: Record<string, string> = {
  "/account/profile": "Your name, your number, where you start the day",
  "/account/security": "Password, sign-in codes, how you get back in",
  "/account/notifications": "Which events reach you, and on which channel",
  "/account/pay": "Your own paystubs and what the company holds",
};

export default async function AccountPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const section = await navSection("account");
  if (!section) redirect("/");

  const email = user.email.toLowerCase();
  // Two cheap signals, both caught: a hub that cannot count still names the
  // rooms, which is the honest failure the whole shell uses.
  const [me] = await db.select({ hash: users.passwordHash, name: users.name })
    .from(users).where(eq(users.email, email)).catch(() => []);
  const unread = await db.select({ id: notifications.id }).from(notifications)
    .where(and(eq(notifications.email, email), isNull(notifications.readAt)))
    .catch(() => []);

  const signal = (href: string) =>
    href === "/account/security" && me && !me.hash
      // Not a scolding: codes by email work and always have. It is worth
      // saying because the day email stops arriving is the day it matters,
      // and that is not the day to find out there was a switch.
      ? { text: "No password set", tone: "warn" as const }
      : href === "/account/notifications" && unread.length
        ? { text: `${unread.length} unread`, tone: "info" as const }
        : href === "/account/profile" && me && !me.name
          ? { text: "No name yet", tone: "warn" as const }
          : undefined;

  return (
    <SectionShell section={section} active={section.href}
      title="Account" sub={user.email}>
      <HubGrid>
        {section.items.map((i) => {
          const sig = signal(i.href);
          return (
            <HubCard key={i.href} href={i.href} title={i.label}
              sub={BLURB[i.href] ?? "Your organization's own configuration"}
              signal={sig?.text} tone={sig?.tone} />
          );
        })}
      </HubGrid>
    </SectionShell>
  );
}
