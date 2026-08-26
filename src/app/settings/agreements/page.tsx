import { asc, desc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { providerNameOf, providerNames } from "@/lib/providers";
import { getBrand } from "@/lib/brand";
import { attachments, agreements, instruments, orgs } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { forTenant, readTenant, visibleOrgs } from "@/lib/tenancy";
import { needsAttention } from "@/lib/agreements";
import { usageForAll } from "@/lib/agreementUsage";
import { shopDay, shopToday } from "@/lib/shopday";
import AgreementsPanel from "@/components/AgreementsPanel";
import { FacetStrip, PageHead, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The paper behind the work, across every client: what is in force, what is up
 * for renewal, and how much of each allowance is left.
 *
 * Staff only, and deliberately so. A client sees their own agreement on their
 * own organization page; this is the book of business, and one client reading
 * another's contract terms is the worst leak this application could have.
 */
export default async function AgreementsPage({ searchParams }: { searchParams: Promise<{ q?: string; org?: string; f?: string }> }) {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const { q = "", org = "", f = "" } = await searchParams;
  const today = shopToday();
  const tenant = readTenant(user);

  const rows = await db.select().from(agreements)
    .where(forTenant(agreements.tenantOrgId, tenant))
    .orderBy(asc(agreements.endsOn), desc(agreements.id));

  const orgIds = [...new Set(rows.map((r) => r.orgId))];
  const [orgRows, allOrgs, systemRows] = await Promise.all([
    orgIds.length ? db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(inArray(orgs.id, orgIds)) : [],
    visibleOrgs(user),
    // Every client-owned system, so an assigned contract can name its systems -
    // this workspace's, and only this workspace's. Unscoped, the contract's
    // system picker listed every serial on the instance, which is a competitor's
    // installed base handed over in a dropdown.
    db.select({
      id: instruments.id, ownerOrgId: instruments.ownerOrgId,
      externalId: instruments.externalId, model: instruments.model,
    }).from(instruments)
      .where(forTenant(instruments.tenantOrgId, tenant))
      .orderBy(asc(instruments.externalId)),
  ]);
  const name = new Map(orgRows.map((o) => [o.id, o.name]));
  // The signed papers filed against these agreements. Without this the attach
  // flow WORKED and showed nothing - the document went to the database and
  // the page had nowhere to put it, which reads exactly like a failure.
  const papers = rows.length
    ? (await db.select({
        id: attachments.id, agreementId: attachments.agreementId,
        fileName: attachments.fileName, kind: attachments.kind, size: attachments.size,
        uploadedBy: attachments.uploadedBy, createdAt: attachments.createdAt,
      }).from(attachments)
        .where(inArray(attachments.agreementId, rows.map((r) => r.id)))
        .orderBy(asc(attachments.createdAt))
      ).map((a) => ({
        id: a.id, agreementId: a.agreementId!, fileName: a.fileName, kind: a.kind,
        size: a.size, uploadedBy: a.uploadedBy, when: shopDay(a.createdAt),
      }))
    : [];
  const systems = systemRows
    .filter((r) => r.ownerOrgId !== null)
    .map((r) => ({ id: r.id, ownerOrgId: r.ownerOrgId, externalId: r.externalId, label: r.model }));

  // Drawn down from the work itself, every time this page renders. One pass per
  // agreement; a shop with hundreds would want this batched, and would also
  // want a different page.
  const usage = await usageForAll(rows);
  const provNames = await providerNames(rows);
  const brand = await getBrand();
  const nothing = { partsCents: 0, visits: 0, laborMinutes: 0, pmPartsCents: 0 };

  const shaped = rows.map((r) => ({
    id: r.id, orgId: r.orgId, orgName: name.get(r.orgId) ?? "an organization",
    kind: r.kind, number: r.number, title: r.title, status: r.status,
    startsOn: r.startsOn, endsOn: r.endsOn, renewNoticeDays: r.renewNoticeDays,
    visitsIncluded: r.visitsIncluded, partsAllowanceCents: r.partsAllowanceCents,
    laborIncludedMinutes: r.laborIncludedMinutes,
    visitsUnlimited: r.visitsUnlimited, partsUnlimited: r.partsUnlimited,
    pmPartsIncluded: r.pmPartsIncluded, includedKits: r.includedKits,
    hourlyRateCents: r.hourlyRateCents, instrumentIds: r.instrumentIds,
    providerName: providerNameOf(r.providerOrgId, provNames),
    valueCents: r.valueCents, note: r.note,
    used: usage.get(r.id) ?? nothing,
  }));

  const needle = q.trim().toLowerCase();
  const orgId = parseInt(org) || 0;
  const filtered = shaped.filter((r) =>
    (!orgId || r.orgId === orgId)
    && (!needle || [r.number, r.title, r.orgName].join(" ").toLowerCase().includes(needle)));
  const allChase = needsAttention(shaped, today);
  const shown = f === "attention" ? filtered.filter((r) => allChase.includes(r)) : filtered;
  const chase = shown.filter((r) => allChase.includes(r));
  const rest = shown.filter((r) => !allChase.includes(r));
  const href = (next: { org?: string; f?: string }) => {
    const merged = { org: String(orgId || ""), f, ...next };
    const p = new URLSearchParams();
    if (needle) p.set("q", needle);
    if (merged.org) p.set("org", merged.org);
    if (merged.f) p.set("f", merged.f);
    return `/settings/agreements${p.size ? `?${p}` : ""}`;
  };
  const orgFacets = orgIds.map((id) => ({
    key: `org-${id}`,
    label: name.get(id) ?? `#${id}`,
    count: shaped.filter((r) => r.orgId === id).length,
    on: orgId === id,
    href: href({ org: orgId === id ? "" : String(id) }),
  }));

  return (
    <div>
      <PageHead title="Agreements"
        sub="Contracts, POs and quotes across every client." />
      <Toolbar
        search={
          <form action="/settings/agreements">
            {orgId ? <input type="hidden" name="org" value={orgId} /> : null}
            {f && <input type="hidden" name="f" value={f} />}
            <input name="q" defaultValue={q} placeholder="Number, title or client" aria-label="Search agreements" />
          </form>
        }
        facets={
          <FacetStrip facets={[
            {
              key: "attention", label: "Needs attention",
              count: allChase.length || undefined,
              on: f === "attention", href: href({ f: f === "attention" ? "" : "attention" }),
            },
            ...orgFacets,
          ]} />
        }
      />

      {chase.length > 0 && (
        <AgreementsPanel rows={chase} today={today} systems={systems} papers={papers}
          operatorName={brand.operatorName}
          orgs={allOrgs.map((o) => ({ id: o.id, name: o.name }))} canEdit
          title={`Needs attention · ${chase.length}`} />
      )}

      {(rest.length > 0 || shown.length === 0) && (
        <AgreementsPanel rows={rest} today={today} systems={systems} papers={papers}
          operatorName={brand.operatorName}
          orgs={allOrgs.map((o) => ({ id: o.id, name: o.name }))} canEdit
          title={chase.length ? "Everything else" : "In force"} />
      )}

      <div className="mut t-small" style={{ padding: "0 4px" }}>
        Allowances are summed from the work every time this page loads - parts fitted on
        their systems inside the term, closed work orders, hours logged - so what you see
        here is what the record says rather than a balance somebody kept by hand.
        Add an agreement from the organization&apos;s own settings page.
      </div>
    </div>
  );
}
