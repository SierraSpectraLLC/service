import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets, catalogRefs, instruments, partCatalog, partKitLines, procedures, vocabTerms } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { forTenant, readTenant } from "@/lib/tenancy";
import { refsForUnits } from "@/lib/catalogRefs";
import { parseProcParts } from "@/lib/procedures";
import { PART_KIND_LABEL } from "@/lib/partCatalog";
import { shopDay } from "@/lib/shopday";
import ModelHeaderCard from "@/components/ModelHeaderCard";
import ModelSpecsCard from "@/components/ModelSpecsCard";
import PublishModelCard from "@/components/PublishModelCard";
import { publishBlockers, publishWarnings } from "@/lib/publicCatalog";
import { appUrl } from "@/lib/appUrl";
import { getModules } from "@/lib/flags";
import { parseModelSpecs, specNameSuggestions } from "@/lib/modelSpecs";
import ProceduresPanel from "@/components/ProceduresPanel";
import ReferencePanel from "@/components/ReferencePanel";
import { RecordHero, Tabs, type HeroStat, type TabItem } from "@/components/ui";
import { stockSrc } from "@/lib/photos";

export const dynamic = "force-dynamic";

/**
 * A model's own page: everything the shop knows about one piece of the
 * catalog, in one place - the settings pages slice the same data by KIND
 * (all procedures, all references); this slices it by MODULE, which is how a
 * person thinks when standing in front of one.
 *
 * Procedures here run in one-model mode: adding starts scoped to this model
 * (widen with the same multiselect as always), and editing something shared
 * asks whether the change goes to every covered model or forks off a version
 * for this one - see actions.forkProcedureForModel.
 */
