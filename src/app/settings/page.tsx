import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { requireOwner } from "@/lib/authz";
import SettingsForm from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  try { await requireOwner(); } catch { redirect("/"); }
  const [s] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
  return (
    <div className="container" style={{ maxWidth: 620 }}>
      <SettingsForm
        clientAccessEnabled={s?.clientAccessEnabled ?? false}
        clientCanEdit={s?.clientCanEdit ?? false}
      />
    </div>
  );
}
