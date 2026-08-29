import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { houseMembers, users } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { navSection } from "@/lib/navData";
import SectionShell from "@/components/SectionShell";
import SignInSettings from "@/components/SignInSettings";
import HomeBaseCard from "@/components/HomeBaseCard";
import { Panel, Stack } from "@/components/ui";
import { smsConfigured } from "@/lib/sms";

export const dynamic = "force-dynamic";

/** Who you are to everybody else: the name on your assignments, and where your
    day starts. Both were settable only from the bottom of the inbox. */
export default async function AccountProfilePage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const section = await navSection("account");
  const email = user.email.toLowerCase();

  const [[me], [mine]] = await Promise.all([
    db.select({ hash: users.passwordHash, phone: users.phone, title: users.title })
      .from(users).where(eq(users.email, email)),
    // The trip's starting point, for staff who drive. A client login has no
    // house row and no trips, so the card simply is not there for them.
    isStaffRole(user.role)
      ? db.select({ homeAddress: houseMembers.homeAddress, homeLat: houseMembers.homeLat })
          .from(houseMembers).where(eq(houseMembers.email, email))
      : Promise.resolve([]),
  ]);

  return (
    <SectionShell section={section} active="/account/profile"
      title="Profile" sub="What the rest of the shop sees.">
      <Stack gap={3}>
        <SignInSettings show="name"
          name={user.name} email={user.email}
          hasPassword={!!me?.hash} phone={me?.phone ?? ""} smsConfigured={smsConfigured()} />
        {me?.title && (
          <Panel title="Your title" hint="Set by whoever administers your organization.">
            <div className="t-body">{me.title}</div>
          </Panel>
        )}
        {mine && <HomeBaseCard address={mine.homeAddress} placed={mine.homeLat !== null} />}
      </Stack>
    </SectionShell>
  );
}
