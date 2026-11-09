import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { catalogRefs, vocabTerms } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { isStaffRole } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import { navSection } from "@/lib/navData";
import { shopDay } from "@/lib/shopday";
import {
  buildManualTree, findMaker, findModel, findType, makerLine, searchManuals, treeTotals,
  UNSORTED_MAKER, type ManualRef, type ModelShelf,
} from "@/lib/manualsLibrary";
import SectionShell from "@/components/SectionShell";
import ReferencePanel from "@/components/ReferencePanel";
import StatTile from "@/components/charts/StatTile";
import { EmptyState, Grid, HubCard, HubGrid, SectionHead, Stack, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The manuals library: the catalog's reference shelf, browsed as a drive.
 *
 *   Manufacturer  >  Model  >  the manuals filed on it
 *
 * This is the folder tree the shop already keeps on its OneDrive - General >
 * Instrument Manuals > Thermo > Exploris - put in front of the same rows the
 * Reference panel shows on every system. Nothing is filed twice: a manual filed
 * here on the Exploris IS the Exploris reference, and turns up on every
 * Exploris in the fleet; one filed from a system page turns up here. The
 * folders are the catalog's makers and models, so every model is a folder
 * whether or not anything is in it yet - an empty folder is where the next
 * manual goes, and a library that only lists what is already filed cannot be
 * browsed for what is missing.
 *
 * Where you are lives in the URL (?maker=, ?model=, ?type=), so a shelf is a
 * place somebody can be linked to and the back button walks up the tree.
 * Search (?q=) looks through the whole library at once, the way a drive's
 * search does and a folder tree does not.
 */
export default async function ManualsPage(
  { searchParams }: { searchParams: Promise<{ maker?: string; model?: string; type?: string; q?: string }> },
) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  // The reference shelf is staff-curated, and a client's Documents page is the
  // client's own library. Same door the Library hub sends them through.
  if (!isStaffRole(user.role)) redirect("/documents");
  const section = await navSection("library");
  const tenant = readTenant(user);
  const sp = await searchParams;

  const [modelRows, refRows] = await Promise.all([
    db.select({ id: vocabTerms.id, assetType: vocabTerms.assetType, name: vocabTerms.name, manufacturer: vocabTerms.manufacturer })
      .from(vocabTerms)
      .where(and(eq(vocabTerms.kind, "model"), forTenant(vocabTerms.tenantOrgId, tenant)))
      .orderBy(asc(vocabTerms.manufacturer), asc(vocabTerms.name)).catch(() => []),
    db.select().from(catalogRefs)
      .where(forTenant(catalogRefs.tenantOrgId, tenant))
      .orderBy(asc(catalogRefs.assetType), asc(catalogRefs.model), asc(catalogRefs.id)).catch(() => []),
  ]);

  const refs: ManualRef[] = refRows.map((r) => ({
    id: r.id, assetType: r.assetType, model: r.model, kind: r.kind,
    title: r.title, url: r.url, body: r.body, createdBy: r.createdBy,
    provenance: r.provenance, when: shopDay(r.createdAt),
  }));
  const tree = buildManualTree(modelRows, refs);
  const totals = treeTotals(tree);

  const q = (sp.q ?? "").trim().slice(0, 120);
  const atModel = findModel(tree, sp.model);
  const atMaker = atModel ? atModel.maker : findMaker(tree, sp.maker);
  const atType = !atModel && !atMaker ? findType(tree, sp.type) : null;

  const makerHref = (name: string) => `/manuals?maker=${encodeURIComponent(name)}`;
  const modelHref = (m: ModelShelf) => `/manuals?model=${encodeURIComponent(m.key)}`;
  const typeHref = (t: string) => `/manuals?type=${encodeURIComponent(t)}`;
  // The panel wants a filing date on every row; the tree carries it as optional
  // because the pure half has no clock.
  const rows = (rs: ManualRef[]) => rs.map((r) => ({ ...r, when: r.when ?? "" }));
  const inCatalog = <Link href="/settings/catalog" className="btn sm" style={{ textDecoration: "none" }}>Equipment catalog</Link>;

  // The trail: Library › Manuals › Thermo › Exploris. The shell's own crumb
  // stops at the room; inside the room the folder you are standing in is the
  // bold end, and every step up is a door.
  const crumb = (atMaker || atType || q) ? (
    <>
      {section && <><Link href={section.href}>{section.label}</Link> › </>}
      {atMaker || atType || q ? <Link href="/manuals">Manuals</Link> : <b>Manuals</b>}
      {atMaker && (atModel
        ? <> › <Link href={makerHref(atMaker.name)}>{atMaker.name}</Link> › <b>{atModel.model.model}</b></>
        : <> › <b>{atMaker.name}</b></>)}
      {atType && <> › <b>Any {atType.assetType.toLowerCase()}</b></>}
      {q && !atMaker && !atType && <> › <b>Search</b></>}
    </>
  ) : undefined;

  const title = atModel ? atModel.model.model
    : atMaker ? atMaker.name
    : atType ? `Any ${atType.assetType.toLowerCase()}`
    : "Manuals";
  const sub = atModel
    ? `${atMaker!.name === UNSORTED_MAKER ? "" : `${atMaker!.name} · `}${atModel.model.assetType}. Filed here, a manual shows on every ${atModel.model.model} in the fleet.`
    : atMaker
      ? (atMaker.name === UNSORTED_MAKER
        ? "Models nobody has named a manufacturer for, and manuals filed on a model the catalog does not define. Set the maker in the Equipment catalog and they move to its folder."
        : `${makerLine(atMaker)}. Open a model to see what is filed on it, or to file a manual.`)
      : atType
        ? `Filed on the module type rather than one model, so every ${atType.assetType.toLowerCase()} shows it.`
        : "Every manual the shop has filed, by manufacturer and model - the same shelf each system shows for its own equipment.";

  const actions = atModel?.model.termId
    ? <Link href={`/catalog/${atModel.model.termId}`} className="btn sm" style={{ textDecoration: "none" }}>Model page</Link>
    : inCatalog;

  // ── Search: the whole library, flat ────────────────────────────────────────
  const hits = q ? searchManuals(tree, q) : [];

  return (
    <SectionShell section={section} active="/manuals" title={title} sub={sub} crumb={crumb} actions={actions}>
      <Toolbar
        search={
          <form method="get" action="/manuals" role="search">
            <input type="search" name="q" defaultValue={q} aria-label="Search manuals"
              placeholder="Search every manual, model and maker" className="t-small" />
          </form>
        }
        lead={q ? <Link href="/manuals" className="btn sm" style={{ textDecoration: "none" }}>Clear</Link> : undefined}
      />

      {q ? (
        <Stack gap={2}>
          <SectionHead label={`Matching “${q}”`} count={hits.length} />
          {hits.length === 0 && (
            <EmptyState title="Nothing matches" body="Try a maker, a model, or a word from the manual's title." />
          )}
          {hits.length > 0 && (
            <div className="card">
              {hits.map((h) => (
                <div key={h.ref.id} className="row-2" style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                  <span aria-hidden className="t-small">{h.ref.kind === "link" ? "↗" : "✎"}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {h.ref.kind === "link"
                      ? <a href={h.ref.url} target="_blank" rel="noreferrer" className="t-body" style={{ fontWeight: 600 }}>{h.ref.title || h.ref.url}</a>
                      : <span className="t-body" style={{ fontWeight: 600 }}>{h.ref.title || h.ref.body.slice(0, 80)}</span>}
                  </span>
                  <Link className="pill neutral" style={{ textDecoration: "none" }}
                    href={h.modelKey ? `/manuals?model=${encodeURIComponent(h.modelKey)}` : typeHref(h.assetType)}>
                    {h.where}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </Stack>
      ) : atModel ? (
        // ── A model's folder: its manuals, and the type-wide ones that also
        //    apply - the same two groups the model's own page shows ───────────
        <ReferencePanel canEdit
          sub={`Manuals, links and field notes for ${atModel.model.model}${atMaker!.name === UNSORTED_MAKER ? "" : ` by ${atMaker!.name}`} - and for any ${atModel.model.assetType.toLowerCase()}. Upload one, point at a file already in Documents, or link the maker's site.`}
          scopes={[
            { assetType: atModel.model.assetType, model: atModel.model.model, label: `${atModel.model.model} (every unit)` },
            { assetType: atModel.model.assetType, model: "", label: `any ${atModel.model.assetType.toLowerCase()}` },
          ]}
          refs={rows([...atModel.model.refs, ...(findType(tree, atModel.model.assetType)?.refs ?? [])])}
        />
      ) : atType ? (
        <ReferencePanel canEdit
          sub={`Filed on every ${atType.assetType.toLowerCase()} at once. For one model, open its folder instead.`}
          scopes={[{ assetType: atType.assetType, model: "", label: `any ${atType.assetType.toLowerCase()}` }]}
          refs={rows(atType.refs)}
        />
      ) : atMaker ? (
        // ── A maker's folder: its models ─────────────────────────────────────
        <Stack gap={3}>
          <SectionHead label="Models" count={atMaker.models.length} />
          <HubGrid>
            {atMaker.models.map((m) => (
              <HubCard key={m.key} href={modelHref(m)} title={m.model}
                sub={m.termId === null ? `${m.assetType} · not in the catalog` : m.assetType}
                signal={m.refs.length ? `${m.refs.length} manual${m.refs.length === 1 ? "" : "s"}` : undefined}
                tone={m.refs.length ? "info" : undefined} />
            ))}
          </HubGrid>
        </Stack>
      ) : (
        // ── The top: manufacturers ───────────────────────────────────────────
        <Stack gap={4}>
          <Grid cols={3} gap={3}>
            <StatTile label="Manufacturers" value={String(totals.makers)} />
            <StatTile label="Models" value={String(totals.models)} sub="every one is a folder" />
            <StatTile label="Manuals filed" value={String(totals.manuals)}
              tone={totals.models > 0 && totals.manuals === 0 ? "warn" : undefined} />
          </Grid>

          {tree.makers.length === 0 && (
            <EmptyState title="No models in the catalog yet"
              body="The folders here are the catalog's manufacturers and models. Define a model and its maker, and its folder appears."
              action={inCatalog} />
          )}

          {tree.makers.length > 0 && (
            <Stack gap={2}>
              <SectionHead label="Manufacturers" count={totals.makers} />
              <HubGrid>
                {tree.makers.map((mk) => (
                  <HubCard key={mk.name} href={makerHref(mk.name)} title={mk.name}
                    sub={mk.name === UNSORTED_MAKER
                      ? "No maker set - fix it in the Equipment catalog"
                      : `${mk.models.length} model${mk.models.length === 1 ? "" : "s"}`}
                    signal={mk.refCount ? `${mk.refCount} manual${mk.refCount === 1 ? "" : "s"}` : undefined}
                    tone={mk.name === UNSORTED_MAKER ? "warn" : mk.refCount ? "info" : undefined} />
                ))}
              </HubGrid>
            </Stack>
          )}

          {tree.types.length > 0 && (
            <Stack gap={2}>
              <SectionHead label="Filed on a module type" count={tree.types.length} />
              <div className="mut t-small">
                Not one model&apos;s - a venting procedure every mass spec shares, say. Each shows on every model of its type as well.
              </div>
              <HubGrid>
                {tree.types.map((t) => (
                  <HubCard key={t.assetType} href={typeHref(t.assetType)} title={`Any ${t.assetType.toLowerCase()}`}
                    signal={`${t.refs.length} manual${t.refs.length === 1 ? "" : "s"}`} tone="neutral" />
                ))}
              </HubGrid>
            </Stack>
          )}
        </Stack>
      )}
    </SectionShell>
  );
}
