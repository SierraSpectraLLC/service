import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings, clientAllowlist } from "@/db/schema";
import { requireOwner } from "@/lib/authz";
import { parseList } from "@/auth";
import { getStageDefs } from "@/lib/stageDefs";
import SettingsForm from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  try { await requireOwner(); } catch { redirect("/"); }
  const [[s], allowRows, stageDefList] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    db.select().from(clientAllowlist).orderBy(asc(clientAllowlist.entry)),
    getStageDefs(),
  ]);
  return (
    <div className="container" style={{ maxWidth: 620 }}>
      <SettingsForm
        clientAccessEnabled={s?.clientAccessEnabled ?? false}
        clientCanEdit={s?.clientCanEdit ?? false}
        allowlist={allowRows.map((r) => ({ id: r.id, entry: r.entry, addedBy: r.addedBy }))}
        envClients={parseList(process.env.CLIENT_EMAILS)}
        stageDefs={stageDefList}
      />
    </div>
  );
}
