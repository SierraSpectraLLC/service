import { redirect } from "next/navigation";
import { requireUser, myTenantOrgId } from "@/lib/authz";
import { isPlatformStaff, isStaffRole, tenantViewer } from "@/lib/tenants";
import { reportsFor } from "@/lib/bugData";
import { PageHead } from "@/components/ui";
import ReportQueue from "@/components/ReportQueue";

export const dynamic = "force-dynamic";

/**
 * What people have reported while using the app.
 *
 * Staff, not owner-only, and deliberately: the engineer who filed a report is
 * the person who most needs to see what happened to it, and a queue only the
 * owner can read is a queue that gets filed into twice. It is their shop's
 * list of snags in the software - not money, not payroll, nothing a wider
 * audience makes riskier.
 *
 * Platform staff read every workspace's, because a bug in the SOFTWARE is not
 * an operator's to fix. That asymmetry is the whole routing: without it a
 * report would sit in one shop's settings page being true and unread by
 * anybody who could act on it.
 */
export default async function ReportsPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!isStaffRole(user.role)) redirect("/");

  const platform = isPlatformStaff(tenantViewer(user));
  const rows = await reportsFor(myTenantOrgId(user), platform);

  return (
    <>
      <PageHead
        title="Reports"
        sub={platform
          ? "Problems reported across every workspace on this instance."
          : "Problems anybody here has reported while using the app."}
      />
      <ReportQueue rows={rows} showWorkspace={platform} />
    </>
  );
}
