import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { navSection } from "@/lib/navData";
import SectionShell from "@/components/SectionShell";
import SignInSettings from "@/components/SignInSettings";
import { Panel, Stack } from "@/components/ui";
import { smsConfigured } from "@/lib/sms";

export const dynamic = "force-dynamic";

/**
 * How you get in, and how you get back in.
 *
 * Both controls here exist for one failure: email stops arriving - a provider
 * blocks a domain, a filter eats the message - and the portal that tracks the
 * instruments becomes unreachable. Setting either from in here, already signed
 * in, is what makes them safe to offer at all: the address was proved by the
 * email path before either existed, so neither is a way to GET an account,
 * only a second way back into one.
 */
export default async function AccountSecurityPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const section = await navSection("account");
  const [me] = await db.select({ hash: users.passwordHash, phone: users.phone })
    .from(users).where(eq(users.email, user.email.toLowerCase()));

  return (
    <SectionShell section={section} active="/account/security"
      title="Sign-in &amp; security" sub={user.email}>
      <Stack gap={3}>
        <SignInSettings show="signin"
          name={user.name} email={user.email}
          hasPassword={!!me?.hash} phone={me?.phone ?? ""} smsConfigured={smsConfigured()} />
        <Panel title="Your email address"
          hint="The address is your identity here, so changing it is not a self-service edit.">
          <div className="t-body">
            Signed in as <b>{user.email}</b>. To move your account to a different
            address, ask whoever administers your organization - they add the new
            address and retire this one, which keeps your history attached to you
            rather than leaving it on an address nobody reads.
          </div>
        </Panel>
      </Stack>
    </SectionShell>
  );
}
