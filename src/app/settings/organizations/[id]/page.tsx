import { asc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { providerNameOf, providerNames } from "@/lib/providers";
import { agreements, appSettings, attachments, clientAllowlist, instruments, orgs, orgSites, remoteDevices, systemShares, users } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getBrand } from "@/lib/brand";
import { shopDay } from "@/lib/shopday";
import { storeQuota } from "@/lib/storeUsage";
import OrgSettingsForm from "@/components/OrgSettingsForm";
import SitesCard from "@/components/SitesCard";
import AgreementsPanel from "@/components/AgreementsPanel";
import BillingPolicyPanel from "@/components/BillingPolicyPanel";
import { resolvePolicy } from "@/lib/billingPolicy";
import { usageForAll } from "@/lib/agreementUsage";
import { shopToday } from "@/lib/shopday";
import { isHouse, maySeeAgreements, readTenant } from "@/lib/tenancy";
import { siteLabel } from "@/lib/sites";
import { tempState } from "@/lib/tempPassword";
import { RecordHero, Tabs, type HeroStat, type TabItem } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * One organization's settings. Two people reach this page: the platform owner,
 * for any organization, and an organization's own editors, for theirs - which is
 * why these controls are here and not bolted onto the dashboard, where they sat
 * looking like part of the work.
 */
