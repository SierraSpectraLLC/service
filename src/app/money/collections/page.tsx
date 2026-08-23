import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import MoneyTabs from "@/components/MoneyTabs";
import { EmptyState, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  return (
    <div className="container wide">
      <PageHead
        crumb={<><Link href="/money">Billing</Link> › <b>Collections</b></>}
        title="Collections"
        sub="Invoices past due, and whose move it is on each one."
      />
      <MoneyTabs active="collections" />
      <EmptyState
        title="Collections is built in a later stage"
        body="What lands here: the aging ladder rung by rung, each one naming a person; late fees posted as their own line and never editing the original; promises to pay and the morning after one breaks; and the demand letter assembled from rows that already exist."
      />
    </div>
  );
}
