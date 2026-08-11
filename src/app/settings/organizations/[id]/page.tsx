import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { appSettings, clientAllowlist, orgs, systemShares } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getBrand } from "@/lib/brand";
import { storeQuota } from "@/lib/storeUsage";
import OrgSettingsForm from "@/components/OrgSettingsForm";

export const dynamic = "force-dynamic";

/**
 * One organization's settings. Two people reach this page: the platform owner,
 * for any organization, and an organization's own editors, for theirs - which is
 * why these controls are here and not bolted onto the dashboard, where they sat
 * looking like part of the work.
 */
export default async function OrgSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const orgId = parseInt(id);
  if (isNaN(orgId)) notFound();

  const isOwner = user.role === "owner";
  // Staff are the house, but an organization's settings are the owner's call or
  // the organization's own - not any staff member's.
  const mayConfigure = isOwner || (user.role === "client_editor" && user.orgId === orgId);
  if (!mayConfigure) notFound();

  const [[org], [s], allowRows, shareRows, brand] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, orgId)),
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    db.select().from(clientAllowlist).where(eq(clientAllowlist.orgId, orgId)).orderBy(asc(clientAllowlist.entry)),
    db.select({ id: systemShares.id }).from(systemShares).where(eq(systemShares.orgId, orgId)),
    getBrand(),
  ]);
  if (!org) notFound();
  const quota = await storeQuota(orgId);

  return (
    <div className="container page">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {isOwner && (
          <Link href="/settings/personnel" className="btn sm" style={{ textDecoration: "none" }}>← Personnel</Link>
        )}
        <h1 style={{ fontSize: 20, margin: 0 }}>{org.name}</h1>
        <span className="pill" style={{ background: org.kind === "provider" ? "#FAF0DC" : "#E7F2FA", color: org.kind === "provider" ? "#8A5410" : "#1D6396" }}>
          {org.kind}
        </span>
      </div>
      <OrgSettingsForm
        org={{
          id: org.id, name: org.name, kind: org.kind, themeColor: org.themeColor, logoUrl: org.logoUrl,
          eodRecipients: org.eodRecipients, systems: shareRows.length,
          storageLimitMb: org.storageLimitMb, quota,
          isOperator: s?.operatorOrgId === org.id, isSheetOrg: s?.sheetOrgId === org.id,
        }}
        people={allowRows.map((r) => ({ id: r.id, entry: r.entry, canEdit: r.canEdit }))}
        platformName={brand.name}
        isOwner={isOwner}
        showRecipients={s?.eodEnabled ?? false}
        showSheetSync={s?.sheetSyncEnabled ?? false}
      />
    </div>
  );
}
