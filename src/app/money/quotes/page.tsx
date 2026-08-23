import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import MoneyTabs from "@/components/MoneyTabs";
import { EmptyState, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function QuotesPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");
  return (
    <div className="container wide">
      <PageHead
        crumb={<><Link href="/money">Billing</Link> › <b>Quotes</b></>}
        title="Quotes"
        sub="Priced work waiting on a client's yes."
      />
      <MoneyTabs active="quotes" />
      <EmptyState
        title="Quotes are built in a later stage"
        body="What lands here: a quote composed from a work order at the client's rate card, sent on a share link, approved or declined by the client with the reason written back to the job."
      />
    </div>
  );
}
