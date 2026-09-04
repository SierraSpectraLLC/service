import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getBrand } from "@/lib/brand";
import { displayName } from "@/lib/directory";
import { notifyKindsFor } from "@/lib/inbox";
import WelcomeForm from "@/components/WelcomeForm";

export const dynamic = "force-dynamic";

/**
 * Somebody's first sign-in, and the only time they see this.
 *
 * Guarded both ways. Somebody who has already been through it is sent to their
 * work rather than asked again - a bookmark, a back button or a second tab must
 * not reopen a finished form. And the layout sends anybody who has NOT been
 * through it here, so this is the one page a new arrival can reach.
 */
export default async function WelcomePage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const email = user.email.toLowerCase();
  const [me] = await db.select({ onboardedAt: users.onboardedAt, name: users.name })
    .from(users).where(eq(users.email, email));
  if (me?.onboardedAt) redirect("/");

  const brand = await getBrand();
  return (
    <div className="container form" style={{ paddingTop: 40 }}>
      <div className="card">
        <WelcomeForm
          email={user.email}
          // Their address, read as a name, for them to correct rather than
          // compose from nothing. The same guess the directory makes.
          suggested={displayName(me?.name ?? null, email)}
          // The very first screen somebody sees. Offering a client a switch for
          // "the weekly report of who is using the portal" here is the worst
          // possible moment to be leaking what the operator watches.
          kinds={notifyKindsFor(user.role).map((k) => ({ kind: k.kind, label: k.label }))}
          brandName={brand.name}
        />
      </div>
    </div>
  );
}
