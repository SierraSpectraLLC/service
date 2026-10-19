import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import PmSheetMockup from "@/components/mockups/PmSheetMockup";

export const dynamic = "force-dynamic";

/**
 * MOCKUP of the PM sheet - see components/mockups/PmSheetMockup. Signed in like
 * every other page, and it reads and writes nothing.
 */
export default async function PmSheetMockupPage() {
  try { await requireUser(); } catch { redirect("/login"); }
  return <PmSheetMockup />;
}