export default async function OrgSettingsPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const sp = await searchParams;
  const orgId = parseInt(id);
  if (isNaN(orgId)) notFound();

  const isOwner = user.role === "owner";
  // Staff are the house, but an organization's settings are the owner's call or
  // the organization's own - not any staff member's.
  const mayConfigure = isOwner || (user.role === "client_editor" && user.orgId === orgId);
  if (!mayConfigure) notFound();
  // Reading the contracts is its own privilege - see lib/tenancy.maySeeAgreements.
  const seesAgreements = await maySeeAgreements(user, orgId);

  const [[org], [s], allowRows, shareRows, brand] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, orgId)),
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    db.select().from(clientAllowlist).where(eq(clientAllowlist.orgId, orgId)).orderBy(asc(clientAllowlist.entry)),
    db.select({ id: systemShares.id }).from(systemShares).where(eq(systemShares.orgId, orgId)),
    getBrand(),
  ]);
  if (!org) notFound();
  const quota = await storeQuota(orgId, readTenant(user));

  // What each person's account already has on it: the profile they will be
  // called by, and whether a password is standing in for the codes. Read here
  // rather than guessed in the panel - "temporary, 6 days left" is a fact about
  // a row, and a stale one would send somebody to reset a password that works.
  const now = new Date();
  const emails = allowRows.map((r) => r.entry.trim().toLowerCase()).filter((e) => !e.startsWith("@"));
  const accountRows = emails.length
    ? await db.select({
        email: users.email, name: users.name, firstName: users.firstName, lastName: users.lastName,
        title: users.title, passwordHash: users.passwordHash, passwordTempUntil: users.passwordTempUntil,
        lastSeenAt: users.lastSeenAt,
      }).from(users).where(inArray(users.email, emails))
    : [];
  const accountOf = new Map(accountRows.map((a) => [a.email.toLowerCase(), a]));

  // Sites, with how many systems sit at each - which is what makes closing one
  // a decision rather than a tidy-up.
  const [siteRows, siteSystems] = await Promise.all([
    db.select().from(orgSites).where(eq(orgSites.orgId, orgId)).orderBy(asc(orgSites.name), asc(orgSites.id)),
    db.select({ siteId: instruments.siteId }).from(instruments).where(eq(instruments.ownerOrgId, orgId)),
  ]);

  // The paper. Staff only: a client sees their own agreement here, which is
  // theirs to see, but the drawdown query is the same either way.
  const agreementRows = await db.select().from(agreements)
    .where(eq(agreements.orgId, orgId)).orderBy(asc(agreements.endsOn), asc(agreements.id));
  const usage = await usageForAll(agreementRows);
  const provNames = await providerNames(agreementRows);
  // The signed document itself. attachments.agreementId has always existed;
  // until now nothing wrote it, so the terms lived in the app and the contract
  // lived in somebody's mail.
  const agreementPapers = agreementRows.length
    ? (await db.select({
        id: attachments.id, agreementId: attachments.agreementId,
        fileName: attachments.fileName, kind: attachments.kind, size: attachments.size,
        uploadedBy: attachments.uploadedBy, createdAt: attachments.createdAt,
      }).from(attachments)
        .where(inArray(attachments.agreementId, agreementRows.map((r) => r.id)))
        .orderBy(asc(attachments.createdAt))
      ).map((a) => ({
        id: a.id, agreementId: a.agreementId!, fileName: a.fileName, kind: a.kind,
        size: a.size, uploadedBy: a.uploadedBy, when: shopDay(a.createdAt),
      }))
    : [];
  // Their systems, so a contract can be assigned to specific ones.
  const ownedSystems = (await db.select({
    id: instruments.id, ownerOrgId: instruments.ownerOrgId,
    externalId: instruments.externalId, model: instruments.model,
  }).from(instruments).where(eq(instruments.ownerOrgId, orgId)).orderBy(asc(instruments.externalId)))
    .map((r) => ({ id: r.id, ownerOrgId: r.ownerOrgId, externalId: r.externalId, label: r.model }));
  const today = shopToday();
  // How many machines this organization has enrolled - the number the remote
  // tier is sold against, and what billing would eventually read.
  const deviceCount = (await db.select({ id: remoteDevices.id }).from(remoteDevices)
    .where(eq(remoteDevices.orgId, orgId)).catch(() => [])).length;

  const activeAgreements = agreementRows.filter((r) => r.status === "active").length;
  const heroStats: HeroStat[] = [
    { value: ownedSystems.length, label: ownedSystems.length === 1 ? "system" : "systems" },
    { value: allowRows.length, label: allowRows.length === 1 ? "person" : "people" },
    { value: siteRows.length, label: siteRows.length === 1 ? "site" : "sites" },
    ...(seesAgreements
      ? [{ value: activeAgreements, label: activeAgreements === 1 ? "active agreement" : "active agreements", tone: activeAgreements === 0 ? "warn" as const : undefined }]
      : []),
  ];

  const base = `/settings/organizations/${org.id}`;
  // Billing is owner-only, so it is gated here as well as in the tab list -
  // a tab you cannot see is not a tab you can reach by typing the URL.
  const tab = ["agreements", "sites", "billing"].includes(sp.tab ?? "")
    && (sp.tab !== "agreements" || seesAgreements)
    && (sp.tab !== "billing" || isOwner)
    ? sp.tab! : "settings";
  const tabs: TabItem[] = [
    { key: "settings", label: "Settings", href: base },
    ...(seesAgreements ? [{ key: "agreements", label: "Agreements", count: agreementRows.length, href: `${base}?tab=agreements` }] : []),
    { key: "sites", label: "Sites", count: siteRows.length, href: `${base}?tab=sites` },
    ...(isOwner ? [{ key: "billing", label: "Billing", href: `${base}?tab=billing` }] : []),
  ];

  return (
    <div>
      {isOwner && (
        <div style={{ marginBottom: 2 }}>
          <Link href="/settings/organizations" className="mut t-body" style={{ textDecoration: "none" }}>← Organizations</Link>
        </div>
      )}

      <RecordHero
        image={org.logoUrl || undefined}
        imageAlt={org.name}
        eyebrow={`${org.kind === "provider" ? "Provider" : "Client"} organization`}
        title={org.name}
        meta="Who signs in, how their workspace looks, where their instruments live, and the paper behind the work."
        stats={heroStats}
      />

      <Tabs items={tabs} active={tab} ariaLabel="Organization sections" />

      {tab === "settings" && <OrgSettingsForm
        org={{
          id: org.id, name: org.name, kind: org.kind, themeColor: org.themeColor, logoUrl: org.logoUrl,
          eodRecipients: org.eodRecipients, digestRecipients: org.digestRecipients,
          digestHour: org.digestHour, digestDays: org.digestDays, systems: shareRows.length,
          storageLimitMb: org.storageLimitMb, quota,
          remoteAccessEnabled: org.remoteAccessEnabled,
          resaleEnabled: org.resaleEnabled, remoteDevices: deviceCount,
          isOperator: s?.operatorOrgId === org.id, isSheetOrg: s?.sheetOrgId === org.id,
        }}
        people={allowRows.map((r) => {
          const a = accountOf.get(r.entry.trim().toLowerCase());
          const state = a ? tempState(a, now) : { kind: "none" as const };
          return {
            id: r.id, entry: r.entry, canEdit: r.canEdit, canSeeAgreements: r.canSeeAgreements,
            canSeePayroll: r.canSeePayroll,
            canSeeMoney: r.canSeeMoney,
            startView: r.startView,
            name: a ? [a.firstName, a.lastName].filter(Boolean).join(" ") || a.name || "" : "",
            title: a?.title ?? "",
            signedIn: !!a?.lastSeenAt,
            password: state.kind === "none" ? "" : state.kind === "own" ? "their own"
              : state.kind === "expired" ? "expired" : `${state.daysLeft}d left`,
          };
        })}
        sites={siteRows.filter((x) => !x.archived).map((x) => ({ id: x.id, name: siteLabel(x) }))}
        isStaff={user.role === "owner" || user.role === "staff"}
        platformName={brand.name}
        isOwner={isOwner}
        showRecipients={s?.eodEnabled ?? false}
        showSheetSync={s?.sheetSyncEnabled ?? false}
        showRemote={s?.remoteEnabled ?? false}
        showDigest={s?.digestEnabled ?? false}
      />}

      {tab === "agreements" && seesAgreements && (
      <AgreementsPanel
        operatorName={brand.operatorName}
        rows={agreementRows.map((r) => ({
          id: r.id, orgId: r.orgId, orgName: org.name,
          kind: r.kind, number: r.number, title: r.title, status: r.status,
          startsOn: r.startsOn, endsOn: r.endsOn, renewNoticeDays: r.renewNoticeDays,
          visitsIncluded: r.visitsIncluded, partsAllowanceCents: r.partsAllowanceCents,
          laborIncludedMinutes: r.laborIncludedMinutes,
          visitsUnlimited: r.visitsUnlimited, partsUnlimited: r.partsUnlimited,
          pmPartsIncluded: r.pmPartsIncluded, includedKits: r.includedKits,
          hourlyRateCents: r.hourlyRateCents, instrumentIds: r.instrumentIds,
          providerName: providerNameOf(r.providerOrgId, provNames),
          valueCents: r.valueCents, note: r.note,
          used: usage.get(r.id) ?? { partsCents: 0, visits: 0, laborMinutes: 0 },
        }))}
        today={today}
        orgs={[{ id: org.id, name: org.name }]}
        systems={ownedSystems}
        // A client reads their own contract; only the service company writes one.
        canEdit={isHouse(user.role)}
        papers={agreementPapers}
      />
      )}

      {tab === "billing" && isOwner && (
        <BillingPolicyPanel
          orgId={org.id}
          orgName={org.name}
          policy={resolvePolicy(s?.billingPolicy ?? null, org.billingPolicy ?? null)}
          terms={org.termsDays}
          apEmail={org.apEmail}
          poNumber={org.poNumber}
          poBalanceCents={org.poBalanceCents}
        />
      )}

      {tab === "sites" && <SitesCard
        orgId={org.id} orgName={org.name} billingAddress={org.billingAddress}
        canEdit={mayConfigure}
        sites={siteRows.map((r) => ({
          id: r.id, name: r.name, address: r.address, accessNotes: r.accessNotes,
          contactName: r.contactName, contactPhone: r.contactPhone, contactEmail: r.contactEmail,
          archived: r.archived, onewayMiles: r.onewayMiles,
          systems: siteSystems.filter((i) => i.siteId === r.id).length,
        }))}
      />}
    </div>
  );
}
