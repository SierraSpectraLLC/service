import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agreements, assets, instruments, orgSites, orgs } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, viewTenant, visibleSystemIds } from "@/lib/tenancy";
import { systemLabel } from "@/lib/systemLabel";
import { getBrand } from "@/lib/brand";
import { ageDays, getStageSince } from "@/lib/stageAges";
import { BLOCKED_STAGE } from "@/lib/stages";
import { blockHolderName, blockLabel } from "@/lib/blocks";
import { PIPELINE_STAGES } from "@/lib/clientLandingData";
import { COVERAGE, coverageBadge, coverageOf, type CoverageAgreement } from "@/lib/coverage";
import { providerNameOf, providerNames } from "@/lib/providers";
import { shopToday } from "@/lib/shopday";
import { EmptyState, FacetStrip, Id, PageHead, Panel, Pill, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Every unit an organization has with us, on one page.
 *
 * The gap this fills is embarrassing in hindsight. A reseller's landing showed
 * counts by stage, the units that had stalled, and the ones listed for sale -
 * and no way whatsoever to see the roster. "REFURBISHMENT 6" was a poster: six
 * units named, none of them reachable. Sixteen units in the pipeline, and the
 * only complete list of them was the one in somebody's head.
 *
 * A lab client's landing does list everything, but grouped by exception and
 * collapsed behind a summary once past a screenful, which answers "what needs
 * me" rather than "what do I have". Both questions are real, so both surfaces
 * exist and this one is the flat one: searchable, filterable by where a unit
 * stands, one row per unit and nothing folded away.
 *
 * Non-staff only. Staff have the board, which is this page with the shop's
 * columns on it.
 */
export default async function UnitsPage({ searchParams }: {
  searchParams: Promise<{ q?: string; stage?: string }>;
}) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (isStaffRole(user.role) || user.orgId === null) redirect("/");

  const { q = "", stage = "" } = await searchParams;
  const today = shopToday();

  const visible = await visibleSystemIds(user);
  const rows = visible === null || visible.length === 0
    ? []
    : (await db.select().from(instruments)
        .where(eq(instruments.archived, false))
        .orderBy(asc(instruments.externalId)))
      .filter((i) => visible.includes(i.id));

  const ids = rows.map((r) => r.id);
  const [brand, org, assetRows, since] = await Promise.all([
    getBrand(),
    db.select({ name: orgs.name, resale: orgs.resaleEnabled }).from(orgs)
      .where(eq(orgs.id, user.orgId)).then((r) => r[0] ?? null),
    ids.length
      ? db.select({
          instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model,
          serial: assets.serial, manufacturer: assets.manufacturer, status: assets.status,
          sortOrder: assets.sortOrder,
        }).from(assets).where(inArray(assets.instrumentId, ids))
      : Promise.resolve([]),
    ids.length ? getStageSince(ids) : Promise.resolve(new Map()),
  ]);
  const resells = org?.resale ?? false;
  const noun = resells ? "unit" : "instrument";

  // Where each one lives, when the account has named its sites.
  const siteIds = [...new Set(rows.map((r) => r.siteId).filter((x): x is number => x !== null))];
  const siteRows = siteIds.length
    ? await db.select({ id: orgSites.id, name: orgSites.name }).from(orgSites)
        .where(inArray(orgSites.id, siteIds)).catch(() => [])
    : [];
  const siteName = new Map(siteRows.map((x) => [x.id, x.name]));

  /* Coverage, from the same rule the landing and the record use. Only the
     columns that decide it: who services this is not a money fact, and what a
     contract includes stays behind the organization's own gate. */
  const covRows = await db.select({
    id: agreements.id, title: agreements.title, number: agreements.number,
    status: agreements.status, startsOn: agreements.startsOn, endsOn: agreements.endsOn,
    renewNoticeDays: agreements.renewNoticeDays, instrumentIds: agreements.instrumentIds,
    providerOrgId: agreements.providerOrgId,
  }).from(agreements)
    .where(and(
      eq(agreements.orgId, user.orgId),
      eq(agreements.kind, "contract"),
      forTenant(agreements.tenantOrgId, await viewTenant(user)),
    ))
    .catch(() => []);
  const provNames = await providerNames(covRows);
  const covAgreements: CoverageAgreement[] = covRows.map((a) => ({
    ...a, providerName: providerNameOf(a.providerOrgId, provNames),
  }));

  const now = new Date();
  const units = rows.map((r) => {
    const inPipe = r.stages.filter((x) => (PIPELINE_STAGES as readonly string[]).includes(x));
    /* How long it has stood where it stands. Blocking writes its own column,
       so that one is read directly rather than through a log that may not have
       been running when the unit stopped - the same order lib/clientLandingData
       reads them in. Where a unit is in two stages, the one it entered most
       recently is the honest answer to "how long has this been going on". */
    const age = r.stages.includes(BLOCKED_STAGE) && r.blockedSince
      ? ageDays(r.blockedSince, now)
      : (() => {
          const ages = inPipe
            .map((st) => since.get(r.id)?.get(st))
            .filter((d): d is Date => !!d)
            .map((d) => ageDays(d, now));
          return ages.length ? Math.min(...ages) : null;
        })();
    return {
      id: r.id,
      externalId: r.externalId,
      label: systemLabel(r, assetRows.filter((a) => a.instrumentId === r.id)),
      where: (r.siteId !== null ? siteName.get(r.siteId) : "") || r.location || "",
      stages: r.stages,
      blocked: r.stages.includes(BLOCKED_STAGE),
      blockedReason: r.blockedReason ?? "",
      /* Whose block it is, named only when it is not the workspace servicing
         the unit - on a roster of units somebody else is working, "who do I
         chase" is the question this answers. See lib/blocks. */
      blockHolder: blockHolderName(r.blockedOrgId, r.tenantOrgId, (id) =>
        id === user.orgId ? (org?.name ?? "you") : brand.operatorName),
      age,
      forSale: r.forSale,
      coverage: coverageOf(r.id, covAgreements, today, brand.operatorName),
    };
  });

  const needle = q.trim().toLowerCase();
  const shown = units.filter((u) =>
    (!needle || `${u.externalId} ${u.label} ${u.where}`.toLowerCase().includes(needle))
    && (!stage || u.stages.includes(stage)));

  const href = (next: { q?: string; stage?: string }) => {
    const p = new URLSearchParams();
    const nq = next.q ?? q;
    const ns = next.stage ?? stage;
    if (nq) p.set("q", nq);
    if (ns) p.set("stage", ns);
    return p.size ? `/units?${p}` : "/units";
  };

  /* Only stages something is actually standing in. A rail of empty columns is
     a rail of dead buttons, which is what the banded layout shipped for years. */
  const liveStages = (PIPELINE_STAGES as readonly string[])
    .filter((st) => units.some((u) => u.stages.includes(st)));

  return (
    <div className="container wide">
      <PageHead
        title={resells ? "Your units" : "Your instruments"}
        // Their estate, described as theirs. Who services each one is a
        // per-unit fact and rides the row, where it is an answer rather than
        // a lens on the whole page.
        sub={`Every ${noun} on your account, wherever it stands.`}
      />

      <Toolbar
        search={
          <form action="/units">
            {stage && <input type="hidden" name="stage" value={stage} />}
            <input name="q" defaultValue={q} placeholder={`Find a ${noun}, model or room`}
              aria-label={`Search your ${noun}s`} />
          </form>
        }
        facets={
          <FacetStrip facets={[
            { key: "", label: "All", count: units.length, on: stage === "", href: href({ stage: "" }) },
            ...liveStages.map((st) => ({
              key: st, label: st, on: stage === st, href: href({ stage: st }),
              count: units.filter((u) => u.stages.includes(st)).length,
            })),
          ]} />
        }
      />

      {/* Titled by what is being looked at, never "All 16" directly under a
          chip reading "All 16". The count comes back only when a search has
          narrowed things, because that is the one time it is not already on
          the chip above. */}
      <Panel title={stage || (resells ? "Units" : "Instruments")}
        count={needle ? shown.length : undefined}
        empty={`No ${noun} matches that.`}>
        {shown.map((u) => (
          <div key={u.id} className="ledger wrap">
            <span className="grow">
              <Link href={`/instruments/${u.id}`} className="plain" style={{ fontWeight: 600 }}>
                <Id>{u.externalId}</Id>
              </Link>
              <span className="sub">
                {u.label}{u.where ? ` · ${u.where}` : ""}
                {u.blocked && u.blockedReason
                  ? ` · ${u.blockHolder ? `${blockLabel(u.blockHolder)}: ` : ""}${u.blockedReason}`
                  : ""}
              </span>
            </span>
            {u.forSale && <Pill tone="accent">Listed</Pill>}
            {/* Coverage, and only where it says something.
                Not for a reseller at all: their units are stock heading for a
                sale, not benches somebody keeps running, so NONE of them is
                under a service contract and the badge landed on all sixteen
                rows saying nothing sixteen times. Same reason their landing
                carries no uptime figure - the question does not apply to a
                machine that is meant to be in pieces.
                And for a lab, only where it is not ours: a badge on every row
                is the same noise in a different costume. */}
            {!resells && u.coverage.state !== "ours" && (
              <Pill tone={COVERAGE[u.coverage.state].tone}>{coverageBadge(u.coverage)}</Pill>
            )}
            {u.stages.length > 0 && (
              <Pill tone={u.blocked ? "warn" : "info"}>{u.stages.join(" · ")}</Pill>
            )}
            <span className="mut t-meta" style={{ minWidth: 62, textAlign: "right" }}>
              {/* Blank rather than a zero where no stage event was ever
                  logged: "0 d" would read as "arrived today". */}
              {u.age === null ? "" : `${u.age} d`}
            </span>
          </div>
        ))}
      </Panel>

      {units.length === 0 && (
        <EmptyState
          title="Nothing here yet."
          body={`${brand.operatorName} has not taken anything in for ${org?.name ?? "your organization"} - or nothing has been shared with your account yet.`} />
      )}
    </div>
  );
}
