import { redirect } from "next/navigation";
import Link from "next/link";
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
      <div style={{ marginBottom: 10 }}>
        <Link href="/" className="mut" style={{ fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
      </div>
      <ImportPanel />
    </div>
  );
}