export default async function ModelPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const { id } = await params;
  const sp = await searchParams;
  const termId = parseInt(id);
  if (isNaN(termId)) notFound();
  const tenant = readTenant(user);

  const [term] = await db.select().from(vocabTerms).where(eq(vocabTerms.id, termId));
  if (!term || term.kind !== "model") notFound();
  if (tenant !== null && term.tenantOrgId !== tenant) notFound();

  const [terms, procRows, refRows, units, partRows] = await Promise.all([
    db.select().from(vocabTerms).where(forTenant(vocabTerms.tenantOrgId, tenant)).orderBy(asc(vocabTerms.name)),
    db.select().from(procedures)
      .where(and(eq(procedures.assetType, term.assetType), forTenant(procedures.tenantOrgId, tenant)))
      .orderBy(asc(procedures.position), asc(procedures.id)),
    db.select().from(catalogRefs).where(forTenant(catalogRefs.tenantOrgId, tenant))
      .orderBy(asc(catalogRefs.assetType), asc(catalogRefs.model), asc(catalogRefs.id)),
    db.select().from(assets)
      .where(and(eq(assets.kind, term.assetType), forTenant(assets.tenantOrgId, tenant)))
      .orderBy(asc(assets.serial)),
    db.select().from(partCatalog)
      .where(and(eq(partCatalog.archived, false), forTenant(partCatalog.tenantOrgId, tenant)))
      .orderBy(asc(partCatalog.partNumber)),
  ]);

  // The public library is a module: off means the control isn't here and the
  // pages aren't there either (app/equipment). See lib/flags.
  const { publicCatalog } = await getModules();
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  // Only this model's slice of the procedure book: empty scope = every model.
  const covering = procRows.filter((r) => r.modelScope.length === 0
    || r.modelScope.some((m) => same(m, term.name)));
  // What this model already has BY NAME - the other half of what a copy skips.
  const mineByName = new Set(covering.map((r) => `${r.kind}|${r.name.trim().toLowerCase()}`));

  // The same setup data the settings page hands the panel, so the sheet's
  // model multiselect and category logic behave identically here.
  const modelOptions: Record<string, string[]> = {};
  const categoriesByType: Record<string, string[]> = {};
  for (const t of terms) {
    if (t.kind !== "model" || !t.assetType) continue;
    (modelOptions[t.assetType] ??= []).push(t.name);
    for (const c of t.categories) {
      const seen = (categoriesByType[t.assetType] ??= []);
      if (!seen.includes(c)) seen.push(c);
    }
  }

  // Parts that belong to this model: tagged to it by name, or tagged to the
  // module type with no model narrowing. Kits lead - a PM kit is the thing
  // somebody comes here to find.
  const modelParts = partRows.filter((p) =>
    p.models.some((m) => same(m, term.name))
    || (p.models.length === 0 && p.assetTypes.some((t) => same(t, term.assetType))));
  const rank = (k: string) => (k === "kit" ? 0 : k === "consumable" ? 1 : 2);
  modelParts.sort((a, b) => rank(a.kind) - rank(b.kind) || a.partNumber.localeCompare(b.partNumber));
  const kitIds = modelParts.filter((p) => p.kind === "kit").map((p) => p.id);
  const kitLines = kitIds.length
    ? await db.select().from(partKitLines).where(inArray(partKitLines.kitId, kitIds))
        .orderBy(asc(partKitLines.sortOrder), asc(partKitLines.id))
    : [];

  // What maintenance says it consumes, whether or not the book describes it.
  const bookNumbers = new Set(modelParts.map((p) => p.partNumber.trim().toLowerCase()));
  const maintenanceParts = covering
    .flatMap((r) => parseProcParts(r.parts).map((pp) => ({ ...pp, procedure: r.name })))
    .filter((pp) => !pp.number || !bookNumbers.has(pp.number.trim().toLowerCase()));

  // The fleet: real units of this model, and where each one sits.
  const mine = units.filter((a) => same(a.model, term.name));
  const instIds = [...new Set(mine.map((a) => a.instrumentId).filter((x): x is number => x !== null))];
  const instRows = instIds.length
    ? await db.select({ id: instruments.id, externalId: instruments.externalId }).from(instruments)
        .where(inArray(instruments.id, instIds))
    : [];
  const instOf = new Map(instRows.map((i) => [i.id, i.externalId]));

  // Hoisted so the tab counts and the panels read the same slice.
  const specs = parseModelSpecs(term.specs);
  const modelRefs = refsForUnits(
    refRows.map((r) => ({
      id: r.id, assetType: r.assetType, model: r.model, kind: r.kind,
      title: r.title, url: r.url, body: r.body, createdBy: r.createdBy,
      provenance: r.provenance,
      when: shopDay(r.createdAt),
    })),
    [{ kind: term.assetType, model: term.name }],
  );

  const tab = ["procedures", "parts", "reference", "fleet"].includes(sp.tab ?? "") ? sp.tab! : "overview";
  const tabs: TabItem[] = [
    { key: "overview", label: "Overview", href: `/catalog/${term.id}` },
    { key: "procedures", label: "Maintenance", count: covering.length, href: `/catalog/${term.id}?tab=procedures` },
    { key: "parts", label: "Parts", count: modelParts.length, href: `/catalog/${term.id}?tab=parts` },
    { key: "reference", label: "Reference", count: modelRefs.length, href: `/catalog/${term.id}?tab=reference` },
    { key: "fleet", label: "Fleet", count: mine.length, href: `/catalog/${term.id}?tab=fleet` },
  ];

  const heroStats: HeroStat[] = [
    { value: mine.length, label: mine.length === 1 ? "unit in the fleet" : "units in the fleet" },
    { value: covering.length, label: "procedures", tone: covering.length === 0 ? "warn" : undefined },
    { value: modelParts.length, label: "parts" },
    { value: specs.length, label: "specs", tone: specs.length === 0 ? "warn" : undefined },
  ];

  return (
    <div className="container page">
      <div className="crumb">
        Settings › <Link href="/settings/catalog" style={{ textDecoration: "none", color: "inherit" }}>Catalog</Link> › <b>{term.name}</b>
      </div>

      <RecordHero
        image={term.photoUrl ? stockSrc(term.id) : undefined}
        imageAlt={term.name}
        eyebrow={term.manufacturer || term.assetType}
        title={term.name}
        meta={[term.assetType, ...term.categories, ...term.gases].join(" · ")}
        stats={heroStats}
      />

      <Tabs items={tabs} active={tab} ariaLabel="Model sections" />

      {tab === "overview" && <>
      <ModelHeaderCard termId={term.id} name={term.name} hasPhoto={!!term.photoUrl} />

      <ModelSpecsCard
        termId={term.id} modelName={term.name}
        specs={specs}
        // Copy sources: same-type siblings that actually have a sheet.
        siblings={terms
          .filter((t) => t.kind === "model" && t.id !== term.id
            && same(t.assetType, term.assetType) && parseModelSpecs(t.specs).length > 0)
          .map((t) => ({ name: t.name, specs: parseModelSpecs(t.specs) }))}
        nameSuggestions={specNameSuggestions(
          terms.filter((t) => t.kind === "model" && same(t.assetType, term.assetType))
            .map((t) => parseModelSpecs(t.specs)),
        )}
      />

      {publicCatalog && <PublishModelCard
        termId={term.id} modelName={term.name}
        published={term.published} slug={term.publicSlug} summary={term.publicSummary}
        blockers={publishBlockers({
          manufacturer: term.manufacturer, name: term.name, summary: term.publicSummary,
          specs: parseModelSpecs(term.specs), hasPhoto: !!term.photoUrl,
        })}
        warnings={publishWarnings({
          manufacturer: term.manufacturer, name: term.name, summary: term.publicSummary,
          specs: parseModelSpecs(term.specs), hasPhoto: !!term.photoUrl,
        })}
        siteUrl={appUrl()}
      />}
      </>}

      {tab === "procedures" && <ProceduresPanel
        focus={{ assetType: term.assetType, model: term.name }}
        // Siblings worth copying from, counted by exactly what the action would
        // actually create: procedures the sibling has, that this model does not
        // already cover AND has not already got a procedure of that name. The
        // name half matters - without it a model that has just been copied to
        // still advertises "3 to copy" and delivers nothing, which is worse
        // than not offering at all.
        copyFrom={terms
          .filter((t) => t.kind === "model" && t.id !== term.id && same(t.assetType, term.assetType))
          .map((t) => ({
            name: t.name,
            count: procRows.filter((r) =>
              r.modelScope.length > 0
              && r.modelScope.some((m) => same(m, t.name))
              && !r.modelScope.some((m) => same(m, term.name))
              && !mineByName.has(`${r.kind}|${r.name.trim().toLowerCase()}`)).length,
          }))
          .filter((m) => m.count > 0)
          .sort((a, b) => b.count - a.count)}
        assetTypes={[term.assetType]}
        modelOptions={modelOptions}
        categories={terms.filter((t) => t.kind === "category").map((t) => t.name)}
        categoriesByType={categoriesByType}
        items={covering.map((r) => ({
          id: r.id, assetType: r.assetType, kind: r.kind, name: r.name, notes: r.notes, position: r.position,
          resultType: r.resultType, target: r.target, tolerancePct: r.tolerancePct,
          requiresNote: r.requiresNote, consumesPart: r.consumesPart,
          runsAtIntake: r.runsAtIntake, intervalDays: r.intervalDays, required: r.required,
          qualification: r.qualification,
          categoryScope: r.categoryScope,
          parts: parseProcParts(r.parts), modelScope: r.modelScope, checklist: r.checklist,
          provenance: r.provenance,
        }))}
      />}

      {tab === "parts" && <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          <div className="card-title">Parts &amp; consumables</div>
          <Link href="/settings/parts" className="btn link" style={{ fontSize: 11, marginLeft: "auto" }}>Open the parts book</Link>
        </div>
        <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
          Everything the parts book files under {term.name} - and under any {term.assetType.toLowerCase()} generally.
        </div>
        {modelParts.map((p) => (
          <div key={p.id} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>{p.partNumber}</span>
              <span style={{ fontSize: 13 }}>{p.name || <span className="mut">no description yet</span>}</span>
              <span className={`pill ${p.kind === "kit" ? "accent" : "neutral"}`} style={{ fontSize: 10 }}>
                {PART_KIND_LABEL[p.kind] ?? p.kind}
              </span>
              {p.manufacturer && <span className="mut" style={{ fontSize: 11 }}>{p.manufacturer}{p.mfrPartNumber ? ` ${p.mfrPartNumber}` : ""}</span>}
            </div>
            {p.kind === "kit" && (
              <div className="mut" style={{ fontSize: 11, paddingLeft: 12, marginTop: 2 }}>
                {kitLines.filter((l) => l.kitId === p.id)
                  .map((l) => `${l.qty > 1 ? `${l.qty}× ` : ""}${l.name || l.partNumber}`).join(" · ") || "empty kit"}
              </div>
            )}
          </div>
        ))}
        {modelParts.length === 0 && (
          <div className="mut" style={{ fontSize: 12 }}>
            Nothing filed yet. Tag parts to {term.name} in the parts book and they appear here.
          </div>
        )}
        {maintenanceParts.length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
            <div className="eyebrow" style={{ marginBottom: 2 }}>Named by maintenance, not yet in the book</div>
            {maintenanceParts.map((pp, n) => (
              <div key={n} className="mut" style={{ fontSize: 12, padding: "2px 0" }}>
                {(pp.qty ?? 1) > 1 ? `${pp.qty}× ` : ""}{pp.name || pp.number}
                {pp.number && pp.name ? <span className="mono" style={{ fontSize: 11 }}> · {pp.number}</span> : null}
                <span style={{ fontSize: 11 }}> — {pp.procedure}</span>
              </div>
            ))}
          </div>
        )}
      </div>}

      {tab === "reference" && <ReferencePanel canEdit
        sub={`Manuals, links and field notes for ${term.name} - and for any ${term.assetType.toLowerCase()}. Filed here, they show on every unit.`}
        scopes={[
          { assetType: term.assetType, model: term.name, label: `${term.name} (every unit)` },
          { assetType: term.assetType, model: "", label: `any ${term.assetType.toLowerCase()}` },
        ]}
        refs={modelRefs}
      />}

      {tab === "fleet" && <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Fleet</div>
        <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
          Every {term.name} on the books, and where it sits.
        </div>
        {mine.map((a) => (
          <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <Link href={`/assets/${a.id}`} className="mono" style={{ fontSize: 12, fontWeight: 700, textDecoration: "none", color: "var(--navy)" }}>
              {a.serial ? `SN ${a.serial}` : `#${a.id}`}
            </Link>
            <span style={{ fontSize: 12 }}>
              {a.instrumentId !== null
                ? <>on <Link href={`/instruments/${a.instrumentId}`} style={{ fontWeight: 600 }}>{instOf.get(a.instrumentId) ?? `system ${a.instrumentId}`}</Link></>
                : <span className="mut">on the shelf</span>}
            </span>
            <span className={`pill ${a.status === "Down" ? "bad" : a.status === "Decommissioned" ? "neutral" : "good"}`}
              style={{
              marginLeft: "auto", fontSize: 10,
            }}>{a.status}</span>
          </div>
        ))}
        {mine.length === 0 && <div className="mut" style={{ fontSize: 12 }}>No unit of this model is recorded yet.</div>}
      </div>}
    </div>
  );
}
