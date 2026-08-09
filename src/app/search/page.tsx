import { redirect } from "next/navigation";
import Link from "next/link";
import { and, desc, ilike, or, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  instruments, tasks, parts, attachments, discussionPosts, assets, auditLog,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { visibleAssetIds, visibleSystemIds } from "@/lib/tenancy";
import { getSystemLabels } from "@/lib/systemLabel";
import { findOutsideMatches } from "@/lib/serialLookup";
import { MIN_SERIAL_LOOKUP } from "@/lib/serial";
import { MODULE_KINDS } from "@/lib/stages";
import SearchBox from "@/components/SearchBox";
import { RequestAccessCard, CreateSystemForm } from "@/components/LookupPanels";

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
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { q: raw } = await searchParams;
  const q = (raw ?? "").trim();
  const like = `%${q}%`;

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
      db.select().from(instruments).where(and(inSystems(instruments.id), or(
        // Asset models/serials are searched through the assets table below;
        // the system itself is found by ID, client, notes, location or lead.
        ilike(instruments.externalId, like), ilike(instruments.client, like),
        ilike(instruments.notes, like), ilike(instruments.location, like), ilike(instruments.lead, like),
      ))).limit(25),
      db.select().from(tasks).where(and(workScope(tasks.instrumentId, tasks.assetId), or(ilike(tasks.title, like), ilike(tasks.body, like), ilike(tasks.assignee, like)))).limit(25),
      db.select().from(parts).where(and(workScope(parts.instrumentId, parts.assetId), or(
        ilike(parts.name, like), ilike(parts.partNumber, like), ilike(parts.serial, like),
        ilike(parts.vendor, like), ilike(parts.note, like), ilike(parts.specs, like),
        // PO numbers are redacted business data - matching on them would let a
        // non-owner probe values it can't see, so only staff search by PO.
        user.role === "owner" || user.role === "staff" ? ilike(parts.po, like) : undefined,
      ))).limit(25),
      db.select().from(attachments).where(and(workScope(attachments.instrumentId, attachments.assetId), or(ilike(attachments.fileName, like), ilike(attachments.description, like)))).limit(25),
      db.select().from(discussionPosts).where(and(inSystems(discussionPosts.instrumentId), ilike(discussionPosts.body, like))).orderBy(desc(discussionPosts.createdAt)).limit(25),
      db.select().from(assets).where(and(inAssets(assets.id), or(
        ilike(assets.model, like), ilike(assets.serial, like), ilike(assets.note, like), ilike(assets.manufacturer, like),
      ))).limit(25),
      db.select().from(auditLog).where(and(inSystems(auditLog.instrumentId), ilike(auditLog.action, like))).orderBy(desc(auditLog.createdAt)).limit(15),
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
      ? await db.select({ id: instruments.id, externalId: instruments.externalId, model: instruments.model })
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
      ...postRows.map((p) => ({ id: p.id, group: "Discussion", title: p.body.slice(0, 120), sub: p.author, ...place({ instrumentId: p.instrumentId }) })),
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
  const kinds = mayCreate
    ? [...new Set([...MODULE_KINDS, ...(await db.selectDistinct({ kind: assets.kind }).from(assets)).map((k) => k.kind)].filter(Boolean))]
    : [];

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Search</div>
        <SearchBox initial={q} />
        {q.length >= 2 && (
          <div className="mut" style={{ fontSize: 12, marginTop: 8 }}>
            {hits.length} match{hits.length === 1 ? "" : "es"} for &ldquo;{q}&rdquo;
          </div>
        )}
      </div>

      {groups.map((g) => (
        <div key={g} className="card">
          <div className="eyebrow" style={{ marginBottom: 6 }}>{g}</div>
          {hits.filter((h) => h.group === g).map((h) => (
            <Link key={`${g}-${h.id}`} href={h.href} className="row-hover"
              style={{ display: "block", padding: "7px 4px", borderTop: "1px solid var(--line)", textDecoration: "none", color: "inherit" }}>
              <div style={{ fontSize: 13 }}>{h.title}</div>
              <div className="mut" style={{ fontSize: 11 }}>
                {h.where}{h.sub ? ` · ${h.sub}` : ""}
              </div>
            </Link>
          ))}
        </div>
      ))}

      {outside.length > 0 && (
        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 2 }}>That serial, in another workspace</div>
          {outside.map((m, i) => (
            <div key={i}>
              {m.listing && (
                <div style={{ border: "1px solid #BFDDBF", background: "#F3FAF3", borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <b style={{ fontSize: 14, color: "var(--navy)" }}>{m.desc}</b>
                    <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>For sale</span>
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
          {mayCreate && <CreateSystemForm serial={q} kinds={kinds} />}
        </div>
      )}
    </div>
  );
}
