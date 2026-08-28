import { asc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { providerNameOf, providerNames } from "@/lib/providers";
import { agreements, appSettings, attachments, clientAllowlist, instruments, orgs, orgSites, remoteDevices, systemShares, users } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { brandForTenant } from "@/lib/brand";
import { shopDay } from "@/lib/shopday";
import { storeQuota } from "@/lib/storeUsage";
import { listHouseMembers } from "@/app/actions";
import OrgSettingsForm from "@/components/OrgSettingsForm";
import SitesCard from "@/components/SitesCard";
import AgreementsPanel from "@/components/AgreementsPanel";
import BillingPolicyPanel from "@/components/BillingPolicyPanel";
import PmPlanPanel from "@/components/PmPlanPanel";
import FleetBriefCard from "@/components/FleetBriefCard";
import ShareClientButton from "@/components/ShareClientButton";
import { providerLinks } from "@/db/schema";
import { coverageForOrg, fleetCategories } from "@/lib/pmPlanData";
import { resolvePolicy } from "@/lib/billingPolicy";
import { usageForAll } from "@/lib/agreementUsage";
import { shopToday } from "@/lib/shopday";
import { getAppearance } from "@/lib/appearanceData";
import { isHouse, maySeeAgreements, readTenant, tenantOfOrg } from "@/lib/tenancy";
import { siteLabel } from "@/lib/sites";
import { tempState } from "@/lib/tempPassword";
import { DataTable, Pill, RecordHero, Tabs, type HeroStat, type TabItem } from "@/components/ui";

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
  const tenant = readTenant(user);
  // An owner owns a workspace, not the instance. Platform staff read null here
  // and keep reaching every organization - that is the support path - but an
  // operator's owner may only configure organizations inside their own tenant.
  // Without this the id in the URL was the whole authorization: any owner could
  // type any number and read another service company's client dossier, sites,
  // contracts, allowlist and staff names.
  const inTenant = tenant === null || (await tenantOfOrg(orgId)) === tenant;
  // Staff are the house, but an organization's settings are the owner's call or
  // the organization's own - not any staff member's.
  const mayConfigure = (isOwner && inTenant) || (user.role === "client_editor" && user.orgId === orgId);
  if (!mayConfigure) notFound();
  // Reading the contracts is its own privilege - see lib/tenancy.maySeeAgreements.
  const seesAgreements = await maySeeAgreements(user, orgId);

  const [[org], [s], allowRows, shareRows, brand] = await Promise.all([
    db.select().from(orgs).where(eq(orgs.id, orgId)),
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
    db.select().from(clientAllowlist).where(eq(clientAllowlist.orgId, orgId)).orderBy(asc(clientAllowlist.entry)),
    db.select({ id: systemShares.id }).from(systemShares).where(eq(systemShares.orgId, orgId)),
    // The operator that serves THIS organization, which is not the instance's
    // when a second workspace has clients of its own.
    tenantOfOrg(orgId).then(brandForTenant),
  ]);
  if (!org) notFound();
  const quota = await storeQuota(orgId, tenant);
  /*
   * An operator org has STAFF, which live in house_members rather than in the
   * allowlist below - so before this there was nowhere on this page that
   * answered "who works here". They showed up instead on whoever's "Our
   * people" panel had the widest reach, which after the platform split meant
   * the platform's roster claiming another company's engineers.
   *
   * Read-only here on purpose: the add/revoke actions write to the CALLER's
   * workspace, so editing from another company's page would quietly create
   * members in the wrong one. A workspace's own owner manages its people from
   * their own Settings, which is where the panel with the buttons lives.
   */
  const staffRows = org.isOperator ? await listHouseMembers(org.id).catch(() => []) : [];

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
  const platformLook = await getAppearance();

  /*
   * The maintenance plan and what has been delivered against it. Only for a
   * client organization - a plan is what a service company promises somebody,
   * and another operator is not somebody it promises anything to.
   *
   * Read through lib/pmPlanData, which is the same reader /maintenance/coverage
   * uses, so this page and the shop-wide board cannot disagree about a number
   * that is about to be said to a client.
   */
  const { plans: pmPlanRows, rows: pmCoverageRows } = org.isOperator
    ? { plans: [], rows: [] }
    : await coverageForOrg({ orgId: org.id, tenantOrgId: tenant, today });
  const pmCategories = org.isOperator ? [] : await fleetCategories(org.id, tenant);
  // How many machines this organization has enrolled - the number the remote
  // tier is sold against, and what billing would eventually read.
  const deviceCount = (await db.select({ id: remoteDevices.id }).from(remoteDevices)
    .where(eq(remoteDevices.orgId, orgId)).catch(() => [])).length;

  /* The shops this workspace may hand a client to - its own shortlist, never
     the whole directory. The picker and the action agree on this set; the
     action re-checks it, because a picker is not a permission. */
  // The org's own workspace: itself when it runs one, its operator otherwise -
  // the same rule actions.orgTenant applies, and the same one shareClient uses
  // to decide who is doing the sharing.
  const myTenant = org.isOperator ? org.id : org.parentOrgId;
  const peerProviders = myTenant === null ? [] : (await db
    .select({ id: orgs.id, name: orgs.name })
    .from(providerLinks).innerJoin(orgs, eq(orgs.id, providerLinks.providerOrgId))
    .where(eq(providerLinks.tenantOrgId, myTenant))
    .catch(() => []));

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
  // "staff" was missing from this list while the tab was in the one below, so
  // clicking Staff silently fell back to Settings and the panel it gates was
  // unreachable. A tab list and a tab guard are two statements of the same
  // thing; they are next to each other for that reason.
  const tab = ["agreements", "sites", "billing", "staff", "pm", "fleet"].includes(sp.tab ?? "")
    && (sp.tab !== "agreements" || seesAgreements)
    && (sp.tab !== "billing" || isOwner)
    && (sp.tab !== "staff" || org.isOperator)
    && (sp.tab !== "pm" || !org.isOperator)
    && (sp.tab !== "fleet" || !org.isOperator)
    ? sp.tab! : "settings";
  const tabs: TabItem[] = [
    { key: "settings", label: "Settings", href: base },
    ...(seesAgreements ? [{ key: "agreements", label: "Agreements", count: agreementRows.length, href: `${base}?tab=agreements` }] : []),
    { key: "sites", label: "Sites", count: siteRows.length, href: `${base}?tab=sites` },
    /* A maintenance plan is a thing a SERVICE COMPANY promises a client, so it
       has no meaning on another operator's organization page. */
    ...(!org.isOperator ? [{ key: "pm", label: "Maintenance", count: pmPlanRows.length || undefined, href: `${base}?tab=pm` }] : []),
    /* Telling a peer what a CLIENT runs. Meaningless on another operator's
       organization page - that is a company, not an estate. */
    ...(!org.isOperator ? [{ key: "fleet", label: "Fleet", count: ownedSystems.length || undefined, href: `${base}?tab=fleet` }] : []),
    ...(org.isOperator ? [{ key: "staff", label: "Staff", count: staffRows.length, href: `${base}?tab=staff` }] : []),
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
          spectrumStops: org.spectrumStops, spectrumHeight: org.spectrumHeight,
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
        /* What this workspace inherits when it has chosen nothing of its own -
           so the "follow the platform" preview shows the real bar rather than
           the stock one. */
        platformSpectrum={{ stops: platformLook.spectrumStops, height: platformLook.spectrumHeight }}
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

      {tab === "pm" && !org.isOperator && (
        <PmPlanPanel
          orgId={org.id}
          orgName={org.name}
          plans={pmPlanRows}
          categories={pmCategories}
          rows={pmCoverageRows}
          /* The house writes an entitlement; the client reads it. A client
             editor configures their own sites and their own billing address
             because those are facts about them - what they are OWED is not,
             and a client who could raise their own PM count would be writing
             the contract from the wrong side. Matched by setPmPlan. */
          canEdit={isHouse(user.role)}
          year={Number(today.slice(0, 4))}
        />
      )}

      {tab === "fleet" && !org.isOperator && (
        <>
          <FleetBriefCard orgId={org.id} orgName={org.name}
            systems={ownedSystems.length} today={shopToday()} />
          {/* Two doors, deliberately together and deliberately distinct: show
              them the fleet, or hand the client over. */}
          {/* Only where there is a workspace to share FROM. An organization
              with no operator behind it has nobody doing the sharing, and a
              picker that said "add a company first" would be answering a
              different question from the one being asked. */}
          {myTenant !== null && (
            <ShareClientButton orgId={org.id} orgName={org.name}
              systems={ownedSystems.length} providers={peerProviders} />
          )}
        </>
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

      {tab === "staff" && (
        <div className="card">
          <div className="card-title">{org.name}&apos;s people</div>
          <div className="mut t-small" style={{ marginBottom: 10 }}>
            Staff of this service company. They see and work every system in its
            workspace, and owners additionally get its Settings. Managed from
            their own Settings &rsaquo; People - shown here so this page can
            answer who works here.
          </div>
          <DataTable
            empty="Nobody yet"
            cols={[
              { key: "name", label: "Name", width: "minmax(140px, 1.2fr)" },
              { key: "email", label: "Email", width: "minmax(200px, 2fr)" },
              { key: "role", label: "Role", width: "90px" },
            ]}
            rows={staffRows.map((m) => ({
              key: m.email,
              cells: {
                name: m.name || <span className="mut">&mdash;</span>,
                email: <span className="mono t-small">{m.email}</span>,
                role: <Pill tone={m.role === "owner" ? "info" : undefined}>{m.role}</Pill>,
              },
            }))}
          />
        </div>
      )}
    </div>
  );
}
