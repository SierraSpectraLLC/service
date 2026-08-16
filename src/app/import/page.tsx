import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import ImportPanel from "@/components/ImportPanel";

export const dynamic = "force-dynamic";

/** The Excel off-ramp: staff and org editors bring a fleet in from CSV. */
export default async function ImportPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role === "client_viewer") redirect("/");

  return (
    <div className="container wide">
      <div className="page-head">
        <h1 className="page-title">Import from a spreadsheet</h1>
      </div>
      <ImportPanel />
    </div>
  );
}
