import { redirect } from "next/navigation";
import { and, desc, ilike, or, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  instruments, tasks, parts, attachments, discussionPosts, assets, auditLog, vocabTerms,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { readTenant, visibleAssetIds, visibleSystemIds } from "@/lib/tenancy";
import { canSeePost, type Audience } from "@/lib/discussionScope";
import { getSystemLabels } from "@/lib/systemLabel";
import { findOutsideMatches } from "@/lib/serialLookup";
import { MIN_SERIAL_LOOKUP } from "@/lib/serial";
import { alnum, searchTerms } from "@/lib/search";
import SearchBox from "@/components/SearchBox";
import { RequestAccessCard, CreateSystemForm } from "@/components/LookupPanels";
import { DataTable, FacetStrip, PageHead, Toolbar } from "@/components/ui";

export const dynamic = "force-dynamic";

// Work can live on a system or on a standalone asset, so each hit carries its
// own link and a "where it lives" line rather than an id we reinterpret.
type Hit = { id: number; group: string; title: string; sub: string; href: string; where: string };

/**
 * One box over everything: serials, POs, parts, tasks, modules, files, posts,
 * history. An exact serial that belongs to a unit outside the viewer's
 * workspace also surfaces here, as a request-access / claim / listing card -
 * there is one place to type a serial, not two.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; in?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { q: raw, in: inGroup = "" } = await searchParams;
  const q = (raw ?? "").trim();
  const terms = searchTerms(q);
  /**
   * The same rule the client-side lists use (lib/search): EVERY term has to
   * land somewhere on the record, and each one may land in any column. So
   * "trace 1310" finds the system whose ID is one and whose module is the
   * other - which the old single-substring match could not.
   */
  const every = (cols: (AnyColumn | undefined)[]): SQL | undefined => {
    const use = cols.filter(Boolean) as AnyColumn[];
    if (!use.length || !terms.length) return undefined;
    return and(...terms.map((t) => or(...use.map((c) => ilike(c, `%${t}%`)))));
  };
  /**
   * Identifiers, where punctuation is the manufacturer's whim: also compared
   * with every non-alphanumeric removed, so "sil40" finds SIL-40 and
   * "22852708" finds 228-52708-91. Text columns don't get this - nobody
   * searches prose with the spaces taken out, and it would cost a scan.
   */
  const everyIdent = (cols: AnyColumn[], idents: AnyColumn[], extra?: (t: string) => SQL): SQL | undefined => {
    if (!cols.length || !terms.length) return undefined;
    return and(...terms.map((t) => {
      const a = alnum(t);
      return or(
        ...cols.map((c) => ilike(c, `%${t}%`)),
        ...(a.length >= 2
          ? idents.map((c) => ilike(sql`regexp_replace(${c}, '[^A-Za-z0-9]', '', 'g')`, `%${a}%`))
          : []),
        ...(extra ? [extra(t)] : []),
      );
    }));
  };
  /**
   * A term that lands on a module counts as landing on the system it's bolted
   * to. Typing half a serial and getting back the system it belongs to is the
   * whole point - a module found alone is an answer to a different question.
   * Per term, so "thermo 1310" matches a system with a Thermo oven and a 1310
   * detector, exactly as the dashboard's own filter does.
   */
  const onAModule = (t: string): SQL => {
    const a = alnum(t);
    const squash = (c: AnyColumn) => sql`regexp_replace(${c}, '[^A-Za-z0-9]', '', 'g') ILIKE ${`%${a}%`}`;
    return sql`exists (select 1 from ${assets} where ${assets.instrumentId} = ${instruments.id} and (${or(
      ilike(assets.model, `%${t}%`), ilike(assets.serial, `%${t}%`),
      ilike(assets.manufacturer, `%${t}%`), ilike(assets.kind, `%${t}%`),
      ...(a.length >= 2 ? [squash(assets.model), squash(assets.serial)] : []),
    )}))`;
  };

  let hits: Hit[] = [];
  let labels = new Map<number, string>();

  // One search box over everything the viewer is allowed to see - nothing more.
  const [seeSystems, seeAssets] = await Promise.all([visibleSystemIds(user), visibleAssetIds(user)]);
  const inSystems = (col: AnyColumn): SQL | undefined =>
    seeSystems === null ? undefined : seeSystems.length ? inArray(col, seeSystems) : sql`false`;
  const inAssets = (col: AnyColumn): SQL | undefined =>
    seeAssets === null ? undefined : seeAssets.length ? inArray(col, seeAssets) : sql`false`;
  // A work row (task, part, file) belongs to a system, a standalone asset, or
  // both - it's visible if either side is.
  const workScope = (sysCol: AnyColumn, assetCol: AnyColumn): SQL | undefined =>
    seeSystems === null ? undefined : or(inSystems(sysCol), inAssets(assetCol));

  if (q.length >= 2) {
    const [instRows, taskRows, partRows, attachRows, postRows, moduleRows, auditRows] = await Promise.all([
      db.select().from(instruments).where(and(inSystems(instruments.id),
        // By ID, client, notes, location, lead - or by anything bolted to it.
        everyIdent(
          [instruments.externalId, instruments.client, instruments.notes, instruments.location, instruments.lead],
          [instruments.externalId],
          onAModule,
        ))).limit(25),
      db.select().from(tasks).where(and(workScope(tasks.instrumentId, tasks.assetId), every([tasks.title, tasks.body, tasks.assignee]))).limit(25),
      db.select().from(parts).where(and(workScope(parts.instrumentId, parts.assetId), everyIdent(
        [parts.name, parts.partNumber, parts.serial, parts.vendor, parts.note, parts.specs,
          // PO numbers are redacted business data - matching on them would let a
          // non-owner probe values it can't see, so only staff search by PO.
          ...(user.role === "owner" || user.role === "staff" ? [parts.po] : [])],
        [parts.partNumber, parts.serial],
      ))).limit(25),
      db.select().from(attachments).where(and(workScope(attachments.instrumentId, attachments.assetId), every([attachments.fileName, attachments.description]))).limit(25),
      db.select().from(discussionPosts).where(and(inSystems(discussionPosts.instrumentId), every([discussionPosts.body]))).orderBy(desc(discussionPosts.createdAt)).limit(25),
      db.select().from(assets).where(and(inAssets(assets.id), everyIdent(
        [assets.model, assets.serial, assets.note, assets.manufacturer, assets.kind],
        [assets.model, assets.serial],
      ))).limit(25),
      db.select().from(auditLog).where(and(inSystems(auditLog.instrumentId), every([auditLog.action]))).orderBy(desc(auditLog.createdAt)).limit(15),
    ]);

    const ids = new Set<number>([
      ...instRows.map((i) => i.id),
      ...[...taskRows, ...partRows, ...attachRows, ...postRows, ...auditRows]
        .flatMap((r) => (r.instrumentId ? [r.instrumentId] : [])),
      ...moduleRows.flatMap((m) => (m.instrumentId ? [m.instrumentId] : [])),
    ]);
    // Assets referenced by asset-owned work, so those rows can say whose they are.
    const assetIds = new Set<number>([
      ...moduleRows.map((m) => m.id),
      ...[...taskRows, ...partRows, ...attachRows, ...auditRows].flatMap((r) => (r.assetId ? [r.assetId] : [])),
    ]);
    const assetRows = assetIds.size
      ? await db.select({ id: assets.id, kind: assets.kind, model: assets.model, serial: assets.serial })
          .from(assets).where(inArray(assets.id, [...assetIds]))
      : [];
    const assetLabels = new Map(assetRows.map((a) => [a.id, `${a.kind} — ${a.model || a.serial || "(no model)"}`]));
    const named = ids.size
      ? await db.select({ id: instruments.id, externalId: instruments.externalId, model: instruments.model, name: instruments.name })
          .from(instruments).where(and(inArray(instruments.id, [...ids]), inSystems(instruments.id)))
      : [];
    const composed = await getSystemLabels(named);
    labels = new Map(named.map((n) => {
      const label = composed.get(n.id) ?? "";
      return [n.id, label ? `${n.externalId} - ${label}` : n.externalId];
    }));

    const join = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" · ");
    // Where a row of work lives: its system, else the asset that owns it.
    const place = (r: { instrumentId: number | null; assetId?: number | null }) =>
      r.instrumentId
        ? { href: `/instruments/${r.instrumentId}`, where: labels.get(r.instrumentId) ?? "" }
        : r.assetId
          ? { href: `/assets/${r.assetId}`, where: assetLabels.get(r.assetId) ?? "Asset" }
          : { href: "/discussions", where: "General discussion" };
    hits = [
      ...instRows.map((i) => ({ id: i.id, group: "Systems", title: labels.get(i.id) ?? i.externalId, sub: join([i.client, i.location, i.lead && `lead ${i.lead}`]), href: `/instruments/${i.id}`, where: i.client })),
      ...taskRows.map((t) => ({ id: t.id, group: "Tasks", title: t.title, sub: join([t.state, t.assignee, t.body]), ...place(t) })),
      ...partRows.map((p) => ({ id: p.id, group: p.kind === "consumable" ? "Consumables" : "Parts", title: p.name, sub: join([p.partNumber && `PN ${p.partNumber}`, p.serial && `SN ${p.serial}`, p.vendor, p.status]), ...place(p) })),
      ...moduleRows.map((m) => ({ id: m.id, group: "Assets", title: `${m.kind}: ${m.model || "(no model)"}`, sub: join([m.serial && `SN ${m.serial}`, m.status, m.note]), href: `/assets/${m.id}`, where: m.instrumentId ? labels.get(m.instrumentId) ?? "" : "On the shelf" })),
      ...attachRows.map((a) => ({ id: a.id, group: "Files", title: a.fileName, sub: join([a.kind, a.description]), ...place(a) })),
      // Search must never be a side door onto a post: the same audience rules
      // that hide an internal note on its own page hide it here.
      ...postRows
        .filter((p) => canSeePost(
          {
            isHouse: user.role === "owner" || user.role === "staff", orgId: user.orgId,
            houseOrgId: user.role === "owner" || user.role === "staff" ? readTenant(user) : null,
          },
          { ...p, audience: p.audience as Audience },
        ))
        .map((p) => ({ id: p.id, group: "Discussion", title: p.body.slice(0, 120), sub: p.author, ...place({ instrumentId: p.instrumentId }) })),
      ...auditRows.map((a) => ({ id: a.id, group: "History", title: a.action.slice(0, 120), sub: a.actor.split("@")[0], ...place(a) })),
    ];
  }

  const groups = [...new Set(hits.map((h) => h.group))];
  // The cross-workspace half: an exact serial elsewhere on the platform.
  const outside = q.length >= MIN_SERIAL_LOOKUP ? await findOutsideMatches(user, q) : [];
  // Nobody on the platform has this serial: offer to start its record, the way
  // a provider picks up an instrument whose owner isn't here yet.
  const serialUnknown = q.length >= MIN_SERIAL_LOOKUP && hits.length === 0 && outside.length === 0;
  const mayCreate = serialUnknown && user.role !== "client_viewer";
  // Everything strict from the catalog - starting an unknown unit's record is
  // still equipment entry, not a place to invent vocabulary.
  const catalogTerms = mayCreate ? await db.select().from(vocabTerms) : [];
  const kinds = catalogTerms.filter((v) => v.kind === "asset_type").map((v) => v.name);
  const createModels: Record<string, string[]> = {};
  for (const v of catalogTerms) {
    if (v.kind !== "model" || !v.assetType) continue;
    (createModels[v.assetType] ??= []).push(v.name);
  }
  const createCategories = catalogTerms.filter((v) => v.kind === "category").map((v) => v.name);

  const wanted = groups.includes(inGroup) ? inGroup : "";
  const shown = hits.filter((h) => !wanted || h.group === wanted);
  const groupHref = (g: string) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (g && g !== wanted) p.set("in", g);
    return `/search${p.size ? `?${p}` : ""}`;
  };

  return (
    <div className="container page">
      <PageHead title="Search" />
      <Toolbar
        search={<SearchBox initial={q} />}
        facets={groups.length > 1 ? (
          <FacetStrip facets={groups.map((g) => ({
            key: g, label: g,
            count: hits.filter((h) => h.group === g).length,
            on: wanted === g, href: groupHref(g),
          }))} />
        ) : undefined}
      />
      {q.length >= 2 && (
        <div className="mut" style={{ fontSize: 12, margin: "0 0 8px" }}>
          {hits.length} match{hits.length === 1 ? "" : "es"} for &ldquo;{q}&rdquo;
        </div>
      )}

      {shown.length > 0 && (
        <DataTable
          cols={[
            { key: "title", label: "Match", width: "minmax(200px, 2fr)" },
            { key: "where", label: "Where", width: "minmax(140px, 1.4fr)", hideMobile: true },
          ]}
          rows={shown.map((h) => ({
            key: `${h.group}-${h.id}`,
            href: h.href,
            group: h.group,
            cells: {
              title: <span style={{ fontSize: 13 }}>{h.title}</span>,
              where: <span className="mut" style={{ fontSize: 11 }}>{h.where}{h.sub ? ` · ${h.sub}` : ""}</span>,
            },
          }))}
        />
      )}

      {outside.length > 0 && (
        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 2 }}>That serial, in another workspace</div>
          {outside.map((m, i) => (
            <div key={i}>
              {m.listing && (
                <div style={{ border: "1px solid #BFDDBF", background: "#F3FAF3", borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <b style={{ fontSize: 14, color: "var(--navy)" }}>{m.desc}</b>
                    <span className="pill good">For sale</span>
                  </div>
                  {m.listing.note && <div className="mut" style={{ fontSize: 12, marginTop: 2, whiteSpace: "pre-wrap" }}>{m.listing.note}</div>}
                  <a href={`/listing/${m.listing.token}`} target="_blank" rel="noreferrer" className="btn sm accent"
                    style={{ display: "inline-block", marginTop: 8, textDecoration: "none" }}>View listing</a>
                </div>
              )}
              {m.instrumentId !== null && (
                <RequestAccessCard serial={q} assetDesc={m.desc} requested={m.requested}
                  canClaim={user.orgKind !== ""} />
              )}
            </div>
          ))}
        </div>
      )}

      {q.length >= 2 && hits.length === 0 && outside.length === 0 && (
        <div className="card">
          <div className="mut" style={{ fontSize: 13 }}>
            Nothing found.{q.length < MIN_SERIAL_LOOKUP ? " Serial numbers need at least 4 characters." : ""}
          </div>
          {mayCreate && <CreateSystemForm serial={q} kinds={kinds} models={createModels} categories={createCategories} />}
        </div>
      )}
    </div>
  );
}
